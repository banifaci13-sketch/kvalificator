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

test('HTML самодостаточный: шрифты и утверждённый логотип встроены, внешних ссылок нет', () => {
  const html = renderDeckHtml(demo, brand);
  assert.equal((html.match(/class="slide"/g) ?? []).length, demo.slides.length);
  assert.match(html, /@font-face\{font-family:'Manrope';src:url\(data:font\/woff2;base64,/);
  assert.doesNotMatch(html, /(src|href)="https?:/);
  // логотип — оригинальный файл с проверенным хешем, встроен в документ
  assert.match(html, new RegExp(`class="el logo"[^>]*data-sha="${brand.logo.onLight.sha256}" src="data:image/png;base64,`));
  assert.doesNotMatch(html, /data-el="wordmark"/, 'текстовая подпись нужна, только пока логотипа нет');
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

test('бриф: вопросы с полями для ответа, нумерация, раскладки; пустой вопрос — ошибка', async () => {
  const { readdirSync } = await import('node:fs');
  const { fillVariables } = await import('../src/docs/library.js');
  const dir = new URL('../templates/decks/', import.meta.url);
  const briefs = readdirSync(dir).filter((f) => f.startsWith('brief-'));
  assert.equal(briefs.length, 7);
  for (const f of briefs) {
    const t = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    assert.equal(t.group, 'brief', f);
    const spec = fillVariables(t.spec, { client: 'Таллер', date: '14 октября 2026', manager: 'Анна', manager_contacts: '+7 900 000-00-00' });
    assert.deepEqual(checkContent(spec, brand).errors, [], f);
  }
  const html = renderDeckHtml({ slides: [{ type: 'brief', title: 'Цели', layout: 'rows', start: 5, questions: [{ question: 'Бюджет в месяц', hint: 'С НДС или без', answer: '300 000 ₽' }, { question: 'Сроки', answer: '' }] }] }, brand);
  assert.match(html, /5\. Бюджет в месяц/);
  assert.match(html, /6\. Сроки/);
  assert.match(html, /300 000 ₽/);
  const bad = checkContent({ slides: [{ type: 'brief', title: 'Т', layout: 'rows', questions: [{ question: '' }, { question: 'a' }, { question: 'b' }, { question: 'c' }] }] }, brand);
  assert.match(bad.errors.join(' '), /вопрос 1: нет текста вопроса/);
  assert.match(bad.warnings.join(' '), /помещается 3 вопроса/);
  const pptx = await renderDeckPptx({ slides: [{ type: 'brief', title: 'Т', questions: [{ question: 'Кто ваш клиент?', hint: 'Пол, возраст' }] }] }, brand);
  assert.ok(pptx.length > 10_000);
});

test('бриф проходит проверку вёрстки', { skip: !hasChromium && 'нет Chromium' }, async () => {
  const t = JSON.parse(readFileSync(new URL('../templates/decks/brief-context.json', import.meta.url), 'utf8'));
  const { fillVariables } = await import('../src/docs/library.js');
  const spec = fillVariables(t.spec, { client: 'Таллер', date: '14 октября 2026', manager: 'Анна', manager_contacts: '+7 900 000-00-00' });
  spec.slides[2].questions[0].answer = 'Владельцы малого бизнеса 30–50 лет, решение принимает собственник; B2B';
  const { qa } = await buildDeck(spec, brand, { formats: ['pdf'] });
  assert.ok(qa);
});
