// Распознавание рассказа клиента без ИИ: все услуги и их написания, комбинации, отказы,
// бюджеты, сроки, опыт с подрядчиком, сайт, сфера, роль; ответы на уточнение по пунктам; имя и контакт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { serviceEvidence, ruleExtract, clarifyExtract, nameFrom, criteriaGuess } from '../src/core/rule-extract.js';
import { recognitionText } from '../src/core/text-norm.js';
import { normalizeContact } from '../src/core/engine.js';
import { loadPricing } from '../src/core/pricing.js';
import { SERVICE_PHRASES, FIELD_PHRASES, CLARIFY_PHRASES } from './fixtures/client-phrases.js';
import { rules, staticSource, silentLog } from './helpers.js';

const pricing = loadPricing(new URL('../config/pricing.json', import.meta.url).pathname);
const NOW = new Date('2026-10-16T12:00:00');

test('услуги: все направления, написания, опечатки, раскладка, комбинации и отказы', () => {
  const bad = [];
  for (const c of SERVICE_PHRASES) {
    const { services } = serviceEvidence(c.text, pricing);
    const ids = pricing.estimate(services, recognitionText(c.text))?.ids ?? [];
    const okServices = services.length === c.services.length && c.services.every((s) => services.includes(s));
    const okProducts = (c.products ?? []).every((p) => ids.includes(p)) && !(c.noProducts ?? []).some((p) => ids.includes(p));
    if (!okServices || !okProducts) bad.push(`«${c.text}»: услуги ${services.join(',') || '—'} (ждём ${c.services.join(',') || '—'}), смета ${ids.join(',') || '—'}`);
  }
  assert.deepEqual(bad, [], `не распознано ${bad.length} из ${SERVICE_PHRASES.length}`);
});

test('услуги без прайса: словарь правил сам знает основные направления', () => {
  const bad = SERVICE_PHRASES.filter((c) => c.services.length && !c.products?.length && !/[a-z]{4,}|ыущ|ыьь/i.test(c.text))
    .filter((c) => {
      const { services } = serviceEvidence(c.text);
      return !c.services.every((s) => services.includes(s));
    })
    .map((c) => c.text);
  assert.deepEqual(bad, []);
});

test('поля заявки: бюджет, сроки, опыт с подрядчиком, сайт, сфера, рынок, география, роль, ЛПР', () => {
  const bad = [];
  for (const c of FIELD_PHRASES) {
    const r = ruleExtract(c.text, { now: NOW });
    for (const [k, v] of Object.entries(c)) {
      if (k !== 'text' && (r[k] ?? null) !== v) bad.push(`«${c.text}»: ${k} = ${r[k]} (ждём ${v})`);
    }
  }
  assert.deepEqual(bad, [], `ошибок ${bad.length}`);
});

test('ответ на уточнение по пунктам: по номерам, строкам или через запятую — «нет» понимается по вопросу', () => {
  const bad = [];
  for (const c of CLARIFY_PHRASES) {
    const r = clarifyExtract(c.reply, c.asked, { now: NOW });
    for (const [k, v] of Object.entries(c.expect)) {
      if (JSON.stringify(r[k] ?? null) !== JSON.stringify(v)) bad.push(`[${c.asked}] «${c.reply}»: ${k} = ${JSON.stringify(r[k])} (ждём ${JSON.stringify(v)})`);
    }
  }
  assert.deepEqual(bad, []);
  // частей больше или меньше, чем вопросов, и без номеров — не гадаем
  assert.deepEqual(clarifyExtract('нет, нет', ['budget', 'start', 'site']), {});
});

test('имя: «меня зовут…», приветствие, задача вместо имени', () => {
  assert.deepEqual(nameFrom('Анна'), { name: 'Анна', task: false });
  assert.deepEqual(nameFrom('меня зовут анна'), { name: 'Анна', task: false });
  assert.deepEqual(nameFrom('Добрый день! Меня зовут Светлана'), { name: 'Светлана', task: false });
  assert.deepEqual(nameFrom('Здравствуйте, это Игорь из ООО Ромашка'), { name: 'Игорь', task: false });
  assert.deepEqual(nameFrom('Я — Ольга, маркетолог'), { name: 'Ольга', task: false });
  assert.deepEqual(nameFrom('Анна Петрова'), { name: 'Анна Петрова', task: false });
  assert.deepEqual(nameFrom('Мария-Луиза'), { name: 'Мария-Луиза', task: false });
  assert.deepEqual(nameFrom('Игорь, нужен директ для автосервиса'), { name: 'Игорь', task: true });
  assert.deepEqual(nameFrom('Нужна реклама в директе для автосервиса, бюджет 100к'), { name: null, task: true });
  assert.deepEqual(nameFrom('Здравствуйте'), { name: null, task: false });
});

test('что важно в выборе исполнителя: «стоимость заявки» — это результат, а не цена', () => {
  const cases = {
    'важен результат по заявкам': 'results', 'стоимость заявки': 'results', 'ДРР и окупаемость': 'results', 'цена': 'price', 'чтобы недорого': 'price',
    'опыт в нашей нише': 'expertise', 'кейсы и отзывы': 'expertise', 'прозрачность и отчёты': 'transparency', 'всегда на связи': 'transparency',
    'чтобы быстро запустили': 'speed', 'не знаю': null,
  };
  for (const [t, v] of Object.entries(cases)) assert.equal(criteriaGuess(t), v, t);
});

test('контакт внутри фразы: телефон, Telegram, почта, ВКонтакте', () => {
  assert.equal(normalizeContact('мой номер 8 (900) 123-45-67, звоните после 18').phone, '+79001234567');
  assert.equal(normalizeContact('пишите в тг anna_smm').telegram, '@anna_smm');
  assert.equal(normalizeContact('t.me/anna_smm').telegram, '@anna_smm');
  assert.equal(normalizeContact('+375 29 123-45-67').phone, '+375291234567');
  const both = normalizeContact('+7 900 111 22 33 или anna@mail.ru');
  assert.equal(both.phone, '+79001112233');
  assert.equal(both.email, 'anna@mail.ru');
  assert.equal(both.telegram, undefined, 'почта — не ник в Telegram');
  assert.equal(normalizeContact('vk.com/id123').vk, 'vk.com/id123');
  assert.throws(() => normalizeContact('позвоните мне'));
});

// ---------- диалог целиком, без ИИ ----------

async function setup() {
  const config = loadConfig({ DB_PATH: ':memory:', PRIVACY_POLICY_URL: 'https://example.ru/privacy' });
  const db = openDb(':memory:');
  const notifier = { async notifyLead() { return { delivered: ['fake'], errors: [] }; } };
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, notifier, log: silentLog, aiMode: 'on', pricing });
  const app = await buildServer({ config, qualifier, logger: false });
  const start = async () => (await app.inject({ method: 'POST', url: '/api/sessions', payload: { meta: {} } })).json();
  const say = async (s, payload) => (await app.inject({ method: 'POST', url: `/api/sessions/${s.sessionId}/answer`, headers: { 'x-session-token': s.token }, payload })).json();
  return { db, start, say };
}

test('задача вместо имени: не теряется и второй раз не спрашивается', async () => {
  const { start, say } = await setup();
  const s = await start();
  const r = (await say(s, { value: 'Игорь, нужна реклама в директе для автосервиса, бюджет 200к, срочно, раньше не работали, сайт avto.ru' })).reply;
  assert.notEqual(r.step.id, 'task', 'задачу не переспрашиваем');
  assert.equal(r.step.id, 'criteria', 'всё понятно — сразу к выбору исполнителя');
});

test('приветствие вместо имени — просим имя ещё раз', async () => {
  const { start, say } = await setup();
  const s = await start();
  const res = await say(s, { value: 'Здравствуйте!' });
  assert.match(res.error, /Как к вам обращаться/);
});

test('уточнение «по пунктам» без ИИ: «нет» про подрядчика и про сайт, сумма числом', async () => {
  const { start, say, db } = await setup();
  const s = await start();
  await say(s, { value: 'Ольга' });
  let r = (await say(s, { value: 'Нужен таргет вк для салона красоты' })).reply;
  assert.equal(r.step.id, 'clarify');
  assert.match(r.step.text, /1\) какой бюджет.*\n2\) когда хотите.*\n3\) работали ли раньше.*\n4\) есть ли сайт/s);
  r = (await say(s, { value: '1) 150 2) срочно 3) нет 4) нет' })).reply;
  assert.equal(r.step.id, 'criteria');
  r = (await say(s, { value: 'результат' })).reply;
  await say(s, { value: '+7 900 555-66-77', consent: true });
  const a = db.getLead(1).answers;
  assert.equal(a.budget, '100_300k');
  assert.equal(a.start, 'asap');
  assert.equal(a.agency_experience, 'none');
  assert.equal(a.company, 'нет сайта');
});

test('смета без отказанных услуг и без упомянутого лендинга', async () => {
  const { start, say } = await setup();
  const s = await start();
  await say(s, { value: 'Ксения' });
  let r = (await say(s, { value: 'У нас есть лендинг, SEO делаем сами, директ не нужен. Нужна реклама в телеграме и вк. Бюджет 300к, через месяц, раньше не работали' })).reply;
  if (r.step.id === 'clarify') r = (await say(s, { value: 'нет' })).reply;
  r = (await say(s, { value: 'результат' })).reply;
  const smeta = r.step.before.join('\n');
  assert.match(smeta, /Реклама в Telegram/);
  assert.match(smeta, /Реклама ВКонтакте/);
  assert.doesNotMatch(smeta, /лендинг|SEO|Контекстная/i);
});
