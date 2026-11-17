// node server.test.mjs: the logic that guards limits, keys and the queue. No framework.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-test-'));
Object.assign(process.env, { DONORS_FILE: path.join(dir, 'donors.json'), TMP_DIR: path.join(dir, 'up'), BMC_WEBHOOK_SECRET: 's3cret', STATS_FILE: path.join(dir, 'stats.json'), ADMIN_KEY: 'adm1n' });
const { limiter, verifySig, enqueue, grant, claim, revoke, buildPages, createServer, eta, sameWords, chunks, joinParas, reflow, count, pool, parts } = await import('./server.mjs');

// rate limiter: 3 per hour, then blocked, then free again once the window slides
const take = limiter(3, 1000);
assert.deepEqual([take('a', 0).ok, take('a', 1).ok, take('a', 2).ok, take('a', 3).ok], [true, true, true, false]);
assert.equal(take('a', 500).retryAfter, 1);
assert.equal(take('b', 3).ok, true);            // other callers are unaffected
assert.equal(take.peek('c', 0).ok, true); assert.equal(take.peek('c', 0).remaining, 3);   // peeking spends nothing
assert.equal(take.peek('a', 500).ok, false);
assert.equal(take('a', 1001).ok, true);         // first hit expired

// webhook signature: hex or base64 of HMAC-SHA256(raw body), nothing else
const body = Buffer.from('{"type":"donation.created","data":{"supporter_email":"Ana@Example.com"}}');
const mac = crypto.createHmac('sha256', 's3cret').update(body).digest();
assert.equal(verifySig(body, mac.toString('hex'), 's3cret'), true);
assert.equal(verifySig(body, mac.toString('base64'), 's3cret'), true);
assert.equal(verifySig(body, mac.toString('hex'), 'other'), false);
assert.equal(verifySig(body, undefined, 's3cret'), false);
assert.equal(verifySig(body, mac.toString('hex'), ''), false);   // no secret configured: reject everything

// donor keys: stable per email, case-insensitive, email never stored in the clear
const key = grant('Ana@Example.com');
assert.match(key, /^tr_[0-9a-f]{48}$/);
assert.equal(grant('ana@example.com '), key);
assert.equal(claim('ANA@example.com'), key);
assert.equal(claim('bob@example.com'), null);
assert.ok(!fs.readFileSync(process.env.DONORS_FILE, 'utf8').toLowerCase().includes('ana@'));
revoke('ana@example.com');
assert.equal(claim('ana@example.com'), null);

// queue: donors go behind earlier donors and ahead of every free job
const q = [];
for (const [id, donor] of [['f1', false], ['d1', true], ['f2', false], ['d2', true]]) enqueue(q, { id, donor });
assert.deepEqual(q.map(j => j.id), ['d1', 'd2', 'f1', 'f2']);

// time left: a guess from audio length at first, then the job's real pace
assert.equal(eta({}), undefined);                                             // still converting: no estimate yet
assert.equal(eta({ started: 0, seconds: 600, progress: 0 }, 0), 27);         // 3 s load + 600 s * 0.04
assert.equal(eta({ started: 0, seconds: 600, progress: 0.25 }, 10e3), 30);   // 25% took 10 s, so 30 s to go
assert.equal(eta({ started: 0, seconds: 5, progress: 0 }, 60e3), 1);         // never zero or negative while still running

// readable paragraphs: the cleanup may touch case, punctuation and breaks, never a word
assert.equal(sameWords('so yesterday i was there and she said yes', 'So, yesterday I was there.\n\nAnd she said: "Yes!"'), true);
assert.equal(sameWords('let us move on', "Let's move on."), false);           // a contraction is a changed word
assert.equal(sameWords('it cost $40,000', 'It cost $40,000.'), true);
assert.equal(sameWords('fuimos a méxico', 'Fuimos a Mexico.'), false);         // so is a dropped accent
assert.deepEqual(chunks([{ text: 'a'.repeat(700) }, { text: 'b'.repeat(700) }, { text: 'c' }]).map(c => c.length), [700, 702]);
assert.deepEqual(joinParas([['One. Two', 'three'], ['four.', 'Five.'], ['Six.']]), ['One. Two', 'three four.', 'Five.', 'Six.']);
assert.deepEqual(reflow(['Aaa. Bbb. Ccc.', 'Short one.'], 9), ['Aaa. Bbb.', 'Ccc.', 'Short one.']);   // long paragraphs split at sentence ends only
assert.deepEqual(reflow(['no sentence end here at all'], 5), ['no sentence end here at all']);
assert.deepEqual(await pool([30, 10, 20], async (ms, i) => { await new Promise(r => setTimeout(r, ms)); return i; }, 2), [0, 1, 2]);   // parallel, but results stay in order
assert.deepEqual(parts('aaaa bbbb cccc', 9), ['aaaa bbbb', 'cccc']);       // cut at a space, nothing lost
assert.deepEqual(parts('x'.repeat(25), 10).map(s => s.length), [10, 10, 5]);   // even with no space to cut at

// usage: the same caller counts once a day, a new day starts a new count, and no caller id reaches the file
const d1 = new Date('2026-01-01T10:00:00Z'), d2 = new Date('2026-01-02T10:00:00Z');
count('jobs', 1, '203.0.113.7', d1); count('jobs', 1, '203.0.113.7', d1);
assert.deepEqual([count('jobs', 1, '198.51.100.2', d1).users, count('jobs', 0, undefined, d1).jobs], [2, 3]);
assert.equal(count('jobs', 1, '203.0.113.7', d2).users, 1);
assert.ok(!fs.readFileSync(process.env.STATS_FILE, 'utf8').includes('203.0.113'));

// pages: every page renders with no placeholder left, and each has its language pair
const pages = buildPages();
assert.ok(pages.size >= 12);
for (const [p, html] of pages) {
  assert.ok(!/\{\{\w+\}\}/.test(html), `unfilled placeholder in ${p}: ${html.match(/\{\{\w+\}\}/)}`);
  assert.ok(html.includes('hreflang="es"') && html.includes('hreflang="en"'), `no hreflang pair on ${p}`);
}

// i18n: both locales define the same strings, and every translated server error still exists in the server
const { strings } = JSON.parse(fs.readFileSync(new URL('./pages.json', import.meta.url), 'utf8'));
const keys = l => Object.keys(strings[l]).filter(k => k !== 'errors').sort();
assert.deepEqual(keys('es'), keys('en'));
const src = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
for (const e of Object.keys(strings.es.errors)) assert.ok(src.includes(`'${e}'`), `stale error translation: ${e}`);
assert.ok(pages.get('/').includes('<html lang="en">') && pages.get('/es').includes('<html lang="es">'));

// http: the trust boundary. Real server on a random port, no whisper needed for these.
const server = createServer().listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (p, b, headers = {}) => fetch(base + p, { method: 'POST', body: b, headers });
assert.equal((await fetch(base + '/es/')).status, 200);
assert.equal((await fetch(base + '/sitemap.xml')).status, 200);
assert.equal((await fetch(base + '/public/../server.mjs')).status, 404);
assert.equal((await fetch(base + '/public/%2e%2e%2fserver.mjs')).status, 404);
assert.equal((await post('/api/transcribe?language=xx', 'x')).status, 400);
assert.equal((await post('/api/transcribe', 'x', { authorization: 'Bearer nope' })).status, 401);
assert.equal((await post('/api/transcribe', '')).status, 400);                    // empty body
assert.equal((await post('/api/bmc-webhook', body)).status, 401);                 // unsigned
assert.equal((await post('/api/bmc-webhook', body, { 'x-signature-sha256': mac.toString('hex') })).status, 200);
const claimed = await (await post('/api/claim', JSON.stringify({ email: 'ana@example.com' }))).json();
assert.match(claimed.key, /^tr_/);
assert.equal((await post('/api/claim', JSON.stringify({ email: 'nobody@example.com' }))).status, 404);
assert.equal((await fetch(base + '/api/jobs/nope')).status, 404);
// upload now, start later: a held upload waits, a newer one from the same caller replaces it, and it starts exactly once
const h1 = await (await post('/api/transcribe?hold=1', 'not audio')).json();
assert.equal(h1.status, 'uploaded');
const h2 = await (await post('/api/transcribe?hold=1', 'not audio')).json();
assert.equal((await fetch(base + '/api/jobs/' + h1.id)).status, 404);          // replaced, and its file is gone
assert.equal(fs.readdirSync(process.env.TMP_DIR).filter(f => f === h1.id).length, 0);
assert.equal((await post(`/api/jobs/${h2.id}/start?language=xx`, '')).status, 400);
const started = await post(`/api/jobs/${h2.id}/start?language=es`, '');
assert.equal(started.status, 200);
assert.ok(['queued', 'processing'].includes((await started.json()).status));
assert.equal((await post(`/api/jobs/${h2.id}/start`, '')).status, 409);
assert.equal((await post('/api/jobs/nope/start', '')).status, 404);
assert.equal((await fetch(base + '/api/bmc-webhook')).status, 405);
assert.equal((await fetch(base + '/stats')).status, 404);                        // owner page is invisible without the key
assert.equal((await fetch(base + '/stats?key=wrong')).status, 404);
assert.match(await (await fetch(base + '/stats?key=adm1n')).text(), /Transcribe usage/);
const pre = await fetch(base + '/api/transcribe', { method: 'OPTIONS' });          // other sites' pages may call the API
assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), '*');
assert.equal((await fetch(base + '/api/claim', { method: 'OPTIONS' })).headers.get('access-control-allow-origin'), null);   // opened in a browser: say POST only, not "not found"
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok');
