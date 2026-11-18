// The public API, without a browser: what a CLI or another app would do.
import { test, expect, REAL, LOCALES, audio, waitJob, gone } from './helpers.mjs';

const post = (request, query, body, headers = {}) => request.post('/api/transcribe' + query, { data: body, headers: { 'content-type': 'application/octet-stream', ...headers } });

for (const [lang, L] of Object.entries(LOCALES)) {
  test(`${lang}: upload, poll, transcript`, async ({ request }) => {
    const res = await post(request, `?language=${L.speech}`, audio(L.file));
    expect(res.status()).toBe(202);
    expect(res.headers()['x-ratelimit-limit']).toBe('3');
    expect(res.headers()['x-ratelimit-remaining']).toBe('2');
    const { id, status } = await res.json();
    expect(['queued', 'processing']).toContain(status);
    const job = await waitJob(request, id);
    expect(job.status).toBe('done');
    expect(job.language).toBe(L.speech);
    expect(job.text).toMatch(L.says);
    expect(job.duration).toBeGreaterThan(3);
    expect(job.segments[0]).toMatchObject({ start: 0, text: expect.any(String) });
    expect(job.segments[0].end).toBeGreaterThan(0);

    expect((await request.delete('/api/jobs/' + id)).status()).toBe(200);   // forget it now rather than in an hour
    expect((await request.get('/api/jobs/' + id)).status()).toBe(404);
  });

  test(`${lang}: paragraphs and summary on request`, async ({ request }) => {
    const { id } = await (await post(request, `?language=${L.speech}&polish=1&summary=1`, audio(L.file))).json();
    const job = await waitJob(request, id, j => j.status === 'error' || (j.status === 'done' && !['queued', 'running'].includes(j.polish)));
    expect(job.polish).toBe('done');
    expect(job.paragraphs.join(' ')).toMatch(L.says);
    expect(job.summary.length).toBeGreaterThan(20);
    if (!REAL) expect(job.summary).toContain(L.stubSummary);   // the summary is in the transcript's language
  });
}

test('upload now, start later', async ({ request }) => {
  const first = await (await post(request, '?hold=1', audio('en.m4a'))).json();
  expect(first.status).toBe('uploaded');
  const second = await (await post(request, '?hold=1', audio('es.m4a'))).json();
  expect((await request.get('/api/jobs/' + first.id)).status()).toBe(404);          // one waiting upload per caller: the newer replaces it
  expect((await request.post(`/api/jobs/${second.id}/start?language=xx`)).status()).toBe(400);
  const started = await request.post(`/api/jobs/${second.id}/start?language=es`);
  expect(started.status()).toBe(200);
  expect(started.headers()['x-ratelimit-remaining']).toBe('2');                      // the hourly slot is spent at start, not at upload
  expect((await request.post(`/api/jobs/${second.id}/start`)).status()).toBe(409);
  expect((await request.post('/api/jobs/nope/start')).status()).toBe(404);
  const job = await waitJob(request, second.id);
  expect(job.status).toBe('done');
  expect(job.text).toMatch(LOCALES.es.says);
});

test('cancel a running job, and the queue moves on', async ({ request }) => {
  const { id } = await (await post(request, '?language=en', audio('slow.m4a'))).json();
  await waitJob(request, id, j => j.status === 'processing');
  expect((await request.delete('/api/jobs/' + id)).status()).toBe(200);
  expect((await request.get('/api/jobs/' + id)).status()).toBe(404);
  const next = await (await post(request, '?language=en', audio('en.m4a'))).json();
  expect((await waitJob(request, next.id)).status).toBe('done');
});

test('a file that is not audio ends as an error, not a hang', async ({ request }) => {
  const { id } = await (await post(request, '', audio('not-audio.txt'))).json();
  const job = await waitJob(request, id);
  expect(job).toMatchObject({ status: 'error', error: 'could not read this file as audio' });
});

test('hourly limit: the fourth job is refused with a wait time', async ({ request }) => {
  for (let i = 0; i < 3; i++) expect((await post(request, '?hold=1', audio('en.m4a'))).status()).toBe(202);   // holding spends nothing
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await (await post(request, '', audio('en.m4a'))).json()).id);
  const res = await post(request, '', audio('en.m4a'));
  expect(res.status()).toBe(429);
  expect(Number(res.headers()['retry-after'])).toBeGreaterThan(3500);
  expect(await res.json()).toMatchObject({ error: 'limit of 3 transcriptions per hour reached', retryAfter: expect.any(Number) });
  expect((await post(request, '?hold=1', audio('en.m4a'))).status()).toBe(429);       // and a new upload is refused up front
  for (const id of ids) await request.delete('/api/jobs/' + id);
});

test('bad requests get clear answers', async ({ request }) => {
  expect((await post(request, '?language=xx', audio('en.m4a'))).status()).toBe(400);
  expect((await post(request, '', '')).status()).toBe(400);
  expect((await post(request, '', audio('en.m4a'), { authorization: 'Bearer not-a-key' })).status()).toBe(401);
  const get = await request.get('/api/transcribe');
  expect(get.status()).toBe(405);
  expect(get.headers().allow).toBe('POST');
  expect((await request.get('/api/jobs/nope')).status()).toBe(404);
  expect((await request.get('/api/nothing-here')).status()).toBe(404);
});

test('other websites may call the transcription API, but not the key endpoints', async ({ request }) => {
  const pre = await request.fetch('/api/transcribe', { method: 'OPTIONS' });
  expect(pre.status()).toBe(204);
  expect(pre.headers()['access-control-allow-origin']).toBe('*');
  expect(pre.headers()['access-control-allow-headers']).toContain('Authorization');
  expect((await request.get('/api/jobs/nope')).headers()['access-control-allow-origin']).toBe('*');
  expect((await request.fetch('/api/claim', { method: 'OPTIONS' })).headers()['access-control-allow-origin']).toBeUndefined();
});
