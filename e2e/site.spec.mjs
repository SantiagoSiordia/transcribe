// The site around the tool: every page in both languages, the language switch, docs, SEO files, phones, the owner's page.
import fs from 'node:fs';
import { test, expect, LOCALES, pages, strings } from './helpers.mjs';

const ORIGIN = 'http://127.0.0.1:3115';
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('every page is served in its language, with its heading and its counterpart linked', async ({ request }) => {
  expect(pages.length).toBeGreaterThanOrEqual(12);
  for (const p of pages) {
    const res = await request.get(p.path);
    expect(res.status(), p.path).toBe(200);
    const html = await res.text();
    expect(html, p.path).toContain(`<html lang="${p.lang}">`);
    expect(html, p.path).toContain(`<h1>${p.h1}</h1>`);
    expect(html, p.path).toContain(`<title>${esc(p.title)}</title>`);
    expect(html, p.path).toContain(`<link rel="canonical" href="${ORIGIN}${p.path}">`);
    const alt = pages.find(x => x.path === p.alt);
    expect(alt, `${p.path} has a page in the other language`).toBeTruthy();
    expect(alt.lang).not.toBe(p.lang);
    expect(html, p.path).toContain(`hreflang="${alt.lang}" href="${ORIGIN}${alt.path}"`);
    expect(html, `${p.path} left a placeholder unfilled`).not.toMatch(/\{\{\w+\}\}/);
  }
});

test('English and Spanish define the same strings', () => {
  const keys = l => Object.keys(strings[l]).filter(k => k !== 'errors').sort();
  expect(keys('es')).toEqual(keys('en'));
});

for (const [lang, L] of Object.entries(LOCALES)) {
  const other = lang === 'en' ? 'es' : 'en';

  test(`${lang}: the language switch goes to the same page in the other language`, async ({ page }) => {
    await page.goto(L.home);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.locator('.locale a[aria-current]')).toHaveText(lang.toUpperCase());
    await expect(page.locator('#go')).toHaveText(L.T.transcribe);
    await page.click(`.locale a[hreflang="${other}"]`);
    await expect(page).toHaveURL(ORIGIN + LOCALES[other].home);
    await expect(page.locator('html')).toHaveAttribute('lang', other);
    await expect(page.locator('#go')).toHaveText(LOCALES[other].T.transcribe);

    const inner = pages.find(p => p.lang === lang && p.path !== L.home && p.sections);   // a landing page keeps its counterpart too
    await page.goto(inner.path);
    await page.click(`.locale a[hreflang="${other}"]`);
    await expect(page).toHaveURL(ORIGIN + inner.alt);
  });

  test(`${lang}: questions are collapsed and open on click`, async ({ page }) => {
    await page.goto(L.home);
    const first = page.locator('.faq details').first();
    await expect(first).not.toHaveAttribute('open', '');
    await first.locator('summary').click();
    await expect(first.locator('p')).toBeVisible();
  });

  test(`${lang}: the page asks no other website for anything`, async ({ page }) => {
    const urls = [];
    page.on('request', r => urls.push(r.url()));
    await page.goto(L.home, { waitUntil: 'networkidle' });
    await page.click('#about');
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.filter(u => !u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
    test(`${lang}: nothing is wider than the screen`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('transcripts', JSON.stringify([{ id: 'p1', name: 'a-rather-long-recording-name-from-a-phone.m4a', at: Date.now(), language: 'es', duration: 75,
        segments: [{ start: 0, end: 4, text: 'Una frase bastante larga para comprobar que el texto se ajusta al ancho de la pantalla.' }] }])));
      await page.goto(L.home);
      await expect(page.locator('#docName')).toBeVisible();
      for (const v of ['stamps', 'paras', 'summary']) {
        await page.click(`#view [data-v="${v}"]`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `view ${v}`).toBeLessThanOrEqual(0);
      }
      await page.click('#about');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    });
  });
}

test('API docs show every endpoint', async ({ page }) => {
  await page.goto('/docs');
  const spec = JSON.parse(fs.readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  const operations = Object.values(spec.paths).flatMap(p => Object.keys(p).filter(k => ['get', 'post', 'delete', 'put', 'patch'].includes(k)));
  expect(operations.length).toBeGreaterThanOrEqual(5);
  await expect(page.locator('.opblock')).toHaveCount(operations.length);   // every operation in openapi.json is rendered
  await expect(page.locator('.opblock-summary-path', { hasText: '/api/transcribe' })).toBeVisible();
});

test('search engines get a sitemap of every page and are kept out of the API', async ({ request }) => {
  const map = await (await request.get('/sitemap.xml')).text();
  for (const p of pages) expect(map).toContain(`<loc>${ORIGIN}${p.path}</loc>`);
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Disallow: /api/');
  expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
});

test('the usage page is invisible without the owner key', async ({ request }) => {
  expect((await request.get('/stats')).status()).toBe(404);
  expect((await request.get('/stats?key=wrong')).status()).toBe(404);
  const res = await request.get('/stats?key=e2e-admin');
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('Transcribe usage');
});
