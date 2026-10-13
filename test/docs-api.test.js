import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { loadBrand } from '../src/brand/index.js';
import { createDocLibrary } from '../src/docs/library.js';
import { closeBrowser } from '../src/docs/browser.js';
import { rules, staticSource, silentLog, typicalAnswers } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
const brand = loadBrand();

async function setup() {
  const config = loadConfig({ DB_PATH: ':memory:' });
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna', 'Анна Сорокина', { password: PASSWORD, role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: PASSWORD, role: 'manager' });
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog });
  const library = createDocLibrary({ db: db.raw, brand, templatesDir: resolve(config.root, 'templates/decks'), dataDir: mkdtempSync(join(tmpdir(), 'docs-')) });
  const app = await buildServer({
    config, qualifier, logger: false, brand,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), library, brand },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  };
  return { app, qualifier, as };
}

async function makeLead(qualifier) {
  const { session } = qualifier.startSession({ channel: 'web' });
  let reply = qualifier.resume(session);
  while (reply.type === 'question') {
    const { id, required } = reply.step;
    reply = await qualifier.answer(session.id, id in typicalAnswers ? { value: typicalAnswers[id] } : { skip: !required });
  }
}

test('документ из шаблона КП по заявке: подстановка, превью слайда, правка', async () => {
  const { qualifier, as } = await setup();
  await makeLead(qualifier);
  const req = await as('anna');
  const leads = (await req({ url: '/admin/api/leads' })).json().leads;
  const lead = leads[0];

  const types = (await req({ url: '/admin/api/slide-types' })).json();
  assert.ok(types.types.find((t) => t.type === 'mediaplan').fields.some((f) => f.type === 'repeater'));
  assert.ok(Array.isArray(types.empty.kpi.kpis), 'у пустого слайда KPI есть список показателей');

  const created = await req({ method: 'POST', url: '/admin/api/documents', payload: { templateId: 'builtin:kp', leadId: lead.id } });
  assert.equal(created.statusCode, 200);
  const doc = created.json().document;
  const text = JSON.stringify(doc.spec);
  assert.ok(text.includes(lead.answers.company.raw ?? lead.answers.company), 'клиент из заявки');
  assert.ok(text.includes('Анна Сорокина'), 'менеджер — текущий сотрудник');
  assert.ok(!text.includes('{{client}}'));

  const preview = await req({ url: `/admin/api/documents/${doc.id}/preview?slide=0` });
  assert.equal(preview.statusCode, 200);
  assert.match(preview.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal((preview.body.match(/class="slide"/g) ?? []).length, 1, 'превью одного слайда');

  // недозаполненный слайд не роняет превью
  const spec = structuredClone(doc.spec);
  spec.slides.push({ type: 'mediaplan', title: 'Пусто' });
  const put = await req({ method: 'PUT', url: `/admin/api/documents/${doc.id}`, payload: { title: 'КП', spec } });
  assert.equal(put.statusCode, 200);
  const broken = await req({ url: `/admin/api/documents/${doc.id}/preview?slide=${spec.slides.length - 1}` });
  assert.equal(broken.statusCode, 200);
  assert.match(broken.body, /Слайд не собран/);

  const docs = (await req({ url: `/admin/api/leads/${lead.id}/documents` })).json().documents;
  assert.equal(docs.length, 1);
});

test('выгрузку с заготовками останавливает проверка; черновик — только администратору', async () => {
  const { as } = await setup();
  const anna = await as('anna');
  const oleg = await as('oleg');
  const doc = (await anna({ method: 'POST', url: '/admin/api/documents', payload: { templateId: 'builtin:mediaplan', values: { client: 'Ромашка' } } })).json().document;

  const blocked = await oleg({ method: 'POST', url: `/admin/api/documents/${doc.id}/export`, payload: { format: 'html', force: true } });
  assert.equal(blocked.statusCode, 422);
  assert.equal(blocked.json().canForce, false);
  assert.ok(blocked.json().qa.errors.some((e) => /заготовка/.test(e)));

  const draft = await anna({ method: 'POST', url: `/admin/api/documents/${doc.id}/export`, payload: { format: 'html', force: true } });
  assert.equal(draft.statusCode, 200);
  const file = await anna({ url: `/admin/api/exports/${draft.json().exportId}` });
  assert.equal(file.statusCode, 200);
  assert.match(file.headers['content-disposition'], /attachment/);
  const info = (await anna({ url: `/admin/api/documents/${doc.id}` })).json();
  assert.equal(info.exports[0].forced, true);
  await closeBrowser();
});

test('свой шаблон из документа сохраняет подписи переменных; правка шаблона без подстановки', async () => {
  const { as } = await setup();
  const req = await as('anna');
  const raw = (await req({ method: 'POST', url: '/admin/api/documents', payload: { templateId: 'builtin:kp', keepVariables: true } })).json().document;
  const rawText = JSON.stringify(raw.spec);
  assert.ok(rawText.includes('{{client}}') && rawText.includes('{{date}}'), 'переменные не подставлены');

  const saved = await req({ method: 'POST', url: '/admin/api/templates', payload: { name: 'Наше КП', fromDocument: raw.id } });
  assert.equal(saved.statusCode, 200);
  const tpl = saved.json().template;
  assert.equal(tpl.variables.find((v) => v.key === 'manager_contacts').label, 'Контакты менеджера');

  const replaced = await req({ method: 'PUT', url: `/admin/api/templates/${tpl.id}`, payload: { spec: raw.spec } });
  assert.equal(replaced.json().template.variables.find((v) => v.key === 'client').label, 'Клиент');
  assert.equal((await req({ method: 'DELETE', url: '/admin/api/templates/builtin:kp' })).statusCode, 400);
});

test('копия документа: те же слайды и шаблон', async () => {
  const { as } = await setup();
  const req = await as('anna');
  const doc = (await req({ method: 'POST', url: '/admin/api/documents', payload: { templateId: 'builtin:kp', values: { client: 'Таллер' } } })).json().document;
  const copy = (await req({ method: 'POST', url: `/admin/api/documents/${doc.id}/copy`, payload: {} })).json().document;
  assert.equal(copy.title, `${doc.title} (копия)`);
  assert.equal(copy.template, 'builtin:kp');
  assert.deepEqual(copy.spec, doc.spec);
});
