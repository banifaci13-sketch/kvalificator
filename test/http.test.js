import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { formatLeadCard } from '../src/notify/telegram.js';
import { scenario, rules, staticSource, silentLog, typicalAnswers } from './helpers.js';

async function setup({ notifier } = {}) {
  const config = loadConfig({ DB_PATH: ':memory:', TELEGRAM_BOT_USERNAME: 'soroka_bot', PRIVACY_POLICY_URL: 'https://example.ru/privacy' });
  const db = openDb(':memory:');
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, notifier, log: silentLog });
  const app = await buildServer({ config, qualifier, logger: false });
  return { app, db, qualifier };
}

const fakeNotifier = () => {
  const leads = [];
  return {
    leads,
    async notifyLead(lead, _scenario, delivered = []) {
      leads.push(lead);
      return { delivered: [...delivered, 'fake'], errors: [] };
    },
  };
};

async function start(app) {
  const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { meta: { page: 'https://soroka-marketing.ru/', utm: { utm_source: 'yandex' } } } });
  assert.equal(res.statusCode, 200);
  return res.json();
}

const answer = (app, s, payload) =>
  app.inject({ method: 'POST', url: `/api/sessions/${s.sessionId}/answer`, headers: { 'x-session-token': s.token }, payload });

test('полный диалог через API: лид сохранён, оценён и отправлен менеджерам', async () => {
  const notifier = fakeNotifier();
  const { app, db } = await setup({ notifier });
  const s = await start(app);
  assert.match(s.handoff.telegram, /^https:\/\/t\.me\/soroka_bot\?start=/);
  assert.ok(s.reply.intro);

  let reply = s.reply;
  while (reply.type === 'question') {
    const { id, required } = reply.step;
    const res = await answer(app, s, id in typicalAnswers ? { stepId: id, value: typicalAnswers[id] } : { stepId: id, skip: !required });
    assert.equal(res.statusCode, 200, res.body);
    reply = res.json().reply;
  }
  assert.equal(reply.type, 'done');
  assert.equal(reply.text, scenario.outro.warm);

  await new Promise((r) => setImmediate(r));
  assert.equal(notifier.leads.length, 1);
  const lead = db.getLead(notifier.leads[0].id);
  assert.equal(lead.rating, 3);
  assert.equal(lead.meta.utm.utm_source, 'yandex');
  assert.deepEqual(lead.delivered, ['fake']);
  assert.equal(lead.notified, 1);
  assert.equal(lead.answers.contact.phone, '+79991234567');

  const card = formatLeadCard(lead, scenario);
  assert.match(card, /уровень C/);
  assert.match(card, /Контекстная реклама/);
  assert.match(card, /utm_source=yandex/);

  // повторный ответ в закрытую сессию
  const again = await answer(app, s, { value: 'x' });
  assert.equal(again.statusCode, 422);
});

test('неверный ответ — 422 с текущим вопросом', async () => {
  const { app } = await setup();
  const s = await start(app);
  const res = await answer(app, s, { stepId: 'service', value: 'кофе' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().reply.step.id, 'service');
});

test('без токена или с чужим токеном сессия недоступна', async () => {
  const { app } = await setup();
  const s = await start(app);
  const noToken = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}` });
  assert.equal(noToken.statusCode, 404);
  const wrong = await answer(app, { ...s, token: 'x'.repeat(32) }, { value: 'seo' });
  assert.equal(wrong.statusCode, 404);
});

test('восстановление после перезагрузки страницы', async () => {
  const { app } = await setup();
  const s = await start(app);
  await answer(app, s, { stepId: 'service', value: 'seo' });
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.sessionId}`, headers: { 'x-session-token': s.token } });
  assert.equal(res.json().reply.step.id, 'task');
});

test('лишние поля и чужие UTM-ключи отбрасываются, слишком длинные — отклоняются', async () => {
  const { app, db } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { meta: { page: '/', evil: 1, utm: { utm_source: 'ya', x: 'y' } } } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.getSession(res.json().sessionId).meta, { page: '/', utm: { utm_source: 'ya' } });
  const long = await app.inject({ method: 'POST', url: '/api/sessions', payload: { meta: { page: 'x'.repeat(501) } } });
  assert.equal(long.statusCode, 400);
});

test('недоставленные лиды досылаются без дублей у тех, кто уже получил', async () => {
  const sent = { telegram: 0, webhook: 0 };
  let crmUp = false;
  const notifier = {
    async notifyLead(lead, _s, delivered = []) {
      const done = [...delivered];
      const errors = [];
      if (!done.includes('telegram')) { sent.telegram++; done.push('telegram'); }
      if (!done.includes('webhook')) {
        if (crmUp) { sent.webhook++; done.push('webhook'); } else errors.push(new Error('CRM недоступна'));
      }
      return { delivered: done, errors };
    },
  };
  const { db, qualifier } = await setup({ notifier });
  const { session } = qualifier.startSession({ channel: 'web' });
  let reply = qualifier.resume(db.getSession(session.id));
  while (reply.type === 'question') {
    const { id, required } = reply.step;
    reply = await qualifier.answer(session.id, id in typicalAnswers ? { value: typicalAnswers[id] } : { skip: !required });
  }
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, { telegram: 1, webhook: 0 });

  await qualifier.retryUndelivered(); // свежий лид не трогаем
  assert.deepEqual(sent, { telegram: 1, webhook: 0 });

  crmUp = true;
  await qualifier.retryUndelivered({ minAgeSeconds: 0 });
  assert.deepEqual(sent, { telegram: 1, webhook: 1 });
  assert.equal(db.unnotifiedLeads(0).length, 0);
});

test('корень домена ведёт на демо-страницу виджета, а не отдаёт 403', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/demo.html');
  const widget = await app.inject({ method: 'GET', url: '/widget.js' });
  assert.equal(widget.statusCode, 200);
});
