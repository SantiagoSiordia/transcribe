// node server.test.mjs: the logic that guards limits, keys and the queue. No framework.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-test-'));
Object.assign(process.env, { DONORS_FILE: path.join(dir, 'donors.json'), TMP_DIR: path.join(dir, 'up'), BMC_WEBHOOK_SECRET: 's3cret' });
const { limiter, verifySig, enqueue, grant, claim, revoke, buildPages, createServer } = await import('./server.mjs');

// rate limiter: 3 per hour, then blocked, then free again once the window slides
const take = limiter(3, 1000);
assert.deepEqual([take('a', 0).ok, take('a', 1).ok, take('a', 2).ok, take('a', 3).ok], [true, true, true, false]);
assert.equal(take('a', 500).retryAfter, 1);
assert.equal(take('b', 3).ok, true);            // other callers are unaffected
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
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok');
