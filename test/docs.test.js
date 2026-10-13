import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBrand } from '../src/brand/index.js';
import { checkContent, runQa } from '../src/docs/qa.js';
import { renderDeckHtml } from '../src/docs/render-html.js';
import { renderDeckPptx } from '../src/docs/render-pptx.js';
import { buildDeck, QaError } from '../src/docs/build.js';
import { chromiumPath, closeBrowser } from '../src/docs/browser.js';

const brand = loadBrand();
const demo = JSON.parse(readFileSync(new URL('../examples/decks/demo.json', import.meta.url), 'utf8'));
const hasChromium = (() => { try { return Boolean(chromiumPath()); } catch { return false; } })();

test.after(() => closeBrowser());

test('демо-презентация проходит проверку содержания', () => {
  const { errors } = checkContent(demo, brand);
  assert.deepEqual(errors, []);
});

test('проверка ловит заготовки, цифры без источника, неподтверждённые кейсы и кривые данные графика', () => {
  const deck = {
    slides: [
      { type: 'kpi', title: 'Цели {{client}}', kpis: [{ value: '1', label: 'x' }], dataStatus: 'forecast' },
      { type: 'case', title: 'Кейс', client: 'К', task: 'т', solution: ['р'], results: [{ value: '1', label: 'x' }], source: 'CRM' },
      { type: 'chart', title: 'Г', takeaway: 'в', source: 'Метрика', dataStatus: 'fact', chart: { categories: ['a', 'b'], series: [{ name: 's', values: [1] }] } },
      { type: 'nope', title: 'x' },
    ],
  };
  const { errors } = checkContent(deck, brand);
  const text = errors.join('\n');
  assert.match(text, /Слайд 1: не заполнено «Источник»/);
  assert.match(text, /Слайд 1: осталась заготовка «\{\{client\}\}»/);
  assert.match(text, /Слайд 2: кейс не подтверждён/);
  assert.match(text, /Слайд 3: ряд «s»: значений 1, категорий 2/);
  assert.match(text, /Слайд 4: неизвестный тип/);
});

test('HTML самодостаточный: шрифты встроены, внешних ссылок нет, подпись вместо неутверждённого логотипа', () => {
  const html = renderDeckHtml(demo, brand);
  assert.equal((html.match(/class="slide"/g) ?? []).length, demo.slides.length);
  assert.match(html, /@font-face\{font-family:'Manrope';src:url\(data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /(src|href)="https?:/);
  assert.match(html, /SOROKA MARKETING/);
});

test('PPTX собирается: заголовки в плейсхолдерах, нативные графики и таблицы', async () => {
  const buf = await renderDeckPptx(demo, brand);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const zip = buf.toString('latin1');
  assert.match(zip, /ppt\/charts\/chart\d+\.xml/);
  assert.ok(buf.length > 30_000);
});

test('экспорт с ошибками останавливается, черновик — только принудительно', { skip: !hasChromium && 'нет Chromium' }, async () => {
  const bad = { slides: [{ type: 'kpi', title: 'Цели', kpis: [{ value: '1', label: 'x' }], dataStatus: 'forecast' }] };
  await assert.rejects(buildDeck(bad, brand, { formats: ['pptx'] }), QaError);
  const forced = await buildDeck(bad, brand, { formats: ['pptx'], force: true });
  assert.equal(forced.manifest.qa.forced, true);
  assert.ok(forced.files.pptx.length > 0);
});

test('проверка вёрстки ловит не помещающийся текст', { skip: !hasChromium && 'нет Chromium' }, async () => {
  const long = 'Очень длинный заголовок, который никак не помещается в две строки на слайде и продолжает тянуться дальше и дальше без конца';
  const deck = { slides: [{ type: 'strategy', title: long, pillars: [{ title: 'А', text: 'б' }, { title: 'В', text: 'г' }] }] };
  const qa = await runQa(deck, brand);
  assert.ok(qa.errors.some((e) => /текст не помещается в блок «title»/.test(e)), qa.errors.join('\n'));
});

test('демо-презентация проходит проверку вёрстки', { skip: !hasChromium && 'нет Chromium' }, async () => {
  const qa = await runQa(demo, brand);
  assert.deepEqual(qa.errors, []);
});
