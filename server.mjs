// transcribe.santisiordia.com: free audio transcription with a local Whisper model.
// Zero dependencies. What is kept, in full:
//   - uploaded audio: a temp file, deleted the moment its job ends (see transcribe()) and on every start
//   - transcripts: in memory only, dropped RESULT_TTL after the job ends (see the sweep at the bottom)
//   - data/donors.json: sha256(donor email) -> API key. No plain emails, no IPs, no request logs.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT ?? 3015);
const ORIGIN = env.ORIGIN || 'https://transcribe.santisiordia.com';
const REPO = env.REPO_URL || 'https://github.com/SantiagoSiordia/transcribe';
const COFFEE = env.COFFEE_URL || 'https://buymeacoffee.com/santisiordia';
const FFMPEG = env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg';
const WHISPER = env.WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
const MODEL = env.WHISPER_MODEL || path.join(os.homedir(), 'Library/Application Support/transcribe/ggml-large-v3-turbo.bin');
const DONORS = env.DONORS_FILE || path.join(DIR, 'data/donors.json');
const TMP = env.TMP_DIR || path.join(os.tmpdir(), 'transcribe-uploads');

const MAX_BYTES = 100 * 1024 * 1024;   // Cloudflare's free-plan upload ceiling
const MAX_SECONDS = 3 * 3600;
const MAX_QUEUE = 20;                  // waiting + uploading; bounds temp disk to ~2 GB
const RESULT_TTL = 3600e3;
const PER_HOUR = { free: 3, donor: 30 };
const LANGS = ['auto', 'en', 'es'];
// Only real audio/video containers, only local files: a playlist-style upload cannot make ffmpeg read other paths or URLs.
const FORMATS = 'mp3,wav,ogg,flac,aac,amr,aiff,caf,asf,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2';

// ---- rate limiting (sliding window, memory only) ----------------------------
export function limiter(max, windowMs = 3600e3) {
  const hits = new Map();
  const take = (key, now = Date.now()) => {
    const h = (hits.get(key) || []).filter(t => now - t < windowMs);
    const ok = h.length < max;
    if (ok) h.push(now);
    hits.set(key, h);
    return { ok, limit: max, remaining: max - h.length, retryAfter: ok ? 0 : Math.ceil((h[0] + windowMs - now) / 1000) };
  };
  take.sweep = (now = Date.now()) => { for (const [k, h] of hits) if (!h.some(t => now - t < windowMs)) hits.delete(k); };
  return take;
}
// ponytail: per exact IP. An IPv6 user can rotate inside their /64; key on the /64 prefix if that gets abused.
const limits = { free: limiter(PER_HOUR.free), donor: limiter(PER_HOUR.donor), claim: limiter(10) };

// ---- donors: sha256(email) -> key -------------------------------------------
const emailHash = e => crypto.createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex');
const loadDonors = () => (fs.existsSync(DONORS) ? JSON.parse(fs.readFileSync(DONORS, 'utf8')) : {});
function saveDonors(d) {
  fs.mkdirSync(path.dirname(DONORS), { recursive: true });
  fs.writeFileSync(DONORS + '.tmp', JSON.stringify(d, null, 1));   // write-then-rename: never a truncated file
  fs.renameSync(DONORS + '.tmp', DONORS);
}
export function grant(email) {
  const d = loadDonors(), h = emailHash(email);
  if (!d[h]) { d[h] = 'tr_' + crypto.randomBytes(24).toString('hex'); saveDonors(d); }
  return d[h];
}
export function revoke(email) { const d = loadDonors(); delete d[emailHash(email)]; saveDonors(d); }
export const claim = email => loadDonors()[emailHash(email)] || null;
const isDonorKey = key => Object.values(loadDonors()).includes(key);

// Buy Me a Coffee signs the raw body with HMAC-SHA256 (x-signature-sha256). Hex and base64 both accepted.
export function verifySig(raw, sig, secret) {
  if (!secret || !sig) return false;
  const mac = crypto.createHmac('sha256', secret).update(raw).digest();
  return [mac.toString('hex'), mac.toString('base64')].some(m =>
    m.length === sig.length && crypto.timingSafeEqual(Buffer.from(m), Buffer.from(sig)));
}

// ---- queue: one job at a time, donors ahead of free jobs --------------------
// ponytail: in memory, single worker. A restart drops waiting jobs; add a second worker if the line gets long.
const jobs = new Map();
const queue = [];
let running = null, uploading = 0;
export function enqueue(q, job) {
  q.splice(job.donor ? q.findLastIndex(j => j.donor) + 1 : q.length, 0, job);
}
const run = (cmd, args, timeout) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout });
  let err = '';
  p.stderr.on('data', d => { err = (err + d).slice(-1500); });
  p.on('error', reject);
  p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
});
async function transcribe(job) {
  const wav = job.file + '.wav', out = job.file + '.out';
  try {
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', FORMATS,
      '-i', job.file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-t', String(MAX_SECONDS + 1), '-f', 'wav', '-y', wav], 10 * 60e3)
      .catch(e => { console.error('ffmpeg:', e.message); throw new Error('could not read this file as audio'); });
    const seconds = (fs.statSync(wav).size - 44) / 32000;   // 16 kHz, mono, 16-bit
    if (seconds > MAX_SECONDS) throw new Error('audio is longer than 3 hours');
    if (seconds < 0.2) throw new Error('the file has no audio');
    await run(WHISPER, ['-m', MODEL, '-f', wav, '-l', job.language, '-oj', '-of', out, '-np', '-t', '8'], 90 * 60e3)
      .catch(e => { console.error('whisper:', e.message); throw new Error('transcription failed'); });
    const j = JSON.parse(fs.readFileSync(out + '.json', 'utf8'));
    const segments = j.transcription
      .map(s => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text.trim() }))
      .filter(s => s.text);
    return { language: j.result?.language || job.language, duration: Math.round(seconds), segments, text: segments.map(s => s.text).join('\n') };
  } finally {
    for (const f of [job.file, wav, out + '.json']) fs.rmSync(f, { force: true });   // the audio never outlives its job
  }
}
async function pump() {
  if (running || !queue.length) return;
  const job = running = queue.shift();
  job.status = 'processing';
  try { job.result = await transcribe(job); job.status = 'done'; }
  catch (e) { job.status = 'error'; job.error = e.message; }
  job.finished = Date.now();
  console.log(`job ${job.status} ${job.result?.duration ?? 0}s ${job.donor ? 'donor' : 'free'}`);   // counts only, nothing personal
  running = null;
  pump();
}

// ---- pages: index.html filled from pages.json, once, at start ---------------
const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const json = v => JSON.stringify(v).replace(/</g, '\\u003c');
export function buildPages() {
  const tpl = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const { strings, pages } = JSON.parse(fs.readFileSync(path.join(DIR, 'pages.json'), 'utf8'));
  const out = new Map();
  for (const p of pages) {
    const url = ORIGIN + (p.path === '/' ? '/' : p.path), alt = pages.find(x => x.path === p.alt);
    const hreflang = alt ? [p, alt].map(x => `<link rel="alternate" hreflang="${x.lang}" href="${ORIGIN}${x.path}">`).join('\n')
      + `\n<link rel="alternate" hreflang="x-default" href="${ORIGIN}${p.lang === 'en' ? p.path : alt.path}">` : '';
    const content = (p.sections || []).map(s => `<section class="card prose"><h2>${s.h}</h2>${s.p.map(t => `<p>${t}</p>`).join('')}</section>`).join('\n')
      + (p.faq ? `\n<section class="card prose"><h2>${strings[p.lang].faqTitle}</h2>${p.faq.map(f => `<h3>${f.q}</h3><p>${f.a}</p>`).join('')}</section>` : '');
    const ld = [{ '@context': 'https://schema.org', '@type': 'WebApplication', name: 'Transcribe', url, description: p.description,
      inLanguage: p.lang, applicationCategory: 'MultimediaApplication', operatingSystem: 'Any', isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } }];
    if (p.faq) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: p.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<[^>]+>/g, '') } })) });
    const nav = pages.filter(x => x.lang === p.lang && x.path !== p.path).map(x => `<a href="${x.path}">${x.nav}</a>`).join('');
    out.set(p.path, fill(tpl, { ...strings[p.lang], lang: p.lang, title: esc(p.title), description: esc(p.description), h1: p.h1, sub: p.sub,
      canonical: url, hreflang, content, nav, jsonld: json(ld), T: json(strings[p.lang]), origin: ORIGIN, repo: REPO, coffee: COFFEE,
      home: p.lang === 'en' ? '/' : '/es', altPath: alt?.path || (p.lang === 'en' ? '/es' : '/'), altLang: p.lang === 'en' ? 'es' : 'en' }));
  }
  return out;
}
const DOCS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcribe API docs: free audio transcription API</title>
<meta name="description" content="Free REST API for audio transcription with Whisper. No API key needed: 3 files per hour, up to 3 hours each.">
<link rel="canonical" href="${ORIGIN}/docs"><link rel="icon" href="/public/favicon.svg"><link rel="stylesheet" href="/public/swagger-ui.css"></head>
<body><div id="ui"></div><script src="/public/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#ui', deepLinking: true })</script></body></html>`;
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// ---- http -------------------------------------------------------------------
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";
const send = (res, code, body, type = 'application/json', extra = {}) => {
  const text = /^(text|application\/(json|xml))/.test(type);
  res.writeHead(code, { 'Content-Type': type + (text ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP, ...extra });
  res.end(type === 'application/json' && typeof body !== 'string' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
};
const readBody = (req, max = 65536) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
// Bound to 127.0.0.1 behind the Cloudflare tunnel, so this header comes from Cloudflare, not the client.
const ip = req => req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
const view = j => ({ id: j.id, status: j.status,
  ...(j.status === 'queued' && { position: queue.indexOf(j) + (running ? 1 : 0) }),
  ...(j.status === 'error' && { error: j.error }), ...j.result });

export function createServer() {
  fs.rmSync(TMP, { recursive: true, force: true });   // audio left behind by a crash goes now
  fs.mkdirSync(TMP, { recursive: true });
  const pages = buildPages();
  const cached = { 'Cache-Control': 'public, max-age=300' };
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + [...pages.keys(), '/docs'].map(p => `<url><loc>${ORIGIN}${p}</loc></url>`).join('\n') + '\n</urlset>\n';

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/(.)\/$/, '$1');
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pages.has(p)) return send(res, 200, pages.get(p), 'text/html', cached);
        if (p === '/docs') return send(res, 200, DOCS, 'text/html', cached);
        if (p === '/openapi.json') return send(res, 200, fs.readFileSync(path.join(DIR, 'openapi.json')), 'application/json', cached);
        if (p === '/robots.txt') return send(res, 200, `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${ORIGIN}/sitemap.xml\n`, 'text/plain', cached);
        if (p === '/sitemap.xml') return send(res, 200, sitemap, 'application/xml', cached);
        const asset = /^\/public\/([\w.-]+)$/.exec(p);   // flat folder, no slashes: nothing to traverse
        const file = asset && path.join(DIR, 'public', asset[1]);
        if (file && MIME[path.extname(file)] && fs.existsSync(file))
          return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)], { 'Cache-Control': 'public, max-age=86400' });
      }

      if (req.method === 'POST' && p === '/api/transcribe') {
        const language = url.searchParams.get('language') || 'auto';
        if (!LANGS.includes(language)) return send(res, 400, { error: `language must be one of ${LANGS.join(', ')}` });
        const key = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
        if (key && !isDonorKey(key)) return send(res, 401, { error: 'unknown API key' });
        if (Number(req.headers['content-length']) > MAX_BYTES) return send(res, 413, { error: 'file is larger than 100 MB' });
        if (queue.length + uploading >= MAX_QUEUE) return send(res, 503, { error: 'the queue is full, try again in a few minutes' }, 'application/json', { 'Retry-After': '120' });
        const lim = key ? limits.donor(key) : limits.free(ip(req));
        const rate = { 'X-RateLimit-Limit': lim.limit, 'X-RateLimit-Remaining': lim.remaining };
        if (!lim.ok) return send(res, 429, { error: `limit of ${lim.limit} transcriptions per hour reached`, retryAfter: lim.retryAfter },
          'application/json', { ...rate, 'Retry-After': lim.retryAfter });
        const job = { id: crypto.randomUUID(), status: 'queued', language, donor: !!key };
        job.file = path.join(TMP, job.id);
        let n = 0;
        uploading++;
        try {
          await pipeline(req, async function* (src) {
            for await (const c of src) { n += c.length; if (n > MAX_BYTES) throw new Error('file is larger than 100 MB'); yield c; }
          }, fs.createWriteStream(job.file));
          if (!n) throw new Error('send the audio file as the request body');
        } catch (e) {
          fs.rmSync(job.file, { force: true });
          return send(res, n > MAX_BYTES ? 413 : 400, { error: e.message }, 'application/json', rate);
        } finally { uploading--; }
        jobs.set(job.id, job);
        enqueue(queue, job);
        const body = view(job);
        pump();
        return send(res, 202, body, 'application/json', rate);
      }

      const one = /^\/api\/jobs\/([\w-]+)$/.exec(p);
      if (one && req.method === 'GET') {
        const j = jobs.get(one[1]);
        return j ? send(res, 200, view(j)) : send(res, 404, { error: 'no such job (results are dropped one hour after they finish)' });
      }
      if (one && req.method === 'DELETE') {
        const j = jobs.get(one[1]);
        if (!j) return send(res, 404, { error: 'no such job' });
        jobs.delete(j.id);
        const i = queue.indexOf(j);
        if (i >= 0) { queue.splice(i, 1); fs.rmSync(j.file, { force: true }); }
        return send(res, 200, { ok: true });   // a job already running finishes, then its result is discarded
      }

      if (req.method === 'POST' && p === '/api/claim') {
        const lim = limits.claim(ip(req));
        if (!lim.ok) return send(res, 429, { error: 'too many attempts, try again later', retryAfter: lim.retryAfter });
        const { email } = JSON.parse(await readBody(req) || '{}');
        if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return send(res, 400, { error: 'enter a valid email' });
        const key = claim(email);
        return key ? send(res, 200, { key, perHour: PER_HOUR.donor }) : send(res, 404, { error: 'no donation found for that email yet' });
      }

      if (req.method === 'POST' && p === '/api/bmc-webhook') {
        const raw = await readBody(req, 262144);
        if (!verifySig(raw, req.headers['x-signature-sha256'], env.BMC_WEBHOOK_SECRET)) return send(res, 401, { error: 'bad signature' });
        const ev = JSON.parse(raw);
        const email = ev.data?.supporter_email;
        if (typeof email === 'string' && email.includes('@')) /refund/i.test(ev.type || '') ? revoke(email) : grant(email);
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, j] of jobs) if (j.finished && now - j.finished > RESULT_TTL) jobs.delete(id);
    for (const l of Object.values(limits)) l.sweep(now);
  }, 60e3).unref();
  // Always 127.0.0.1, never *:port. The Cloudflare tunnel is the only way in.
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => console.log(`transcribe on http://127.0.0.1:${server.address().port}`));
}
