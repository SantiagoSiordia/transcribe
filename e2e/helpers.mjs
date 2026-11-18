import { test as base, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export { expect };
export const REAL = !!process.env.E2E_REAL;
export const { strings, pages } = JSON.parse(fs.readFileSync(new URL('../pages.json', import.meta.url), 'utf8'));
export const fx = name => fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
export const audio = name => fs.readFileSync(fx(name));

// Everything a test needs to know about a locale. The copy comes from pages.json, so tests follow the real strings.
export const LOCALES = {
  en: { home: '/', T: strings.en, file: 'en.m4a', speech: 'en', says: /test of the transcription service/i, speechName: 'English',
    stubSummary: 'First key point' },
  es: { home: '/es', T: strings.es, file: 'es.m4a', speech: 'es', says: /prueba del servicio de transcripción/i, speechName: 'Español',
    stubSummary: 'Primer punto clave' },
};

// Every test is its own visitor. The server tells people apart by this header, exactly as it does behind Cloudflare,
// so each test gets a fresh hourly limit without any test-only switch in the server.
export const test = base.extend({
  extraHTTPHeaders: async ({}, use, info) => {
    const h = crypto.createHash('sha256').update(`${info.testId}-${info.retry}-${info.repeatEachIndex}`).digest();
    await use({ 'CF-Connecting-IP': `10.${h[0]}.${h[1]}.${h[2]}` });
  },
});

// ---- page flows ----
export async function choose(page, L, file = L.file) {
  await page.setInputFiles('#file', fx(file));
  await expect(page.locator('#status')).toHaveText(L.T.uploaded);   // it uploads by itself
}
export async function transcribe(page, L, file = L.file, speech = L.speech) {
  await choose(page, L, file);
  await page.click(`#langs [data-l="${speech}"]:not([data-mixed])`);
  await page.click('#go');
  await expect(page.locator('#mTitle')).toHaveText(L.T.readyTitle);
  await page.locator('#modal [data-close]').first().click();
  await expect(page.locator('#modal')).toBeHidden();
}
export const tidied = (page, L) => expect(page.locator('#docMeta')).not.toContainText(L.T.polishing);   // paragraphs and summary have arrived

// ---- API flows ----
export async function waitJob(request, id, until = j => j.status === 'done' || j.status === 'error') {
  let job;
  await expect.poll(async () => { job = await (await request.get('/api/jobs/' + id)).json(); return until(job); }, { intervals: [300] }).toBe(true);
  return job;
}
export const gone = (request, id) => expect.poll(async () => (await request.get('/api/jobs/' + id)).status()).toBe(404);
export const sign = raw => crypto.createHmac('sha256', 'e2e-secret').update(raw).digest('hex');   // the secret e2e/stack.mjs sets
