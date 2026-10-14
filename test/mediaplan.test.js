import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { loadBrand } from '../src/brand/index.js';
import { createDocLibrary } from '../src/docs/library.js';
import { checkContent } from '../src/docs/qa.js';
import { calcRow, calcScenario, emptyPlan } from '../src/mediaplan/calc.js';
import { createMediaplans, validatePlan } from '../src/mediaplan/store.js';
import { mediaplanXlsx } from '../src/mediaplan/xlsx.js';
import { mediaplanSheetHtml } from '../src/mediaplan/sheet.js';
import { chromiumPath, closeBrowser } from '../src/docs/browser.js';

const hasChromium = (() => {
  try {
    return Boolean(chromiumPath());
  } catch {
    return false;
  }
})();
import { rules, staticSource, silentLog } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
const brand = loadBrand();

const plan = () => ({
  months: 3,
  settings: { agencyFee: 15, vat: 22, saleRate: 20, avgCheck: 50000 },
  assumptions: 'Средний чек — по данным клиента.',
  scenarios: [
    {
      name: 'Оптимальный',
      rows: [
        { channel: 'Яндекс Директ, поиск', model: 'cpc', budget: 300000, cpc: 60, ctr: 5, cr: 4 },
        { channel: 'РСЯ', model: 'cpm', budget: 150000, cpm: 200, ctr: 0.8, cr: 2 },
      ],
    },
    { name: 'Минимальный', rows: [{ channel: 'Поиск', model: 'cpc', budget: 100000, cpc: 50, ctr: 4, cr: 3 }] },
  ],
});

async function setup() {
  const config = loadConfig({ DB_PATH: ':memory:' });
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna', 'Анна Сорокина', { password: PASSWORD, role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: PASSWORD, role: 'manager' });
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog });
  const library = createDocLibrary({ db: db.raw, brand, templatesDir: resolve(config.root, 'templates/decks'), dataDir: mkdtempSync(join(tmpdir(), 'mp-')) });
  const mediaplans = createMediaplans({ db: db.raw, library });
  const app = await buildServer({
    config, qualifier, logger: false, brand,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), library, brand, mediaplans },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  };
  return { app, as, library };
}

test('расчёт: клики и показы по модели закупки, пустые данные — не ноль', () => {
  assert.deepEqual(calcRow({ model: 'cpc', budget: 300000, cpc: 60, ctr: 5, cr: 4 }), { budget: 300000, net: 300000, gross: 300000, impressions: 100000, clicks: 5000, leads: 200, cpc: 60, cpl: 1500 });
  const cpm = calcRow({ model: 'cpm', budget: 150000, cpm: 200, ctr: 0.8, cr: 2 });
  assert.equal(cpm.impressions, 750000);
  assert.equal(Math.round(cpm.clicks), 6000);
  assert.equal(Math.round(cpm.leads), 120);
  const empty = calcRow({ model: 'cpc', budget: 10000 });
  assert.equal(empty.clicks, null);
  assert.equal(empty.leads, null);

  const { month, period } = calcScenario(plan().scenarios[0], plan());
  assert.equal(month.budget, 450000);
  assert.equal(Math.round(month.leads), 320);
  assert.equal(period.media, 1350000);
  assert.equal(period.fee, 202500);
  assert.equal(Math.round(period.vat), 341550);
  assert.equal(Math.round(period.total), 1894050);
  assert.equal(Math.round(period.leads), 960);
  assert.equal(Math.round(period.revenue), 9600000);
  assert.ok(Math.abs(period.drr - 1894050 / 9600000) < 1e-9);
  assert.equal(emptyPlan().scenarios.length, 1);
});

test('медиаплан: создание, Excel с формулами, проверка ввода', async () => {
  const { as } = await setup();
  const req = await as('oleg');
  const bad = await req({ method: 'POST', url: '/admin/api/mediaplans', payload: { title: 'x', spec: { ...plan(), months: 0 } } });
  assert.equal(bad.statusCode, 400);
  const badPct = await req({ method: 'POST', url: '/admin/api/mediaplans', payload: { title: 'x', spec: { ...plan(), settings: { vat: 120 } } } });
  assert.match(badPct.json().error, /НДС/);

  const created = await req({ method: 'POST', url: '/admin/api/mediaplans', payload: { title: 'Медиаплан Ромашка', client: 'ООО Ромашка', spec: plan() } });
  assert.equal(created.statusCode, 200);
  const id = created.json().mediaplan.id;
  const list = (await req({ url: '/admin/api/mediaplans' })).json().mediaplans;
  assert.equal(Math.round(list[0].total), 1894050);

  const file = await req({ url: `/admin/api/mediaplans/${id}/xlsx` });
  assert.equal(file.statusCode, 200);
  assert.match(file.headers['content-disposition'], /attachment/);
  const zip = await JSZip.loadAsync(file.rawPayload);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const sheetOrder = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sheetOrder, ['Оптимальный', 'Минимальный', 'Сводка', 'Допущения'], 'первым открывается сам медиаплан');
  assert.match(workbook, /fullCalcOnLoad="1"/);
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /<f>SUM\(H3:H4\)<\/f><v>450000<\/v>/, 'итоги — формулами, рядом готовое значение');
  assert.match(sheet, /'Допущения'!\$C\$3/, 'период берётся с листа допущений');
  assert.match(sheet, /<drawing r:id="rId1"\/>/, 'в шапке — утверждённый логотип агентства');
  assert.ok(zip.file('xl/media/logo.png'));
  assert.match(sheet, /<c r="A2" s="\d+" t="inlineStr"><is><t xml:space="preserve">Площадка/, 'шапка таблицы — сразу во второй строке');

  const calcJs = await req({ url: '/admin/lib/mediaplan-calc.js' });
  assert.equal(calcJs.statusCode, 200);
  assert.match(calcJs.headers['content-type'], /javascript/);
});

test('нормативы: меняет только администратор и только с основанием', async () => {
  const { as } = await setup();
  const anna = await as('anna');
  const oleg = await as('oleg');
  const payload = { channel: 'Яндекс Директ, поиск', model: 'cpc', cpc: 55, ctr: 6, cr: 3.5, note: 'Среднее по 12 кампаниям недвижимости, янв–сен 2026' };
  assert.equal((await oleg({ method: 'POST', url: '/admin/api/benchmarks', payload })).statusCode, 403);
  const noNote = await anna({ method: 'POST', url: '/admin/api/benchmarks', payload: { ...payload, note: ' ' } });
  assert.equal(noNote.statusCode, 400);
  const noRate = await anna({ method: 'POST', url: '/admin/api/benchmarks', payload: { ...payload, cpc: null } });
  assert.match(noRate.json().error, /CPC/);
  const ok = await anna({ method: 'POST', url: '/admin/api/benchmarks', payload });
  assert.equal(ok.statusCode, 200);
  assert.equal((await oleg({ url: '/admin/api/benchmarks' })).json().benchmarks.length, 1);
});

test('медиаплан в презентацию: новый документ без заготовок и слайд в существующий', async () => {
  const { as, library } = await setup();
  const req = await as('anna');
  const id = (await req({ method: 'POST', url: '/admin/api/mediaplans', payload: { title: 'Медиаплан Ромашка', client: 'ООО Ромашка', spec: plan() } })).json().mediaplan.id;

  const res = await req({ method: 'POST', url: `/admin/api/mediaplans/${id}/to-document`, payload: { scenario: 1 } });
  assert.equal(res.statusCode, 200);
  const doc = res.json().document;
  assert.deepEqual(doc.spec.slides.map((s) => s.type), ['cover', 'kpi', 'mediaplan', 'closing']);
  const mp = doc.spec.slides[2];
  assert.equal(mp.title, 'Медиаплан по каналам: Минимальный');
  assert.deepEqual(mp.rows, [{ channel: 'Поиск', budget: 300000, impressions: 150000, clicks: 6000, leads: 180 }]);
  assert.equal(mp.dataStatus, 'forecast');
  const content = checkContent(doc.spec, brand);
  assert.deepEqual(content.errors, [], 'документ из медиаплана проходит проверку содержания');

  const target = library.createDocument({ spec: { meta: {}, slides: [{ type: 'cover', title: 'Отчёт' }] } }, 'Анна');
  const appended = await req({ method: 'POST', url: `/admin/api/mediaplans/${id}/to-document`, payload: { scenario: 0, documentId: target.id } });
  assert.deepEqual(appended.json().document.spec.slides.map((s) => s.type), ['cover', 'kpi', 'mediaplan']);
});

test('интернет-магазин: расчёт совпадает с медиапланом агентства (SberAds)', () => {
  // строки из рабочего медиаплана агентства: бюджет с НДС 22 %, CPC без НДС, CR1 и CR2 — от кликов
  const plan = {
    kind: 'ecom',
    months: 1,
    settings: { vat: 22, budgetWithVat: true, avgCheck: 5500 },
    scenarios: [{
      name: 'Основной',
      rows: [
        { channel: 'SberAds', targeting: 'Покупают посуду и кухонные принадлежности', model: 'cpc', budget: 20000, cpc: 33, cart: 15, sale: 1.85 },
        { channel: 'SberAds', targeting: 'Интересуются правильным питанием', model: 'cpc', budget: 10000, cpc: 33, cart: 15, sale: 1.75 },
        { channel: 'SberAds', targeting: 'Здоровый образ жизни\nФитнес\nФитнес-клубы', model: 'cpc', budget: 10000, cpc: 33, cart: 15, sale: 1.6 },
        { channel: 'SberAds', targeting: 'Обустройство жилища\nТовары для дома', model: 'cpc', budget: 10000, cpc: 33, cart: 15, sale: 1.6 },
      ],
    }],
  };
  const { rows, month, period } = calcScenario(plan.scenarios[0], plan);
  const r = rows[0];
  assert.equal(r.net.toFixed(2), '16393.44', 'стоимость без НДС');
  assert.equal(Math.round(r.clicks), 497);
  assert.equal(Math.round(r.carts), 75);
  assert.equal(r.cpa.toFixed(2), '268.40', 'цена корзины');
  assert.equal(Math.round(r.cps), 2176, 'цена продажи');
  assert.equal(r.revenue.toFixed(2), '50546.45');
  assert.equal((r.drr * 100).toFixed(2), '39.57');
  assert.equal((rows[1].drr * 100).toFixed(2), '41.83');
  assert.equal((rows[2].drr * 100).toFixed(2), '45.75');
  assert.equal(month.gross, 50000);
  assert.equal(month.net.toFixed(2), '40983.61');
  assert.equal(Math.round(month.clicks), 1242);
  assert.equal(Math.round(month.carts), 186);
  assert.equal(month.revenue.toFixed(2), '118169.40');
  assert.equal((month.drr * 100).toFixed(1), '42.3');
  assert.equal(Math.round(period.total), 50000, 'к оплате без комиссии = бюджет с НДС');
});

test('интернет-магазин: слайды и Excel', async () => {
  const { as } = await setup();
  const req = await as('anna');
  const spec = {
    kind: 'ecom', months: 2, settings: { vat: 22, budgetWithVat: true, avgCheck: 5500 },
    scenarios: [{ name: 'Основной', rows: [{ channel: 'SberAds', targeting: 'Посуда\nКухня', model: 'cpc', budget: 20000, cpc: 33, cart: 15, sale: 1.85 }] }],
  };
  const id = (await req({ method: 'POST', url: '/admin/api/mediaplans', payload: { title: 'E-com', client: 'Магазин посуды', spec } })).json().mediaplan.id;
  const doc = (await req({ method: 'POST', url: `/admin/api/mediaplans/${id}/to-document`, payload: {} })).json().document;
  const ecom = doc.spec.slides.find((s) => s.type === 'ecomplan');
  assert.deepEqual(ecom.rows, [{ channel: 'SberAds', budget: 40000, targeting: 'Посуда, Кухня', clicks: 994, carts: 149, sales: 18, revenue: 101093 }]);
  assert.deepEqual(checkContent(doc.spec, brand).errors, []);
  const file = await req({ url: `/admin/api/mediaplans/${id}/xlsx` });
  const zip = await JSZip.loadAsync(file.rawPayload);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  assert.doesNotMatch(workbook, /name="Сводка"/, 'один сценарий — без сводки');
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /CR1 \(в корзину\)/);
  // колонки — как в медиапланах агентства: площадка, таргетинг, клики, CPC, стоимость без и с НДС…
  const heads = [...sheet.matchAll(/<c r="([A-Z]+)2" s="\d+" t="inlineStr"><is><t xml:space="preserve">([^<]+)</g)].map((m) => m[2]);
  assert.deepEqual(heads, ['Площадка', 'Тип размещения, кампания, таргетинг', 'Клики', 'CPC', 'Стоимость без НДС', 'Стоимость с НДС', 'CR1 (в корзину)', 'Кол-во корзин', 'CPA (цена доб. в корз.)', 'CR2 (конверсия в продажу)', 'Кол-во продаж', 'CPS (цена продажи)', 'Ср. чек', 'Выручка', 'ДРР']);
  const drr = sheet.match(/<c r="O3" s="\d+"><f>IF\(N3&gt;0,F3\/N3,0\)<\/f><v>([\d.]+)<\/v>/);
  assert.ok(drr, 'ДРР по строке — формулой');
  assert.equal((Number(drr[1]) * 100).toFixed(2), '39.57', 'готовое значение видно и без пересчёта');
  assert.match(sheet, /<f>'Допущения'!\$C\$8<\/f><v>5500<\/v>/, 'средний чек по умолчанию — ссылкой на допущения');
});

test('комиссия агентства: процент и фиксированная часть в месяц', () => {
  const plan = {
    kind: 'leads', months: 3, settings: { agencyFee: 10, agencyFixed: 25000, vat: 22 },
    scenarios: [{ name: 'Основной', rows: [{ channel: 'Поиск', model: 'cpc', budget: 100000, cpc: 50, cr: 5 }] }],
  };
  const { period } = calcScenario(plan.scenarios[0], plan);
  assert.equal(period.media, 300000);
  assert.equal(period.fee, 30000 + 75000, '10 % от медиабюджета + 25 000 ₽ × 3 месяца');
  assert.equal(Math.round(period.vat), Math.round((300000 + 105000) * 0.22));
  assert.throws(() => validatePlan({ ...plan, settings: { agencyFixed: -1 } }), /Фиксированная комиссия/);
});

test('Excel: логотип бренда в шапке, если он утверждён', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000c800000032080200000000000000', 'hex');
  const spec = { kind: 'leads', months: 1, settings: { agencyFixed: 10000 }, scenarios: [{ name: 'Основной', rows: [{ channel: 'Поиск', model: 'cpc', budget: 100000, cpc: 50, cr: 5 }] }] };
  const buf = await mediaplanXlsx({ title: 'План', client: 'Клиент', spec }, { logo: png });
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file('xl/media/logo.png'), 'логотип — оригинальный файл');
  const drawing = await zip.file('xl/drawings/drawing1.xml').async('string');
  assert.match(drawing, /cx="2133600" cy="533400"/, 'пропорции 200×50 сохранены: 224×56 px');
  const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /<drawing r:id="rId1"\/>/);
  assert.ok(zip.file('xl/drawings/drawing2.xml'), 'у каждого листа своя рисовалка');
  assert.doesNotMatch(sheet, />SOROKA</, 'с логотипом текстовая подпись не нужна');
  assert.match(sheet, /\$C\$5\*C/, 'фиксированная комиссия входит в формулу');
});

test('медиаплан в PDF и картинках: тот же вид, что Excel', { skip: !hasChromium && 'нет Chromium' }, async () => {
  const { as } = await setup();
  const req = await as('anna');
  const spec = {
    kind: 'ecom', months: 2, settings: { vat: 22, budgetWithVat: true, avgCheck: 5500 },
    scenarios: [
      { name: 'Основной', rows: [{ channel: 'SberAds', targeting: 'Посуда', model: 'cpc', budget: 20000, cpc: 33, cart: 15, sale: 1.85 }] },
      { name: 'Максимум', rows: [{ channel: 'SberAds', targeting: 'Посуда', model: 'cpc', budget: 40000, cpc: 33, cart: 15, sale: 1.85 }] },
    ],
  };
  const id = (await req({ method: 'POST', url: '/admin/api/mediaplans', payload: { title: 'Таллер МП', client: 'Таллер', spec } })).json().mediaplan.id;

  const html = mediaplanSheetHtml({ title: 'Таллер МП', client: 'Таллер', spec }, { brand, logo: brand.logo.onLight.dataUri });
  assert.match(html, /Медиаплан: Таллер — Основной/);
  assert.match(html, /16\s393,44\s₽/, 'цифры — как в Excel');
  assert.match(html, /сравнение сценариев/);
  assert.doesNotMatch(html, /(src|href)="https?:/, 'страница самодостаточная');

  const pdf = await req({ url: `/admin/api/mediaplans/${id}/export?format=pdf` });
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
  const png = await req({ url: `/admin/api/mediaplans/${id}/export?format=png&scenario=1` });
  assert.equal(png.rawPayload.subarray(1, 4).toString(), 'PNG');
  assert.match(decodeURIComponent(png.headers['content-disposition']), /Максимум/, 'в имени картинки — сценарий');
  const jpg = await req({ url: `/admin/api/mediaplans/${id}/export?format=jpg` });
  assert.equal(jpg.rawPayload[0], 0xff);
  assert.equal((await req({ url: `/admin/api/mediaplans/${id}/export?format=gif` })).statusCode, 400);
  await closeBrowser();
});

test('копия медиаплана: те же расчёты, своё название; удаление', async () => {
  const { as } = await setup();
  const req = await as('oleg');
  const id = (await req({ method: 'POST', url: '/admin/api/mediaplans', payload: { title: 'Таллер МП', client: 'Таллер', spec: plan() } })).json().mediaplan.id;
  const copy = (await req({ method: 'POST', url: `/admin/api/mediaplans/${id}/copy`, payload: {} })).json().mediaplan;
  assert.equal(copy.title, 'Таллер МП (копия)');
  assert.equal(copy.client, 'Таллер');
  assert.notEqual(copy.id, id);
  assert.deepEqual(copy.spec, (await req({ url: `/admin/api/mediaplans/${id}` })).json().mediaplan.spec);
  assert.equal((await req({ method: 'DELETE', url: `/admin/api/mediaplans/${copy.id}` })).statusCode, 200);
  assert.equal((await req({ url: '/admin/api/mediaplans' })).json().mediaplans.length, 1);
});

test('площадка с разбивкой на кампании: группы, итоги по площадкам в Excel, PDF и на слайде', async () => {
  const { channelGroups, byChannel, rowLabel } = await import('../src/mediaplan/calc.js');
  const rows = [
    { channel: 'Яндекс Директ', campaign: 'Поиск', model: 'cpc', budget: 100000, cpc: 50, cr: 5 },
    { channel: 'Яндекс Директ', campaign: 'РСЯ', model: 'cpc', budget: 50000, cpc: 20, cr: 1 },
    { channel: 'VK Реклама', model: 'cpc', budget: 30000, cpc: 30, cr: 2 },
  ];
  const spec = { ...emptyPlan(), months: 3, scenarios: [{ name: 'Основной', rows }] };
  assert.deepEqual(channelGroups(rows).map((g) => [g.channel, g.from, g.to]), [['Яндекс Директ', 0, 1], ['VK Реклама', 2, 2]]);
  const direct = byChannel(spec.scenarios[0], spec)[0];
  assert.deepEqual([direct.channel, direct.count, direct.month.budget, direct.month.clicks, direct.month.leads], ['Яндекс Директ', 2, 150000, 4500, 125]);
  assert.equal(rowLabel(rows[1]), 'Яндекс Директ — РСЯ');
  validatePlan(spec);

  // Excel: кампания в колонке «Тип размещения…», ячейка площадки объединена, итог по площадке — суммой строк группы
  const xlsx = await mediaplanXlsx({ title: 'МП', client: 'Таллер', spec });
  const sheet = await (await JSZip.loadAsync(xlsx)).file('xl/worksheets/sheet1.xml').async('string');
  assert.match(sheet, /<mergeCell ref="A3:A4"\/>/);
  assert.match(sheet, />РСЯ</);
  assert.match(sheet, /По площадкам, в месяц/);
  assert.match(sheet, /Яндекс Директ \(2\)/);
  assert.match(sheet, /<f>SUM\(C3,C4\)<\/f><v>4500<\/v>/, 'клики площадки — сумма её строк');

  // PDF и картинки: та же таблица с блоком «По площадкам»
  const html = mediaplanSheetHtml({ title: 'МП', client: 'Таллер', spec });
  assert.match(html, /rowspan="2"/);
  assert.match(html, /По площадкам, в месяц/);

  // слайд: до 8 строк — каждая кампания отдельно; больше — итоги по площадкам
  const { library } = await setupLibrary();
  const mp = createMediaplans({ db: library.db, library: library.lib });
  const few = mp.slidesFor({ title: 'МП', client: 'Таллер', spec }, 0).find((s) => s.type === 'mediaplan');
  assert.deepEqual(few.rows.map((r) => r.channel), ['Яндекс Директ — Поиск', 'Яндекс Директ — РСЯ', 'VK Реклама']);
  const many = { ...spec, scenarios: [{ name: 'Основной', rows: [...Array.from({ length: 8 }, (_, i) => ({ channel: 'Яндекс Директ', campaign: `Кампания ${i + 1}`, model: 'cpc', budget: 10000, cpc: 20, cr: 2 })), rows[2]] }] };
  const agg = mp.slidesFor({ title: 'МП', client: 'Таллер', spec: many }, 0).find((s) => s.type === 'mediaplan');
  assert.deepEqual(agg.rows.map((r) => r.channel), ['Яндекс Директ (8 кампаний)', 'VK Реклама']);
});

async function setupLibrary() {
  const db = openDb(':memory:');
  const lib = createDocLibrary({ db: db.raw, brand, templatesDir: resolve('templates/decks'), dataDir: mkdtempSync(join(tmpdir(), 'mp-')) });
  return { library: { db: db.raw, lib } };
}
