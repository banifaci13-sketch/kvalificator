import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, SCHEMA_VERSION } from '../src/storage/db.js';
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
  auth.addUser('anna@soroka-marketing.ru', 'Анна', { password: PASSWORD, role: 'admin' });
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, notifier, log: silentLog });
  const app = await buildServer({
    config, qualifier, logger: false,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource() },
  });
  return { app, db, auth, qualifier };
}

async function login(app) {
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'Anna@soroka-marketing.ru', password: PASSWORD } });
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
  const bad = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'anna@soroka-marketing.ru', password: 'wrong-password' } });
  assert.equal(bad.statusCode, 401);
  const nobody = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'x@y.ru', password: PASSWORD } });
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

  auth.setDisabledByLogin('oleg@soroka-marketing.ru', true);
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

test('корень домена открывает рабочее место', async () => {
  const { app } = await setup();
  const res = await app.inject({ url: '/' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/');
  const docsModule = await app.inject({ url: '/admin/docs.js' });
  assert.equal(docsModule.statusCode, 200);
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
  assert.equal(db.raw.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  db.close();
});

test('администратор заводит сотрудника: пароль генерируется и показывается один раз', async () => {
  const { app } = await setup();
  const headers = await login(app);
  const res = await app.inject({ method: 'POST', url: '/admin/api/users', headers, payload: { login: 'Ivan', name: 'Иван', role: 'manager' } });
  assert.equal(res.statusCode, 200, res.body);
  const { user, password } = res.json();
  assert.equal(user.login, 'ivan');
  assert.match(password, /^[A-Za-z2-9]{14}$/);
  assert.ok(!JSON.stringify((await app.inject({ url: '/admin/api/users', headers })).json()).includes(password));

  const dup = await app.inject({ method: 'POST', url: '/admin/api/users', headers, payload: { login: 'ivan' } });
  assert.equal(dup.statusCode, 400);
  assert.match(dup.json().error, /уже есть/);

  const ivanLogin = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'IVAN', password } });
  assert.equal(ivanLogin.statusCode, 200);
});

test('менеджеру раздел «Сотрудники» недоступен', async () => {
  const { app, auth } = await setup();
  const { password } = auth.addUser('manager1', 'Менеджер');
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'manager1', password } });
  const headers = { cookie: `kval_admin=${res.cookies.find((c) => c.name === 'kval_admin').value}` };
  assert.equal((await app.inject({ url: '/admin/api/users', headers })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/api/users', headers, payload: { login: 'hacker' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/admin/api/leads', headers })).statusCode, 200);
});

test('сброс пароля: старый не работает, сессии сотрудника завершены', async () => {
  const { app, auth } = await setup();
  const { user, password } = auth.addUser('olga', 'Ольга');
  const first = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'olga', password } });
  const olgaCookie = { cookie: `kval_admin=${first.cookies.find((c) => c.name === 'kval_admin').value}` };
  const headers = await login(app);
  const res = await app.inject({ method: 'POST', url: `/admin/api/users/${user.id}/reset-password`, headers, payload: {} });
  const fresh = res.json().password;
  assert.notEqual(fresh, password);
  assert.equal((await app.inject({ url: '/admin/api/me', headers: olgaCookie })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'olga', password } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'olga', password: fresh } })).statusCode, 200);
});

test('отключённый сотрудник теряет доступ; последнего администратора отключить нельзя', async () => {
  const { app, auth } = await setup();
  const headers = await login(app);
  const { user } = auth.addUser('petr', 'Пётр');
  const off = await app.inject({ method: 'PATCH', url: `/admin/api/users/${user.id}`, headers, payload: { disabled: true } });
  assert.equal(off.json().user.disabled, true);
  const me = (await app.inject({ url: '/admin/api/me', headers })).json().user;
  const self = await app.inject({ method: 'PATCH', url: `/admin/api/users/${me.id}`, headers, payload: { role: 'manager' } });
  assert.equal(self.statusCode, 400);
  assert.match(self.json().error, /администратор/);
});

test('смена своего пароля требует текущий', async () => {
  const { app } = await setup();
  const headers = await login(app);
  const bad = await app.inject({ method: 'POST', url: '/admin/api/me/password', headers, payload: { current: 'wrong-password', next: 'new-password-123' } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/admin/api/me/password', headers, payload: { current: PASSWORD, next: 'new-password-123' } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await app.inject({ url: '/admin/api/me', headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'anna@soroka-marketing.ru', password: 'new-password-123' } })).statusCode, 200);
});

test('после обновления первый сотрудник старой базы становится администратором', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'kval-')), 'v2.db');
  const fresh = openDb(path);
  // база в состоянии версии 2: колонки role ещё нет, сотрудники заведены старой командой
  fresh.raw.exec(`DROP TABLE news_reactions; DROP TABLE news_comments; DROP TABLE news_files; DROP TABLE news_posts; DROP TABLE files; ALTER TABLE admin_users DROP COLUMN news_seen; DROP TABLE user_avatars; ALTER TABLE admin_users DROP COLUMN avatar_ver; ALTER TABLE admin_users DROP COLUMN prefs; ALTER TABLE admin_users DROP COLUMN position; ALTER TABLE admin_users DROP COLUMN phone; DROP TABLE media; DROP TABLE ai_log; DROP TABLE digests_sent; DROP TABLE meeting_reminders_sent; DROP TABLE meeting_participants; DROP TABLE meetings; DROP INDEX admin_users_calendar; ALTER TABLE admin_users DROP COLUMN telegram_chat_id; ALTER TABLE admin_users DROP COLUMN telegram_link_code; ALTER TABLE admin_users DROP COLUMN calendar_token; DROP TABLE notifications; DROP TABLE assistant_messages; DROP TABLE kb_docs; DROP TABLE task_links; DROP TABLE task_comments; DROP TABLE tasks; DROP TABLE task_columns; DROP TABLE task_boards; DROP TABLE clients; DROP TABLE mp_benchmarks; DROP TABLE mediaplans; DROP TABLE document_exports; DROP TABLE documents; DROP TABLE doc_templates;
    ALTER TABLE admin_users DROP COLUMN role; PRAGMA user_version = 2;
    INSERT INTO admin_users (email, name, password_hash) VALUES ('owner@soroka.ru', 'Владелец', NULL), ('second', 'Второй', NULL);`);
  fresh.close();

  const db = openDb(path);
  const users = createAuth(db.raw).listUsers();
  assert.deepEqual(users.map((u) => [u.login, u.role]), [['owner@soroka.ru', 'admin'], ['second', 'manager']]);
  db.close();
});

test('имя: каждый меняет своё, чужое — только администратор', async () => {
  const { app, auth } = await setup();
  auth.addUser('dmitry', 'Дмитрий Карацапов', { password: PASSWORD, role: 'manager' });
  const anna = await login(app);
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'dmitry', password: PASSWORD } });
  const dmitry = { cookie: `kval_admin=${res.cookies.find((c) => c.name === 'kval_admin').value}` };

  const own = await app.inject({ method: 'PATCH', url: '/admin/api/me', headers: dmitry, payload: { name: 'Даниил Карацапов' } });
  assert.equal(own.statusCode, 200);
  assert.equal((await app.inject({ url: '/admin/api/me', headers: dmitry })).json().user.name, 'Даниил Карацапов');
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me', headers: dmitry, payload: { name: '  ' } })).statusCode, 400);

  const annaId = auth.listUsers().find((u) => u.login === 'anna@soroka-marketing.ru').id;
  const dmitryId = auth.listUsers().find((u) => u.login === 'dmitry').id;
  assert.equal((await app.inject({ method: 'PATCH', url: `/admin/api/users/${annaId}`, headers: dmitry, payload: { name: 'Взлом' } })).statusCode, 403);
  const byAdmin = await app.inject({ method: 'PATCH', url: `/admin/api/users/${dmitryId}`, headers: anna, payload: { name: 'Даниил К.' } });
  assert.equal(byAdmin.json().user.name, 'Даниил К.');
  auth.setNameByLogin('dmitry', 'Даниил Карацапов');
  assert.equal(auth.listUsers().find((u) => u.login === 'dmitry').name, 'Даниил Карацапов');
});

test('данные сотрудника: логин, должность, телефон; удаление отключённого', async () => {
  const { app, auth } = await setup();
  const anna = await login(app);
  auth.addUser('d.karatsapov@yandex.ri', 'Опечатка', { password: PASSWORD, role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: PASSWORD });
  const typo = auth.listUsers().find((u) => u.login === 'd.karatsapov@yandex.ri');
  const oleg = auth.listUsers().find((u) => u.login === 'oleg');

  const upd = await app.inject({ method: 'PATCH', url: `/admin/api/users/${oleg.id}`, headers: anna, payload: { login: 'Oleg.Petrov@Soroka.ru', position: 'Таргетолог', phone: '+7 900 000-00-00' } });
  assert.equal(upd.statusCode, 200);
  assert.deepEqual([upd.json().user.login, upd.json().user.position, upd.json().user.phone], ['oleg.petrov@soroka.ru', 'Таргетолог', '+7 900 000-00-00']);
  // со сменой логина входят по новому, пароль прежний
  assert.equal((await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'oleg.petrov@soroka.ru', password: PASSWORD } })).statusCode, 200);
  const dup = await app.inject({ method: 'PATCH', url: `/admin/api/users/${oleg.id}`, headers: anna, payload: { login: 'anna@soroka-marketing.ru' } });
  assert.match(dup.json().error, /уже есть/);

  // удалить можно только отключённого
  assert.match((await app.inject({ method: 'DELETE', url: `/admin/api/users/${typo.id}`, headers: anna })).json().error, /отключите/);
  await app.inject({ method: 'PATCH', url: `/admin/api/users/${typo.id}`, headers: anna, payload: { disabled: true } });
  assert.equal((await app.inject({ method: 'DELETE', url: `/admin/api/users/${typo.id}`, headers: anna })).statusCode, 200);
  assert.equal(auth.listUsers().some((u) => u.login === 'd.karatsapov@yandex.ri'), false);

  const me = await app.inject({ method: 'PATCH', url: '/admin/api/me', headers: anna, payload: { position: 'Руководитель', phone: '+7 911 111-11-11' } });
  assert.equal(me.json().user.position, 'Руководитель');
});

test('внешний вид кабинета: у каждого свои настройки, только допустимые значения', async () => {
  const { app, auth } = await setup();
  auth.addUser('oleg', 'Олег', { password: PASSWORD, role: 'manager' });
  const anna = { cookie: `kval_admin=${(await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'anna@soroka-marketing.ru', password: PASSWORD } })).cookies.find((c) => c.name === 'kval_admin').value}` };
  const oleg = { cookie: `kval_admin=${(await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'oleg', password: PASSWORD } })).cookies.find((c) => c.name === 'kval_admin').value}` };

  const me = (await app.inject({ url: '/admin/api/me', headers: anna })).json().user;
  assert.deepEqual(me.prefs, { theme: 'system', accent: 'soroka', background: 'none', density: 'comfortable', sidebar: 'full', start: 'home', assistantName: '', nav: '', address: 'vy', webSearch: 'on' });

  const res = await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { theme: 'dark', accent: 'violet', background: 'aurora', start: 'tasks' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().prefs.accent, 'violet');
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { density: 'compact' } })).json().prefs.theme, 'dark', 'изменение поверх сохранённых');
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { accent: '#ff0000' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { background: 'media:999' } })).statusCode, 400, 'фото должно быть в медиатеке');
  // неизвестный параметр отбрасывается и ничего не меняет
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { color: 'red' } })).json().prefs.accent, 'violet');

  const after = (await app.inject({ url: '/admin/api/me', headers: anna })).json().user.prefs;
  assert.deepEqual(after, { theme: 'dark', accent: 'violet', background: 'aurora', density: 'compact', sidebar: 'full', start: 'tasks', assistantName: '', nav: '', address: 'vy', webSearch: 'on' });
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { assistantName: 'Сара' } })).json().prefs.assistantName, 'Сара');
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { assistantName: '<script>' } })).statusCode, 400);
  // порядок меню: свои разделы и спрятанные
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { nav: 'tasks,home,-templates' } })).json().prefs.nav, 'tasks,home,-templates');
  assert.equal((await app.inject({ method: 'PATCH', url: '/admin/api/me/prefs', headers: anna, payload: { nav: 'tasks,secret' } })).statusCode, 400);
  assert.equal((await app.inject({ url: '/admin/api/me', headers: oleg })).json().user.prefs.accent, 'soroka', 'у коллеги свои настройки');
});

test('фото профиля: загрузить, показать коллегам, удалить', async () => {
  const { app, auth } = await setup();
  auth.addUser('oleg', 'Олег', { password: PASSWORD, role: 'manager' });
  const login = async (l) => ({ cookie: `kval_admin=${(await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: l, password: PASSWORD } })).cookies.find((c) => c.name === 'kval_admin').value}` });
  const anna = await login('anna@soroka-marketing.ru');
  const oleg = await login('oleg');
  // PNG 2×2 — заголовок IHDR, остального для проверки размера достаточно
  const png = Buffer.alloc(64);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(2, 16);
  png.writeUInt32BE(2, 20);

  assert.equal((await app.inject({ method: 'PUT', url: '/admin/api/me/avatar', headers: { ...anna, 'content-type': 'image/png' }, payload: Buffer.from('not an image') })).statusCode, 400);
  const res = await app.inject({ method: 'PUT', url: '/admin/api/me/avatar', headers: { ...anna, 'content-type': 'image/png' }, payload: png });
  assert.equal(res.statusCode, 200, res.body);
  const ver = res.json().avatar;
  const me = (await app.inject({ url: '/admin/api/me', headers: oleg })).json();
  const annaId = Object.keys(me.avatars)[0];
  assert.equal(me.avatars[annaId], ver, 'коллеги знают, у кого есть фото');
  const img = await app.inject({ url: `/admin/api/users/${annaId}/avatar?v=${ver}`, headers: oleg });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.rawPayload.length, 64);
  assert.equal((await app.inject({ url: `/admin/api/users/${annaId}/avatar` })).statusCode, 401, 'без входа фото не отдаём');

  await app.inject({ method: 'DELETE', url: '/admin/api/me/avatar', headers: anna });
  assert.deepEqual((await app.inject({ url: '/admin/api/me', headers: oleg })).json().avatars, {});
  assert.equal((await app.inject({ url: `/admin/api/users/${annaId}/avatar`, headers: oleg })).statusCode, 404);
});
