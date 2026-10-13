import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { createNotifier } from '../src/notify/index.js';
import { scenario, rules, staticSource, silentLog, typicalAnswers } from './helpers.js';

const PASSWORD = 'correct-horse-battery';

async function setup({ env = {}, notifier } = {}) {
  const config = loadConfig({ DB_PATH: ':memory:', ...env });
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna@soroka-marketing.ru', 'Анна', PASSWORD);
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, notifier, log: silentLog });
  const app = await buildServer({
    config, qualifier, logger: false,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource() },
  });
  return { app, db, auth, qualifier };
}

async function login(app) {
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { email: 'Anna@soroka-marketing.ru', password: PASSWORD } });
  assert.equal(res.statusCode, 200);
  const cookie = res.cookies.find((c) => c.name === 'kval_admin');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Strict');
  return { cookie: `kval_admin=${cookie.value}` };
}

async function makeLead(qualifier, patch = {}, meta = {}) {
  const answers = { ...typicalAnswers, ...patch };
  const { session } = qualifier.startSession({ channel: 'web', meta });
  let reply = qualifier.resume(session);
  while (reply.type === 'question') {
    const { id, required } = reply.step;
    reply = await qualifier.answer(session.id, id in answers ? { value: answers[id] } : { skip: !required });
  }
  return session.id;
}

test('без входа данные недоступны, неверный пароль — 401', async () => {
  const { app } = await setup();
  assert.equal((await app.inject({ url: '/admin/api/leads' })).statusCode, 401);
  const bad = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { email: 'anna@soroka-marketing.ru', password: 'wrong-password' } });
  assert.equal(bad.statusCode, 401);
  const nobody = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { email: 'x@y.ru', password: PASSWORD } });
  assert.equal(nobody.statusCode, 401);
});

test('вход, список лидов, поиск по-русски без учёта регистра, фильтр по рейтингу', async () => {
  const { app, qualifier } = await setup();
  await makeLead(qualifier, { company: 'Газпромбанк' });
  await makeLead(qualifier, { company: 'ООО Ромашка' });
  const headers = await login(app);

  const me = await app.inject({ url: '/admin/api/me', headers });
  assert.equal(me.json().user.name, 'Анна');

  const all = (await app.inject({ url: '/admin/api/leads', headers })).json();
  assert.equal(all.total, 2);
  const found = (await app.inject({ url: `/admin/api/leads?q=${encodeURIComponent('ГАЗПРОМ')}`, headers })).json();
  assert.equal(found.total, 1);
  assert.equal(found.leads[0].answers.company, 'Газпромбанк');
  const fives = (await app.inject({ url: '/admin/api/leads?rating=5', headers })).json();
  assert.equal(fives.total, 1);
});

test('смена статуса, ответственного и комментария пишется в историю', async () => {
  const { app, qualifier, db } = await setup();
  await makeLead(qualifier);
  const headers = await login(app);
  const res = await app.inject({
    method: 'PATCH', url: '/admin/api/leads/1', headers,
    payload: { status: 'proposal', assignee: ' @ivan ', comment: 'Отправили КП 10.10' },
  });
  assert.equal(res.statusCode, 200);
  const { lead, events } = res.json();
  assert.equal(lead.status, 'proposal');
  assert.equal(lead.assignee, '@ivan');
  assert.deepEqual(events.map((e) => e.type), ['created', 'status', 'assignee', 'comment']);
  assert.equal(events[1].actor, 'Анна');
  assert.deepEqual(events[1].data, { from: 'new', to: 'proposal' });

  const bad = await app.inject({ method: 'PATCH', url: '/admin/api/leads/1', headers, payload: { status: 'deleted' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(db.getLead(1).status, 'proposal');
});

test('выгрузка CSV для Excel: BOM, «;», защита от формул', async () => {
  const { app, qualifier } = await setup();
  await makeLead(qualifier, { task: '=HYPERLINK("http://evil")' });
  const headers = await login(app);
  const res = await app.inject({ url: '/admin/api/leads.csv', headers });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'], /leads-\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(res.body.startsWith('﻿№;Дата (МСК);Рейтинг'));
  assert.match(res.body, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
});

test('сводка: лиды по дням и воронка опроса', async () => {
  const { app, qualifier } = await setup();
  await makeLead(qualifier);
  const { session } = qualifier.startSession({ channel: 'web' });
  await qualifier.answer(session.id, { value: 'seo' });
  const headers = await login(app);
  const stats = (await app.inject({ url: '/admin/api/stats', headers })).json();
  assert.equal(stats.byDay.reduce((n, r) => n + r.n, 0), 1);
  assert.equal(stats.funnel.started, 2);
  assert.equal(stats.funnel.completed, 1);
});

test('тестовые лиды помечаются, не видны в рабочем списке и не уходят менеджерам', async () => {
  const sent = [];
  const notifier = createNotifier(loadConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_MANAGER_CHAT_ID: '1' }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body).chat_id);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const { app, qualifier, db } = await setup({ notifier });
    await makeLead(qualifier, {}, { test: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(db.getLead(1).is_test, 1);
    assert.equal(db.getLead(1).notified, 1);
    assert.deepEqual(sent, []);

    const headers = await login(app);
    assert.equal((await app.inject({ url: '/admin/api/leads', headers })).json().total, 0);
    assert.equal((await app.inject({ url: '/admin/api/leads?test=1', headers })).json().total, 1);

    await makeLead(qualifier);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, ['1']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('виджет передаёт признак тестового опроса', async () => {
  const { app, db } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { meta: { page: '/demo.html', test: true } } });
  assert.equal(db.getSession(res.json().sessionId).meta.test, true);
});

test('вход через Яндекс ID: по добавленной почте, по домену, чужим — нельзя', () => {
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna@soroka-marketing.ru', 'Анна');

  const anna = { id: '111', default_email: 'Anna@soroka-marketing.ru', real_name: 'Анна И.' };
  assert.ok(auth.userByToken(auth.loginWithYandex(anna)));
  // повторный вход — по yandex_id, даже если почта в Яндексе сменилась
  assert.ok(auth.loginWithYandex({ ...anna, default_email: 'other@yandex.ru' }));

  const stranger = { id: '222', default_email: 'hacker@yandex.ru' };
  assert.equal(auth.loginWithYandex(stranger), null);

  const colleague = { id: '333', default_email: 'oleg@soroka-marketing.ru', real_name: 'Олег' };
  assert.equal(auth.loginWithYandex(colleague), null);
  const token = auth.loginWithYandex(colleague, { allowedDomains: ['soroka-marketing.ru'] });
  assert.equal(auth.userByToken(token).name, 'Олег');

  auth.setDisabled('oleg@soroka-marketing.ru', true);
  assert.equal(auth.userByToken(token), null);
  assert.equal(auth.loginWithYandex(colleague, { allowedDomains: ['soroka-marketing.ru'] }), null);
});

test('вход через Яндекс: кнопка включается настройками, state защищает от подделки', async () => {
  const { app } = await setup({ env: { PUBLIC_URL: 'https://kval.example.ru', YANDEX_CLIENT_ID: 'cid', YANDEX_CLIENT_SECRET: 'sec' } });
  assert.equal((await app.inject({ url: '/admin/api/auth' })).json().yandex, true);
  const start = await app.inject({ url: '/admin/auth/yandex' });
  assert.equal(start.statusCode, 302);
  const location = new URL(start.headers.location);
  assert.equal(location.host, 'oauth.yandex.ru');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://kval.example.ru/admin/auth/yandex/callback');
  const forged = await app.inject({ url: '/admin/auth/yandex/callback?code=x&state=forged' });
  assert.match(forged.headers.location, /error=/);
});

test('админка отдаётся с защитными заголовками', async () => {
  const { app } = await setup();
  const res = await app.inject({ url: '/admin/' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
});

test('миграция старой базы без потери данных', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kval-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, token TEXT NOT NULL, channel TEXT NOT NULL, channel_user_id TEXT,
      handoff_code TEXT UNIQUE, state TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE, channel TEXT NOT NULL,
      rating INTEGER NOT NULL, score REAL NOT NULL, reasons TEXT NOT NULL, tags TEXT NOT NULL, answers TEXT NOT NULL,
      meta TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', assignee TEXT, delivered TEXT NOT NULL DEFAULT '[]',
      notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO sessions (id, token, channel, state) VALUES ('s1', 't', 'web', '{}');
    INSERT INTO leads (session_id, channel, rating, score, reasons, tags, answers, meta) VALUES ('s1', 'web', 4, 6, '[]', '[]', '{}', '{}');`);
  old.close();

  const db = openDb(path);
  const lead = db.getLead(1);
  assert.equal(lead.rating, 4);
  assert.equal(lead.is_test, 0);
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, 2);
  db.close();
});
