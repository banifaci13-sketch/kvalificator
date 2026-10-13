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
import { createMediaplans } from '../src/mediaplan/store.js';
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
  assert.deepEqual(calcRow({ model: 'cpc', budget: 300000, cpc: 60, ctr: 5, cr: 4 }), { budget: 300000, impressions: 100000, clicks: 5000, leads: 200, cpc: 60, cpl: 1500 });
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
  assert.match(workbook, /name="Сводка"/);
  assert.match(workbook, /name="Оптимальный"/);
  assert.match(workbook, /fullCalcOnLoad="1"/);
  const sheet = await zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(sheet, /<f>SUM\(C5:C6\)<\/f>/, 'итоги — формулами, а не числами');
  assert.match(sheet, /'Допущения'!\$B\$4/, 'период берётся с листа допущений');

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
