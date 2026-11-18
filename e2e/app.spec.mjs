// The tool itself, in a real browser, once per language: /, and /es with Spanish audio and Spanish messages.
import fs from 'node:fs';
import { test, expect, REAL, LOCALES, audio, fx, choose, transcribe, tidied, gone, sign } from './helpers.mjs';

for (const [lang, L] of Object.entries(LOCALES)) {
  const T = L.T;
  test.describe(lang, () => {
    test.beforeEach(async ({ page }) => { await page.goto(L.home); });

    test('choose a file, transcribe it, find it in the library after a reload', async ({ page }) => {
      await expect(page.locator('#go')).toBeDisabled();
      await expect(page.locator('#status')).toHaveText(T.noFile);
      await expect(page.locator('#cancel')).toBeHidden();

      // hold the upload back for a moment so the in-between state can be seen
      await page.route('**/api/transcribe?hold=1', async route => { await new Promise(r => setTimeout(r, 700)); await route.continue(); });
      await page.setInputFiles('#file', fx(L.file));
      await expect(page.locator('#dropTitle')).toHaveText(L.file);
      await expect(page.locator('#go')).toHaveText(T.uploadingBtn);
      await expect(page.locator('#go')).toBeDisabled();
      await expect(page.locator('#status')).toHaveText(T.uploaded);
      await expect(page.locator('#go')).toHaveText(T.transcribe);
      await expect(page.locator('#go')).toBeEnabled();
      await expect(page.locator('#cancel')).toHaveText(T.remove);

      await page.click(`#langs [data-l="${L.speech}"]:not([data-mixed])`);
      await page.click('#go');
      await expect(page.locator('#go')).toHaveText(T.transcribing);
      await expect(page.locator('#go')).toBeDisabled();
      await expect(page.locator('#mTitle')).toHaveText(T.readyTitle);
      await expect(page.locator('#modal')).toContainText(T.modalBody);
      await page.locator('#modal [data-close]').first().click();

      await expect(page.locator('#docName')).toHaveText(L.file);
      await expect(page.locator('#docMeta')).toContainText(L.speechName);          // the audio's language, named in the page's language
      await expect(page.locator('#segs time').first()).toHaveText('00:00');
      await expect(page.locator('#segs')).toContainText(L.says);
      await expect(page.locator('#lib .row')).toHaveCount(1);
      await expect(page.locator('#lib .row')).toContainText(L.file);
      await expect(page.locator('#lib .day').first()).toHaveText(T.today);
      await expect(page.locator('#status')).toHaveText(T.noFile);                   // ready for the next one
      await expect(page.locator('#go')).toBeDisabled();

      await tidied(page, L);
      await page.reload();
      await expect(page.locator('#lib .row')).toHaveCount(1);
      await expect(page.locator('#segs')).toContainText(L.says);
    });

    test('timestamps, paragraphs and summary; copy and download follow the view', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await transcribe(page, L);
      const pressed = v => expect(page.locator(`#view [data-v="${v}"]`)).toHaveAttribute('aria-pressed', 'true');
      const width = async v => (await page.locator(`#view [data-v="${v}"]`).boundingBox()).width;
      const copied = async () => { await page.click('#copy'); return page.evaluate(() => navigator.clipboard.readText()); };

      await pressed('stamps');
      expect(await copied()).toMatch(/^\[00:00\] \S/);
      await expect.poll(async () => (await width('stamps')) - (await width('paras'))).toBeGreaterThan(40);   // the chosen one shows its name, the others only an icon

      await tidied(page, L);
      await page.click('#view [data-v="paras"]');
      await pressed('paras');
      await expect(page.locator('#segs time')).toHaveCount(0);
      await expect(page.locator('#segs p').first()).toContainText(L.says);
      await expect.poll(async () => (await width('paras')) - (await width('stamps'))).toBeGreaterThan(40);
      const text = await copied();
      expect(text).toMatch(L.says);
      expect(text).not.toContain('[00:00]');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dl')]);
      expect(download.suggestedFilename()).toBe(L.file.replace('.m4a', '.txt'));
      expect(fs.readFileSync(await download.path(), 'utf8')).toBe(text);

      await page.click('#view [data-v="summary"]');
      await pressed('summary');
      await expect(page.locator('#segs .hint')).toHaveText(T.summaryNote);            // labelled as written by a model
      await expect(page.locator('#segs p:not(.hint)').first()).not.toBeEmpty();
      if (!REAL) {
        await expect(page.locator('#segs .li')).toHaveCount(2);
        await expect(page.locator('#segs')).toContainText(L.stubSummary);            // in the transcript's language
      }

      await page.reload();                                                           // the chosen view is remembered
      await pressed('summary');
    });

    test('remove a chosen file', async ({ page, request }) => {
      await choose(page, L);
      const id = await page.evaluate(() => up.id);
      await page.click('#cancel');
      await expect(page.locator('#status')).toHaveText(T.noFile);
      await expect(page.locator('#dropTitle')).toHaveText(T.dropTitle);
      await expect(page.locator('#go')).toBeDisabled();
      await expect(page.locator('#cancel')).toBeHidden();
      await gone(request, id);                                                       // deleted from the server too
    });

    test('cancel a transcription that is running, then do another', async ({ page, request }) => {
      await choose(page, L, 'slow.m4a');
      await page.click('#go');
      await expect(page.locator('body')).toHaveClass(/busy/);
      await expect(page.locator('#cancel')).toHaveText(T.cancel);
      await expect(page.locator('#status')).toContainText(/\d+%/);                   // live progress
      await expect(page.locator('#dropSub')).toContainText(/\d+%/);
      const id = await page.evaluate(() => active);
      await page.click('#cancel');
      await expect(page.locator('body')).not.toHaveClass(/busy/);
      await expect(page.locator('#status')).toHaveText(T.noFile);
      await expect(page.locator('#lib .row')).toHaveCount(0);
      await gone(request, id);
      await transcribe(page, L);
      await expect(page.locator('#segs')).toContainText(L.says);
    });

    test('reload while transcribing picks the job back up', async ({ page }) => {
      await choose(page, L, 'slow.m4a');
      await page.click('#go');
      await expect(page.locator('#status')).toContainText(/\d+%/);
      await page.reload();
      await expect(page.locator('body')).toHaveClass(/busy/);
      await expect(page.locator('#dropTitle')).toHaveText('slow.m4a');
      await expect(page.locator('#go')).toBeDisabled();
      await expect(page.locator('#mTitle')).toHaveText(T.readyTitle, { timeout: REAL ? 240e3 : 30e3 });
      await page.locator('#modal [data-close]').first().click();
      await expect(page.locator('#docName')).toHaveText('slow.m4a');
      await expect(page.locator('#lib .row')).toHaveCount(1);
    });

    test('a file that is not audio fails with a message in this language', async ({ page }) => {
      await choose(page, L, 'not-audio.txt');
      await page.click('#go');
      const msg = 'could not read this file as audio';
      await expect(page.locator('#status')).toHaveText(T.failed.replace('{e}', T.errors?.[msg] || msg));
      await expect(page.locator('body')).not.toHaveClass(/busy/);
      await expect(page.locator('#go')).toBeEnabled();                              // they can try again
    });

    test('the fourth file in an hour is refused with the wait time', async ({ page, request }) => {
      const ids = [];   // three jobs from this same visitor, through the API
      for (let i = 0; i < 3; i++) ids.push((await (await request.post('/api/transcribe', { data: audio(L.file), headers: { 'content-type': 'application/octet-stream' } })).json()).id);
      await page.setInputFiles('#file', fx(L.file));
      await expect(page.locator('#status')).toHaveText(T.rateLimited.replace('{n}', '3').replace('{m}', '60'));
      for (const id of ids) await request.delete('/api/jobs/' + id);
    });

    test('supporter: a donation creates a key, claimed by email in the dialog and used from then on', async ({ page, request }) => {
      const email = `supporter-${lang}@example.com`;
      const event = JSON.stringify({ type: 'donation.created', data: { supporter_email: email } });
      expect((await request.post('/api/bmc-webhook', { data: event, headers: { 'content-type': 'application/json' } })).status()).toBe(401);   // unsigned
      expect((await request.post('/api/bmc-webhook', { data: event, headers: { 'content-type': 'application/json', 'x-signature-sha256': sign(event) } })).status()).toBe(200);

      await page.click('#about');
      await expect(page.locator('#mTitle')).toHaveText(T.aboutTitle);
      await page.fill('#email', `nobody-${lang}@example.com`);
      await page.click('#claim button');
      await expect(page.locator('#keyMsg')).toHaveText(T.keyNone);
      await page.fill('#email', email.toUpperCase());                               // the email is matched whatever its case
      await page.click('#claim button');
      await expect(page.locator('#key')).toHaveText(/^tr_[0-9a-f]{48}$/);
      await expect(page.locator('#keyMsg')).toHaveText(T.keyOk);
      await expect(page.locator('#claim')).toBeHidden();
      await page.locator('#modal [data-close]').first().click();

      const [upload] = await Promise.all([
        page.waitForRequest(r => r.url().includes('/api/transcribe?hold=1')),
        page.setInputFiles('#file', fx(L.file)),
      ]);
      const key = await page.evaluate(() => localStorage.getItem('apiKey'));
      expect(upload.headers().authorization).toBe('Bearer ' + key);
      expect((await upload.response()).headers()['x-ratelimit-limit']).toBe('30');  // the supporter allowance
      await expect(page.locator('#status')).toHaveText(T.uploaded);
    });
  });

  test.describe(`${lang} library`, () => {
    test('search by name, open another transcript, delete one', async ({ page }) => {
      await page.addInitScript(() => {
        if (localStorage.getItem('seeded')) return;
        localStorage.setItem('seeded', '1');
        localStorage.setItem('transcripts', JSON.stringify([
          { id: 'a', name: 'interview.m4a', at: Date.now(), language: 'en', duration: 65, segments: [{ start: 0, end: 2, text: 'First recording.' }] },
          { id: 'b', name: 'clase.mp3', at: Date.now() - 3 * 864e5, language: 'es', duration: 600, segments: [{ start: 0, end: 2, text: 'Segunda grabación.' }] },
        ]));
      });
      await page.goto(L.home);
      await expect(page.locator('#lib .row')).toHaveCount(2);
      await expect(page.locator('#docName')).toHaveText('interview.m4a');           // newest is open
      await expect(page.locator('#lib .row').nth(1)).toContainText('10:00');        // duration

      await page.fill('#q', 'clase');
      await expect(page.locator('#lib .row')).toHaveCount(1);
      await page.click('#lib .row');
      await expect(page.locator('#docName')).toHaveText('clase.mp3');
      await expect(page.locator('#segs')).toContainText('Segunda grabación.');
      await page.fill('#q', 'nothing like this');
      await expect(page.locator('#lib')).toHaveText(T.emptyLib);
      await page.fill('#q', '');
      await expect(page.locator('#lib .row')).toHaveCount(2);

      page.once('dialog', d => { expect(d.message()).toBe(T.delConfirm); d.dismiss(); });
      await page.click('#del');
      await expect(page.locator('#lib .row')).toHaveCount(2);                       // "Cancel" in the confirm keeps it
      page.once('dialog', d => d.accept());
      await page.click('#del');
      await expect(page.locator('#lib .row')).toHaveCount(1);
      await expect(page.locator('#docName')).toHaveText('interview.m4a');
      await page.reload();
      await expect(page.locator('#lib .row')).toHaveCount(1);                       // gone for good
    });
  });
}
