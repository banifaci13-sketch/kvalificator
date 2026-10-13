// Сборка презентации: проверка → HTML / PDF / PPTX + манифест (версия бренда, ассеты, итоги проверки).

import { createHash } from 'node:crypto';
import { renderDeckHtml } from './render-html.js';
import { renderDeckPptx } from './render-pptx.js';
import { runQa } from './qa.js';
import { withPage } from './browser.js';

export const FORMATS = ['pdf', 'pptx', 'html'];

export class QaError extends Error {
  constructor(qa) {
    super(`Проверка не пройдена: ${qa.errors.length} ошибок`);
    this.qa = qa;
  }
}

/**
 * Возвращает { qa, files: { pdf?: Buffer, pptx?: Buffer, html?: Buffer }, manifest }.
 * При ошибках проверки бросает QaError — экспорт с ошибками только с force (для черновиков).
 */
export async function buildDeck(deck, brand, { formats = FORMATS, force = false } = {}) {
  const qa = await runQa(deck, brand);
  if (!qa.ok && !force) throw new QaError(qa);

  const files = {};
  if (formats.includes('html')) files.html = Buffer.from(renderDeckHtml(deck, brand, { mode: 'screen' }));
  if (formats.includes('pdf')) files.pdf = await renderPdf(deck, brand);
  if (formats.includes('pptx')) files.pptx = await renderDeckPptx(deck, brand);

  const manifest = {
    title: deck.meta?.title ?? null,
    slides: deck.slides.length,
    generatedAt: new Date().toISOString(),
    brand: {
      label: brand.label,
      version: brand.version,
      status: brand.status,
      logo: brand.logo.onLight ? { file: brand.logo.onLight.file, sha256: brand.logo.onLight.sha256 } : 'текстовая подпись',
      fonts: [brand.typography.heading.family, brand.typography.body.family],
    },
    sources: [...new Set(deck.slides.map((s) => s.source).filter(Boolean))],
    qa: { ok: qa.ok, errors: qa.errors, warnings: qa.warnings, forced: !qa.ok },
    files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, { bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') }])),
  };
  return { qa, files, manifest };
}

export async function renderPdf(deck, brand) {
  const html = renderDeckHtml(deck, brand, { mode: 'print' });
  return withPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({ width: `${brand.slide.width}px`, height: `${brand.slide.height}px`, printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  });
}

/** PNG-превью одного слайда (для админки и визуальной проверки). */
export async function renderSlidePng(deck, brand, index) {
  const html = renderDeckHtml(deck, brand, { mode: 'print', only: [index] });
  return withPage(
    async (page) => {
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      return page.locator('.slide').first().screenshot({ type: 'png' });
    },
    { viewport: { width: brand.slide.width, height: brand.slide.height } },
  );
}
