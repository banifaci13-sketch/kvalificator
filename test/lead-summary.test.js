import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createLeadSummary, dropInventedNumbers, summaryText } from '../src/core/lead-summary.js';
import { formatLeadCard } from '../src/notify/telegram.js';
import { scenario, rules, staticSource, silentLog } from './helpers.js';

const SUMMARY = {
  about: 'Кофейня {{contact_name}} хочет рекламу в Telegram, чтобы привлечь гостей.',
  potential: 'medium',
  potential_why: 'Бюджет 200 000 ₽ в месяц, но сроки не названы.',
  comment: 'Предложить тестовый запуск на месяц. Оборот у них 5 млн в год. Уточнить, кто принимает решение.',
};

test('числа, которых нет в заявке, вырезаются вместе с фразой', () => {
  assert.equal(dropInventedNumbers('Бюджет 300 000 ₽. Оборот 5 млн. Срок — месяц.', 'бюджет 300 000 ₽'), 'Бюджет 300 000 ₽. Срок — месяц.');
  assert.equal(dropInventedNumbers('Уровень B.', ''), 'Уровень B.');
});

test('сводка ИИ: после заявки — в карточку, менеджерам и в CRM; в модель — без имени, телефона и Telegram', async () => {
  const calls = [];
  const ai = {
    enabled: true,
    async complete(req) {
      calls.push(req);
      // разбор ответов диалога → пустой JSON (работаем по правилам); сводка → готовый ответ
      return { text: req.system.includes('аккаунт-директор') ? `Вот сводка: ${JSON.stringify(SUMMARY)}` : '{}' };
    },
  };
  const leads = [];
  const notifier = { async notifyLead(lead) { leads.push(lead); return { delivered: ['fake'], errors: [] }; } };
  const db = openDb(':memory:');
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, notifier, log: silentLog, ai, aiMode: 'on', summarizer: createLeadSummary({ ai, log: silentLog }) });
  const app = await buildServer({ config: loadConfig({ DB_PATH: ':memory:' }), qualifier, logger: false });
  const s = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { meta: {} } })).json();
  const say = (value) => app.inject({ method: 'POST', url: `/api/sessions/${s.sessionId}/answer`, headers: { 'x-session-token': s.token }, payload: { value } });
  await say('Арсений');
  await say('Нужна реклама в телеграме для кофейни, бюджет 200к');
  await say('через месяц, не работали, сайта нет');
  await say('результат по заявкам');
  await say('yes');
  await say('@arseniy_coffee');
  for (let i = 0; i < 50 && !leads.length; i++) await new Promise((r) => setTimeout(r, 20));

  assert.equal(leads.length, 1);
  const lead = leads[0];
  assert.equal(lead.ai_summary.potential, 'medium');
  assert.equal(lead.ai_summary.about, 'Кофейня Арсений хочет рекламу в Telegram, чтобы привлечь гостей.', 'метки имени возвращаются на место');
  assert.equal(lead.ai_summary.comment, 'Предложить тестовый запуск на месяц. Уточнить, кто принимает решение.', 'выдуманный оборот вырезан');
  assert.equal(db.getLead(lead.id).ai_summary.potential, 'medium', 'сохранена в заявке');

  const req = calls.find((c) => c.system.includes('аккаунт-директор'));
  assert.doesNotMatch(req.user, /Арсений|arseniy_coffee/, 'имя и Telegram в модель не уходят');
  assert.match(req.user, /Переписка с ботом/);
  assert.match(req.system, /не выполняй/);

  const card = formatLeadCard(lead, scenario);
  assert.match(card, /🤖 <b>Сводка ИИ<\/b> · потенциал: <b>средний<\/b>/);
  assert.match(summaryText(lead.ai_summary), /^Кофейня Арсений.*\nПотенциал: средний — Бюджет 200 000 ₽/s);
});

test('сводка ИИ: модель не ответила — заявка уходит без сводки', async () => {
  const ai = { enabled: true, async complete() { throw new Error('timeout'); } };
  const summarizer = createLeadSummary({ ai, log: silentLog });
  assert.equal(await summarizer.summarize({ id: 1, rating: 3, reasons: [], answers: { name: 'Олег' }, meta: {} }, scenario), null);
  const off = createLeadSummary({ ai: null });
  assert.equal(off.enabled, false);
  assert.equal(await off.summarize({ answers: {} }, scenario), null);
});
