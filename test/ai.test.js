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
import { checkContent } from '../src/docs/qa.js';
import { createAi } from '../src/ai/client.js';
import { createMask, guardNumbers, allowedNumbers, cleanSlide } from '../src/ai/decks.js';
import { rules, staticSource, silentLog, typicalAnswers } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
const brand = loadBrand();

/** Подставная модель: запоминает запросы, отвечает заготовленным текстом. */
function fakeAi(reply) {
  const calls = [];
  return {
    calls,
    enabled: true,
    provider: 'test',
    model: 'fake',
    complete: async (req) => {
      calls.push(req);
      return { text: typeof reply === 'function' ? reply(req) : reply, usage: null };
    },
  };
}

async function setup(ai) {
  const config = loadConfig({ DB_PATH: ':memory:' });
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna', 'Анна Сорокина', { password: PASSWORD, role: 'admin' });
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog });
  const library = createDocLibrary({ db: db.raw, brand, templatesDir: resolve(config.root, 'templates/decks'), dataDir: mkdtempSync(join(tmpdir(), 'ai-')) });
  const app = await buildServer({
    config, qualifier, logger: false, brand,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), library, brand, ai },
  });
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'anna', password: PASSWORD } });
  const c = res.cookies.find((x) => x.name === 'kval_admin');
  const req = (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  return { req, db, qualifier, library };
}

async function makeLead(qualifier, patch = {}) {
  const answers = { ...typicalAnswers, ...patch };
  const { session } = qualifier.startSession({ channel: 'web' });
  let reply = qualifier.resume(session);
  while (reply.type === 'question') {
    const { id, required } = reply.step;
    reply = await qualifier.answer(session.id, id in answers ? { value: answers[id] } : { skip: !required });
  }
}

test('черновик по заявке: в модель не уходят имена и контакты, выдуманные цифры — в заготовки', async () => {
  const draft = {
    title: 'КП для {{client}}',
    slides: [
      { type: 'cover', title: 'Продвижение для {{client}}', subtitle: 'Коммерческое предложение', date: '{{date}}', extra: 'лишнее поле' },
      { type: 'kpi', title: 'Чего добьёмся', kpis: [{ value: '+47%', label: 'рост заявок' }, { value: '3 шага', label: 'до запуска' }] },
      { type: 'case', title: 'Кейс', client: 'Газпромбанк', task: 'Рост', verified: true },
      { type: 'unknown', title: 'Не наш тип' },
      { type: 'proposal', title: 'Стоимость', items: [{ name: 'Контекст', price: 150000 }] },
      { type: 'closing', title: 'Следующий шаг', steps: ['Созвон'], contacts: { name: '{{manager}}' } },
    ],
  };
  const ai = fakeAi('Вот черновик:\n```json\n' + JSON.stringify(draft) + '\n```');
  const { req, qualifier } = await setup(ai);
  await makeLead(qualifier, { company: 'ООО Северный дом', name: 'Мария', contact: '+7 912 345-67-89', task: 'Нужно больше заявок для ООО Северный дом из Казани, бюджет 300 000' });
  const lead = (await req({ url: '/admin/api/leads' })).json().leads[0];

  const res = await req({ method: 'POST', url: '/admin/api/ai/draft', payload: { kind: 'kp', leadId: lead.id, brief: 'Предлагаем контекст и SEO, звонить Марии +7 912 345-67-89', slides: 6 } });
  assert.equal(res.statusCode, 200, res.body);
  const sent = ai.calls[0].user + ai.calls[0].system;
  assert.doesNotMatch(sent, /Северный дом/, 'название клиента не уходит в модель');
  assert.doesNotMatch(sent, /912/, 'телефон не уходит в модель');
  assert.doesNotMatch(sent, /Мария/, 'имя контакта не уходит в модель');
  assert.match(sent, /\{\{client\}\}/);
  assert.match(sent, /300 000/, 'цифры из заявки модель видит');

  const { document: doc, replaced } = res.json();
  const slides = doc.spec.slides;
  assert.deepEqual(slides.map((s) => s.type), ['cover', 'kpi', 'case', 'proposal', 'closing'], 'чужой тип слайда отброшен');
  assert.equal(slides[0].title, 'Продвижение для ООО Северный дом', 'клиент подставлен уже у нас');
  assert.equal(slides[0].extra, undefined, 'лишние поля отброшены');
  assert.equal(slides[1].kpis[0].value, '+[заполнить: цифра]%', 'выдуманный процент убран');
  assert.equal(slides[1].kpis[1].value, '3 шага', 'счёт шагов — не данные');
  assert.equal(slides[1].dataStatus, 'hypothesis');
  assert.equal(slides[2].verified, false, 'кейс подтверждает человек');
  assert.equal(slides[3].items[0].price, null, 'выдуманная цена убрана');
  assert.equal(slides[4].contacts.name, 'Анна Сорокина');
  assert.equal(replaced, 2);
  assert.equal(doc.lead_id, lead.id);
  // проверка не пропустит документ, пока заготовки не заполнены
  assert.ok(checkContent(doc.spec, brand).errors.some((e) => /заготовка/.test(e)));
});

test('правка слайда: меняются только тексты; цифры, статус и источник — прежние', async () => {
  const ai = fakeAi((r) => {
    assert.match(r.user, /\{\{client\}\}/, 'клиент в запросе замаскирован');
    return JSON.stringify({
      type: 'kpi', title: 'Итоги {{client}}: заявок стало больше', lead: 'Рост за счёт поиска на 80%',
      kpis: [{ value: '999', label: 'заявок за месяц', delta: 'было 640' }], dataStatus: 'fact', source: 'придумано',
    });
  });
  const { req, library } = await setup(ai);
  const doc = library.createDocument({
    spec: { meta: {}, slides: [{ type: 'cover', title: 'Отчёт', client: 'Ромашка' }, { type: 'kpi', title: 'Итоги: Ромашка', lead: 'Заявок больше', kpis: [{ value: '1 200', label: 'заявок', delta: 'было 640' }], dataStatus: 'forecast', source: 'Метрика клиента' }] },
  }, 'Анна');

  const res = await req({ method: 'POST', url: '/admin/api/ai/slide', payload: { documentId: doc.id, index: 1, action: 'persuasive' } });
  assert.equal(res.statusCode, 200, res.body);
  const { slide, replaced } = res.json();
  assert.equal(slide.title, 'Итоги Ромашка: заявок стало больше', 'клиент возвращён из метки');
  assert.equal(slide.kpis[0].value, '1 200', 'значение KPI не меняется');
  assert.equal(slide.kpis[0].label, 'заявок за месяц');
  assert.equal(slide.dataStatus, 'forecast');
  assert.equal(slide.source, 'Метрика клиента');
  assert.equal(slide.lead, 'Рост за счёт поиска на [заполнить: цифра]%');
  assert.equal(replaced, 1);
});

test('ИИ не подключён — понятный ответ; журнал запросов', async () => {
  const off = createAi({ provider: null });
  assert.equal(off.enabled, false);
  const { req, db } = await setup(off);
  assert.equal((await req({ url: '/admin/api/ai' })).json().enabled, false);
  const res = await req({ method: 'POST', url: '/admin/api/ai/draft', payload: { brief: 'Нужна стратегия продвижения для застройщика в Казани' } });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /не подключён/);
  const row = db.raw.prepare('SELECT * FROM ai_log').get();
  assert.equal(row.ok, 0);
  assert.equal(row.action, 'draft');
  const short = await req({ method: 'POST', url: '/admin/api/ai/draft', payload: { brief: 'кп' } });
  assert.equal(short.statusCode, 400);
});

test('запросы к YandexGPT и Claude', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    if (url.includes('llm.api.cloud.yandex.net')) return { ok: true, status: 200, json: async () => ({ result: { alternatives: [{ message: { role: 'assistant', text: 'ответ Яндекса' } }], usage: { totalTokens: '10' } } }) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'ответ Claude' }], usage: { input_tokens: 5 } }) };
  };
  const ya = createAi({ provider: 'yandexgpt', yandexApiKey: 'key', yandexFolderId: 'b1g', yandexModel: 'yandexgpt/latest' }, { fetchImpl });
  assert.equal((await ya.complete({ system: 'sys', user: 'u', maxTokens: 100 })).text, 'ответ Яндекса');
  assert.equal(calls[0].init.headers.authorization, 'Api-Key key');
  assert.equal(calls[0].init.body.modelUri, 'gpt://b1g/yandexgpt/latest');
  assert.equal(calls[0].init.body.completionOptions.maxTokens, '100');
  assert.deepEqual(calls[0].init.body.messages.map((m) => m.role), ['system', 'user']);

  const cl = createAi({ provider: 'anthropic', anthropicApiKey: 'sk', anthropicModel: 'claude-opus-5-5' }, { fetchImpl });
  assert.equal((await cl.complete({ system: 'sys', user: 'u' })).text, 'ответ Claude');
  assert.equal(calls[1].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[1].init.headers['x-api-key'], 'sk');
  assert.equal(calls[1].init.body.model, 'claude-opus-5-5');
  assert.equal(calls[1].init.body.system, 'sys');

  const bad = createAi({ provider: 'anthropic', anthropicApiKey: 'sk' }, { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) }) });
  await assert.rejects(bad.complete({ system: 's', user: 'u' }), /Claude: invalid x-api-key/);
});

test('защита цифр и обезличивание по отдельности', () => {
  const allowed = allowedNumbers('бюджет 300 000 ₽ в месяц, CPL 1 500', { kpis: [{ value: 640 }] });
  const slides = [cleanSlide({ type: 'chart', title: 'Рост в 2026 году', chart: { type: 'column', categories: ['Июль', 'Август'], series: [{ name: 'Лиды', values: [640, 900] }] }, takeaway: 'Бюджет 300 000 ₽ даст 5 млн выручки' })];
  const n = guardNumbers(slides, allowed);
  assert.deepEqual(slides[0].chart.series[0].values, [640, null]);
  assert.equal(slides[0].title, 'Рост в 2026 году', 'год — не данные');
  assert.equal(slides[0].takeaway, 'Бюджет 300 000 ₽ даст [заполнить: цифра] млн выручки');
  assert.equal(n, 2);
  const m = createMask({ client: 'ООО Ромашка', contact: 'Иван' });
  const masked = m.mask({ t: 'ООО Ромашка, Иван, ivan@romashka.ru, 8 (900) 123-45-67' });
  assert.equal(masked.t, '{{client}}, {{contact_name}}, {{email_1}}, {{phone_2}}');
  assert.deepEqual(m.restore(masked), { t: 'ООО Ромашка, Иван, ivan@romashka.ru, 8 (900) 123-45-67' });
});

test('черновик без заявки: клиент из поля формы подставлен, в модель не ушёл; бриф — главный источник; битый JSON — повтор', async () => {
  const good = {
    title: 'КП для {{client}}',
    slides: [
      { type: 'cover', title: 'Переводы за рубеж для {{client}}', subtitle: 'Коммерческое предложение', date: '{{date}}' },
      { type: 'closing', title: 'Следующий шаг', steps: ['Созвон'], contacts: { name: '{{manager}}' } },
    ],
  };
  let n = 0;
  // первый ответ оборван на середине — модель так иногда делает на длинных черновиках
  const ai = fakeAi(() => (n++ === 0 ? '{"title": "КП", "slides": [{"type": "cover", "title": "Пере' : JSON.stringify(good)));
  const { req } = await setup(ai);
  const res = await req({ method: 'POST', url: '/admin/api/ai/draft', payload: { kind: 'kp', client: 'Юнистрим', brief: 'Юнистрим — денежные переводы. Нужен поток установок приложения, акцент на РСЯ и Telegram Ads', slides: 6 } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(ai.calls.length, 2, 'одна повторная попытка');
  assert.match(ai.calls[1].user, /строго валидный JSON/);
  const sent = ai.calls[0].user + ai.calls[0].system;
  assert.doesNotMatch(sent, /Юнистрим/, 'название клиента заменено меткой');
  assert.match(sent, /\{\{client\}\} — денежные переводы/);
  assert.match(sent, /главный источник/);
  assert.equal(res.json().document.spec.slides[0].title, 'Переводы за рубеж для Юнистрим');
});
