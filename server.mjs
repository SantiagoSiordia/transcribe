// transcribe.santisiordia.com: free audio transcription with a local Whisper model.
// Zero dependencies. What is kept, in full:
//   - uploaded audio: a temp file, deleted the moment its job ends (see transcribe()) and on every start;
//     an upload that is never started is deleted after 10 minutes (HOLD_TTL)
//   - transcripts: in memory only, dropped RESULT_TTL after the job ends (see the sweep at the bottom)
//   - readable paragraphs (optional, ?polish=1): made by a second local model through Ollama on 127.0.0.1, same lifetime as the transcript
//   - data/stats.json: totals per day (users, jobs, audio minutes). Counts only; see count() for how users are counted without IPs
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
const OLLAMA = env.OLLAMA_URL || 'http://127.0.0.1:11434';   // local only: transcript text never leaves this machine
const POLISH_MODEL = env.POLISH_MODEL ?? 'gemma3:4b';          // set to an empty string to switch the cleanup pass off
const TMP = env.TMP_DIR || path.join(os.tmpdir(), 'transcribe-uploads');

const MAX_BYTES = 100 * 1024 * 1024;   // Cloudflare's free-plan upload ceiling
const MAX_SECONDS = 3 * 3600;
const MAX_QUEUE = 20;                  // waiting + uploading; bounds temp disk to ~2 GB
const RESULT_TTL = 3600e3;
const HOLD_TTL = 600e3;                // an upload nobody started is deleted after 10 minutes
const PER_HOUR = { free: 3, donor: 30 };
const LANGS = ['auto', 'en', 'es'];
// Only real audio/video containers, only local files: a playlist-style upload cannot make ffmpeg read other paths or URLs.
const FORMATS = 'mp3,wav,ogg,flac,aac,amr,aiff,caf,asf,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2';

// ---- rate limiting (sliding window, memory only) ----------------------------
export function limiter(max, windowMs = 3600e3) {
  const hits = new Map();
  const check = (key, now, spend) => {
    const h = (hits.get(key) || []).filter(t => now - t < windowMs);
    const ok = h.length < max;
    if (ok && spend) h.push(now);
    hits.set(key, h);
    return { ok, limit: max, remaining: max - h.length, retryAfter: ok ? 0 : Math.ceil((h[0] + windowMs - now) / 1000) };
  };
  const take = (key, now = Date.now()) => check(key, now, true);
  take.peek = (key, now = Date.now()) => check(key, now, false);   // would it be allowed? Spends nothing.
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

// ---- usage: daily totals so the owner can see how much the service is used -------
// "users" counts distinct callers per UTC day. To count them without keeping who they are, each caller is hashed with a
// random salt that lives only in memory and is replaced every day; the hashes are never written anywhere.
// ponytail: a restart forgets today's hashes, so someone active before and after a restart is counted twice that day.
const STATS = env.STATS_FILE || path.join(DIR, 'data/stats.json');
const stats = fs.existsSync(STATS) ? JSON.parse(fs.readFileSync(STATS, 'utf8')) : {};
let seen = new Set(), seenDay = '', salt;
export function count(what, n = 1, who, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (day !== seenDay) { seenDay = day; seen = new Set(); salt = crypto.randomBytes(16); }
  const d = stats[day] ??= { users: 0, jobs: 0, done: 0, failed: 0, minutes: 0, donorJobs: 0 };
  d[what] = Math.round((d[what] + n) * 10) / 10;
  if (who) { const h = crypto.createHash('sha256').update(salt).update(who).digest('hex'); if (!seen.has(h)) { seen.add(h); d.users++; } }
  fs.mkdirSync(path.dirname(STATS), { recursive: true });
  fs.writeFileSync(STATS + '.tmp', JSON.stringify(stats, null, 1));
  fs.renameSync(STATS + '.tmp', STATS);
  return d;
}

// ---- queue: one job at a time, donors ahead of free jobs --------------------
// ponytail: in memory, single worker. A restart drops waiting jobs; add a second worker if the line gets long.
const jobs = new Map();
const queue = [];
let running = null, uploading = 0;
export function enqueue(q, job) {
  q.splice(job.donor ? q.findLastIndex(j => j.donor) + 1 : q.length, 0, job);
}
const run = (cmd, args, timeout, onStderr, job) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout });
  if (job) job.proc = p;   // so a cancelled job can be stopped mid-run
  let err = '';
  p.stderr.on('data', d => { err = (err + d).slice(-1500); onStderr?.(String(d)); });
  p.on('error', reject);
  p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
});
// Time left, in seconds. Before whisper has reported much, guess from the audio length and the measured speed;
// after that, trust the real pace of this job.
const LOAD = 3;      // seconds to load the model
let rate = 0.04;     // processing seconds per second of audio; a starting guess that is corrected after each job
export function eta(job, now = Date.now()) {
  if (job.started == null) return undefined;
  const elapsed = (now - job.started) / 1000;
  const left = job.progress >= 0.2 ? elapsed * (1 - job.progress) / job.progress : LOAD + job.seconds * rate - elapsed;
  return Math.max(1, Math.round(left));
}
// Extra whisper.cpp flags, off by default. '-bs 1 -bo 1 -mc 0' looked 1.6x faster on one test file but skipped
// 16% of the words on a mixed English/Spanish recording, so do not turn it on without checking word counts.
const FAST = (env.WHISPER_ARGS ?? '').split(' ').filter(Boolean);
async function transcribe(job) {
  const wav = job.file + '.wav', out = job.file + '.out';
  try {
    if (!jobs.has(job.id)) throw new Error('cancelled');
    await run(FFMPEG, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', FORMATS,
      '-i', job.file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-t', String(MAX_SECONDS + 1), '-f', 'wav', '-y', wav], 10 * 60e3, null, job)
      .catch(e => { console.error('ffmpeg:', e.message); throw new Error('could not read this file as audio'); });
    const seconds = (fs.statSync(wav).size - 44) / 32000;   // 16 kHz, mono, 16-bit
    if (seconds > MAX_SECONDS) throw new Error('audio is longer than 3 hours');
    if (seconds < 0.2) throw new Error('the file has no audio');
    if (!jobs.has(job.id)) throw new Error('cancelled');   // cancelled during conversion
    Object.assign(job, { seconds, started: Date.now(), progress: 0 });
    await run(WHISPER, ['-m', MODEL, '-f', wav, '-l', job.language, '-oj', '-of', out, '-np', '-pp', '-t', '8', ...FAST], 90 * 60e3,
      s => { for (const m of s.matchAll(/progress =\s*(\d+)%/g)) job.progress = Math.min(Number(m[1]) / 100, 0.99); }, job)
      .catch(e => { console.error('whisper:', e.message); throw new Error('transcription failed'); });
    // learn this machine's speed from every finished job, so the first estimate of the next one is close
    rate = 0.7 * rate + 0.3 * Math.max((Date.now() - job.started) / 1000 - LOAD, 0.1) / seconds;
    const j = JSON.parse(fs.readFileSync(out + '.json', 'utf8'));
    const segments = j.transcription
      .map(s => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text.trim() }))
      .filter(s => s.text);
    return { language: j.result?.language || job.language, duration: Math.round(seconds), segments, text: segments.map(s => s.text).join('\n') };
  } finally {
    for (const f of [job.file, wav, out + '.json']) fs.rmSync(f, { force: true });   // the audio never outlives its job
  }
}
// ---- readable paragraphs: a local LLM fixes punctuation, case and paragraph breaks, and nothing else ----
const POLISH_PROMPT = `You fix the punctuation, capitalization and paragraph breaks of a speech transcript so it reads naturally.
Rules:
- Keep every word exactly as it is, in the same order. Do not add, remove, translate, correct or replace any word.
- You may only change: punctuation marks, upper/lower case, and where paragraphs break (use a blank line).
- Keep the language of the transcript.
- Output only the transcript text, nothing else.`;
// The guarantee: identical once case, punctuation and spacing are ignored. A model that changes a word is not trusted.
export const sameWords = (a, b) => { const n = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); return n(a) === n(b); };
export function chunks(segments, max = 1200) {
  const out = []; let cur = '';
  for (const s of segments) {
    if (cur && cur.length + s.text.length > max) { out.push(cur); cur = ''; }
    cur += (cur ? ' ' : '') + s.text;
  }
  if (cur) out.push(cur);
  return out;
}
// Chunks are cut at arbitrary points, so a paragraph left open at the end of one continues into the next.
export function joinParas(parts) {
  const out = [];
  for (const ps of parts) ps.forEach((p, i) => {
    if (i === 0 && out.length && !/[.?!…"”»)]$/.test(out.at(-1))) out[out.length - 1] += ' ' + p; else out.push(p);
  });
  return out;
}
// Models rarely break paragraphs on their own, so long ones are split at sentence ends into readable blocks.
export function reflow(paras, target = 450) {
  return paras.flatMap(p => {
    const out = []; let cur = '';
    for (const s of p.split(/(?<=[.?!…])\s+/)) {
      if (cur && cur.length + s.length > target) { out.push(cur); cur = ''; }
      cur += (cur ? ' ' : '') + s;
    }
    return cur ? [...out, cur] : out;
  });
}
let polishing = Promise.resolve();   // one cleanup at a time, alongside the transcription worker
// One stretch of text through the model. Returns its paragraphs, or null if it changed any word.
async function ask(system, user) {
  const r = await fetch(OLLAMA + '/api/chat', { method: 'POST', signal: AbortSignal.timeout(180e3), body: JSON.stringify({
    model: POLISH_MODEL, stream: false, keep_alive: '10m', options: { temperature: 0, num_ctx: 8192 },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  if (!r.ok) throw new Error('ollama answered ' + r.status);
  return (await r.json()).message.content.trim();
}
// One stretch of text through the model. Returns its paragraphs, or null if it changed any word.
async function tidy(raw) {
  const letters = raw.replace(/[^\p{L}]/gu, '');
  const shouting = letters && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length > 0.8;   // ALL CAPS in: models keep it, so hand it over lowercased
  const out = await ask(POLISH_PROMPT, shouting ? raw.toLowerCase() : raw);
  return sameWords(out, raw) ? out.split(/\n\s*\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean) : null;
}
// A summary is new text written by the model, so unlike the paragraphs it cannot be checked word for word. The page says so.
const SUMMARY_PROMPT = `You summarize a speech transcript (or notes taken from one).
Write in the same language as the transcript. Use only what is said in it; do not add facts or opinions.
Format: two or three plain sentences, then a blank line, then 3 to 6 short key points, each on its own line starting with "- ".
No headings, no bold, no preamble. Output only the summary.`;
const NOTES_PROMPT = `List the key points of this part of a speech transcript as short lines starting with "- ", in the same language as the transcript. Use only what is said. Output only the list.`;
async function summarize(job) {
  const cs = chunks(job.result.segments, 8000);
  if (cs.length === 1) return ask(SUMMARY_PROMPT, cs[0]);
  const notes = [];   // long recording: notes per part, then one summary of the notes
  for (const c of cs) { if (!jobs.has(job.id)) return undefined; notes.push(await ask(NOTES_PROMPT, c)); }
  return ask(SUMMARY_PROMPT, notes.join('\n'));
}
async function polish(job) {
  const p = job.polish, t0 = Date.now();
  let kept = 0, total = 0;
  p.status = 'running';
  try {
    const cs = p.paras ? chunks(job.result.segments) : [], parts = [];
    for (const [i, raw] of cs.entries()) {
      if (!jobs.has(job.id)) return;   // deleted or cancelled meanwhile
      let ps = await tidy(raw);
      total += raw.length;
      if (ps) kept += raw.length;
      else {   // a word changed somewhere: try the two halves on their own, and keep Whisper's text for whichever still fails
        const cut = raw.indexOf(' ', raw.length >> 1);
        ps = [];
        for (const half of cut < 0 ? [raw] : [raw.slice(0, cut), raw.slice(cut + 1)]) {
          const h = cut < 0 ? null : await tidy(half);
          if (h) kept += half.length;
          ps = joinParas([ps, h || [half]]);
        }
      }
      parts.push(ps);
      p.progress = (i + 1) / cs.length;
    }
    if (p.paras) p.paragraphs = reflow(joinParas(parts));   // available to the page right away, while the summary is written
    if (p.summary && jobs.has(job.id)) p.summaryText = await summarize(job);
    p.status = 'done';
    console.log(`polish done ${Math.round((Date.now() - t0) / 1000)}s` + (total ? `, model text kept for ${Math.round(100 * kept / total)}%` : ''));
  } catch (e) { console.error('polish:', e.message); p.status = 'failed'; }
}
async function pump() {
  if (running || !queue.length) return;
  const job = running = queue.shift();
  job.status = 'processing';
  try {
    job.result = await transcribe(job); job.status = 'done';
    if (job.polish) polishing = polishing.then(() => polish(job));   // the transcript is already available; paragraphs follow
  }
  catch (e) { job.status = 'error'; job.error = e.message; }
  job.finished = Date.now();
  console.log(`job ${job.status} ${job.result?.duration ?? 0}s ${job.donor ? 'donor' : 'free'}`);   // counts only, nothing personal
  if (job.status === 'done') { count('done'); count('minutes', job.result.duration / 60); } else count('failed');
  running = null;
  pump();
}

// ---- pages: index.html filled from pages.json, once, at start ---------------
const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const json = v => JSON.stringify(v).replace(/</g, '\\u003c');
const ICON = d => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = [
  '<path d="M4 10v4M8 6v12M12 3v18M16 8v8M20 11v2"/>',                                              // waveform
  '<path d="M12 3l8 3v6c0 4.500-3.200 7.800-8 9-4.800-1.200-8-4.500-8-9V6z"/><path d="M9 12l2 2 4-4"/>',   // shield
  '<circle cx="12" cy="12" r="9"/><path d="M9.500 9.500a2.500 2.500 0 1 1 3.500 2.300c-.700.400-1 1-1 1.700M12 17v.500"/>',   // question
];
export function buildPages() {
  const tpl = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  const { strings, pages } = JSON.parse(fs.readFileSync(path.join(DIR, 'pages.json'), 'utf8'));
  const out = new Map();
  for (const p of pages) {
    const url = ORIGIN + (p.path === '/' ? '/' : p.path), alt = pages.find(x => x.path === p.alt);
    const hreflang = alt ? [p, alt].map(x => `<link rel="alternate" hreflang="${x.lang}" href="${ORIGIN}${x.path}">`).join('\n')
      + `\n<link rel="alternate" hreflang="x-default" href="${ORIGIN}${p.lang === 'en' ? p.path : alt.path}">` : '';
    const content = (p.sections || []).map((s, i) => `<section class="card prose"><h2>${ICON(ICONS[i % 2])}${s.h}</h2>${s.p.map(t => `<p>${t}</p>`).join('')}</section>`).join('\n')
      + (p.faq ? `\n<section class="card prose faq"><h2>${ICON(ICONS[2])}${strings[p.lang].faqTitle}</h2>${p.faq.map(f => `<details><summary>${f.q}</summary><p>${f.a}</p></details>`).join('')}</section>` : '');
    const ld = [{ '@context': 'https://schema.org', '@type': 'WebApplication', name: 'Transcribe', url, description: p.description,
      inLanguage: p.lang, applicationCategory: 'MultimediaApplication', operatingSystem: 'Any', isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } }];
    if (p.faq) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: p.faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<[^>]+>/g, '') } })) });
    const nav = pages.filter(x => x.lang === p.lang && x.path !== p.path).map(x => `<a href="${x.path}">${x.nav}</a>`).join('');
    out.set(p.path, fill(tpl, { ...strings[p.lang], lang: p.lang, title: esc(p.title), description: esc(p.description), h1: p.h1, sub: p.sub,
      canonical: url, hreflang, content, nav, jsonld: json(ld), T: json(strings[p.lang]), origin: ORIGIN, repo: REPO, coffee: COFFEE,
      home: p.lang === 'en' ? '/' : '/es', enPath: p.lang === 'en' ? p.path : alt?.path || '/', esPath: p.lang === 'es' ? p.path : alt?.path || '/es',
      enCur: p.lang === 'en' ? 'aria-current="page"' : '', esCur: p.lang === 'es' ? 'aria-current="page"' : '' }));
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
  ...(j.status === 'processing' && j.started != null && { progress: j.progress, eta: eta(j) }),
  ...(j.status === 'error' && { error: j.error }), ...j.result,
  ...(j.status === 'done' && j.polish && { polish: j.polish.status, polishProgress: j.polish.progress, ...(j.polish.paragraphs && { paragraphs: j.polish.paragraphs }), ...(j.polish.summaryText && { summary: j.polish.summaryText }) }) });
const wantsPolish = url => {
  const paras = url.searchParams.has('polish'), summary = url.searchParams.has('summary');
  return POLISH_MODEL && (paras || summary) ? { status: 'queued', progress: 0, paras, summary } : undefined;
};

function statsPage() {
  const days = Object.keys(stats).sort().reverse(), cols = ['users', 'jobs', 'done', 'failed', 'minutes', 'donorJobs'];
  const total = Object.fromEntries(cols.map(c => [c, Math.round(days.reduce((n, d) => n + stats[d][c], 0))]));
  const row = (label, d) => `<tr><th>${label}</th>${cols.map(c => `<td>${d[c]}</td>`).join('')}</tr>`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Transcribe usage</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:32px auto;max-width:760px;padding:0 16px;color:#17171A}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:8px 10px;border-bottom:1px solid #E6E4DE;text-align:right}th:first-child{text-align:left}thead th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5C5B66}p{color:#5C5B66}tfoot th,tfoot td{font-weight:700;border-top:2px solid #17171A}</style>
<h1>Transcribe usage</h1>
<p>Right now: ${running ? 1 : 0} transcribing, ${queue.length} waiting. Supporter keys: ${Object.keys(loadDonors()).length}.</p>
<table><thead><tr><th>Day (UTC)</th><th>Users</th><th>Jobs started</th><th>Finished</th><th>Failed or cancelled</th><th>Audio minutes</th><th>Supporter jobs</th></tr></thead>
<tbody>${days.slice(0, 60).map(d => row(d, stats[d])).join('') || '<tr><th>No jobs yet</th></tr>'}</tbody>
<tfoot>${row('All time', total)}</tfoot></table>
<p>Users are distinct callers per day, counted without storing who they are, so the all-time figure adds up the days: a person who comes back on three days counts three times. Page visits are not counted here; Cloudflare's analytics has those.</p>`;
}
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
      // The transcription API can be called from any web page. Keys and the webhook are not opened up.
      if (/^\/api\/(transcribe|jobs)\b/.test(p)) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After');
        if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', { 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
      }
      if (req.method === 'GET' && p === '/stats') {   // owner only: needs ADMIN_KEY from .env, and looks like any missing page without it
        const k = url.searchParams.get('key') || '', want = env.ADMIN_KEY || '';
        if (!want || k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) return send(res, 404, { error: 'not found' });
        return send(res, 200, statsPage(), 'text/html', { 'X-Robots-Tag': 'noindex' });
      }
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
        const hold = url.searchParams.has('hold'), owner = key || ip(req);
        const held = [...jobs.values()].filter(j => j.status === 'uploaded');
        if (queue.length + uploading + held.length >= MAX_QUEUE) return send(res, 503, { error: 'the queue is full, try again in a few minutes' }, 'application/json', { 'Retry-After': '120' });
        const lim = (l => (hold ? l.peek(owner) : l(owner)))(key ? limits.donor : limits.free);   // a held upload spends its slot when it is started
        const rate = { 'X-RateLimit-Limit': lim.limit, 'X-RateLimit-Remaining': lim.remaining };
        if (!lim.ok) return send(res, 429, { error: `limit of ${lim.limit} transcriptions per hour reached`, retryAfter: lim.retryAfter },
          'application/json', { ...rate, 'Retry-After': lim.retryAfter });
        const job = { id: crypto.randomUUID(), status: hold ? 'uploaded' : 'queued', language, donor: !!key, owner, polish: wantsPolish(url) };
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
        if (hold) {
          // ponytail: one waiting upload per caller, so repeated uploads cannot fill the disk. They can still burn bandwidth; rate-limit uploads if that is abused.
          for (const j of held) if (j.owner === owner) { jobs.delete(j.id); fs.rmSync(j.file, { force: true }); }
          job.held = Date.now();
          return send(res, 202, view(job), 'application/json', rate);
        }
        enqueue(queue, job);
        count('jobs', 1, owner); if (job.donor) count('donorJobs');
        const body = view(job);
        pump();
        return send(res, 202, body, 'application/json', rate);
      }

      const go = /^\/api\/jobs\/([\w-]+)\/start$/.exec(p);
      if (go && req.method === 'POST') {
        const j = jobs.get(go[1]);
        if (!j) return send(res, 404, { error: 'no such upload (uploads that are not started are deleted after 10 minutes)' });
        if (j.status !== 'uploaded') return send(res, 409, { error: 'this upload was already started' });
        const language = url.searchParams.get('language') || j.language;
        if (!LANGS.includes(language)) return send(res, 400, { error: `language must be one of ${LANGS.join(', ')}` });
        const lim = (j.donor ? limits.donor : limits.free)(j.owner);
        const rate = { 'X-RateLimit-Limit': lim.limit, 'X-RateLimit-Remaining': lim.remaining };
        if (!lim.ok) return send(res, 429, { error: `limit of ${lim.limit} transcriptions per hour reached`, retryAfter: lim.retryAfter },
          'application/json', { ...rate, 'Retry-After': lim.retryAfter });
        Object.assign(j, { status: 'queued', language, polish: wantsPolish(url) || j.polish });
        enqueue(queue, j);
        count('jobs', 1, j.owner); if (j.donor) count('donorJobs');
        const body = view(j);
        pump();
        return send(res, 200, body, 'application/json', rate);
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
        if (i >= 0) queue.splice(i, 1);
        if (i >= 0 || j.status === 'uploaded') fs.rmSync(j.file, { force: true });
        if (running === j) j.proc?.kill();     // cancelled mid-run: stop working on it now; transcribe()'s finally deletes the audio
        return send(res, 200, { ok: true });
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
        if (!verifySig(raw, req.headers['x-signature-sha256'] || req.headers['x-bmc-signature'], env.BMC_WEBHOOK_SECRET)) return send(res, 401, { error: 'bad signature' });
        const ev = JSON.parse(raw);
        const email = ev.data?.supporter_email;
        if (typeof email === 'string' && email.includes('@')) /refund/i.test(ev.type || '') ? revoke(email) : grant(email);
        return send(res, 200, { ok: true });
      }

      if (['/api/transcribe', '/api/claim', '/api/bmc-webhook'].includes(p))
        return send(res, 405, { error: 'this endpoint only accepts POST' }, 'application/json', { Allow: 'POST' });
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // One odd request must not take down everyone's waiting jobs (they live in memory): log it and keep serving.
  process.on('uncaughtException', e => console.error('uncaught:', e));
  process.on('unhandledRejection', e => console.error('unhandled:', e));
  setInterval(() => {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (j.finished && now - j.finished > RESULT_TTL) jobs.delete(id);
      if (j.status === 'uploaded' && now - j.held > HOLD_TTL) { jobs.delete(id); fs.rmSync(j.file, { force: true }); }
    }
    for (const l of Object.values(limits)) l.sweep(now);
  }, 60e3).unref();
  // Always 127.0.0.1, never *:port. The Cloudflare tunnel is the only way in.
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => console.log(`transcribe on http://127.0.0.1:${server.address().port}`));
}
