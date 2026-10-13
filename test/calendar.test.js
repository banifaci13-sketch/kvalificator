import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { createCrm } from '../src/crm/store.js';
import { createCalendar, meetingsIcs } from '../src/calendar/store.js';
import { createVideo, VideoError } from '../src/calendar/video.js';
import { startReminders } from '../src/calendar/reminders.js';
import { rules, staticSource, silentLog } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
const log = { info() {}, warn() {}, error() {} };

function base() {
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna', 'Анна', { password: PASSWORD, role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: PASSWORD, role: 'manager' });
  const users = Object.fromEntries(auth.listUsers().map((u) => [u.login, { ...u }]));
  return { db, auth, users, calendar: createCalendar({ db: db.raw }), crm: createCrm({ db: db.raw }) };
}

async function setup(env = {}, video = null) {
  const b = base();
  const config = loadConfig({ DB_PATH: ':memory:', PUBLIC_URL: 'https://assist.example.ru', ...env });
  const qualifier = createQualifier({ db: b.db, scenarioSource: staticSource(), rules, log: silentLog });
  const app = await buildServer({
    config, qualifier, logger: false,
    admin: { auth: b.auth, reports: createReports(b.db.raw), db: b.db, scenarioSource: staticSource(), crm: b.crm, calendar: b.calendar, video: video ?? createVideo(config) },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  };
  return { ...b, app, as, config };
}

test('встреча: время по Москве хранится в UTC, участник по умолчанию — автор, период', async () => {
  const { as, users } = await setup();
  const anna = await as('anna');
  const res = await anna({ method: 'POST', url: '/admin/api/meetings', payload: { title: 'Созвон с Ромашкой', startsAt: '2026-10-20T14:00:00+03:00', duration: 45, format: 'online', provider: 'other', link: 'https://example.ru/room' } });
  assert.equal(res.statusCode, 200);
  const m = res.json().meeting;
  assert.equal(m.starts_at, '2026-10-20 11:00:00');
  assert.deepEqual(m.participants.map((p) => p.name), ['Анна']);
  assert.deepEqual(m.remind, [1440, 15]);

  const list = (from, to, mine = false) => anna({ url: `/admin/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${mine ? '&mine=true' : ''}` });
  assert.equal((await list('2026-10-20T00:00:00+03:00', '2026-10-21T00:00:00+03:00')).json().meetings.length, 1);
  assert.equal((await list('2026-10-21T00:00:00+03:00', '2026-10-22T00:00:00+03:00')).json().meetings.length, 0);

  const oleg = await as('oleg');
  const mine = await oleg({ url: `/admin/api/calendar?from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z&mine=true` });
  assert.equal(mine.json().meetings.length, 0, 'Олег не участник');
  const bad = await anna({ method: 'POST', url: '/admin/api/meetings', payload: { title: 'x', startsAt: '2026-10-20T14:00:00+03:00', link: 'http://insecure' } });
  assert.match(bad.json().error, /https/);
  // удалить чужую встречу нельзя, отменить — можно
  assert.equal((await oleg({ method: 'DELETE', url: `/admin/api/meetings/${m.id}` })).statusCode, 403);
  const cancelled = await oleg({ method: 'PUT', url: `/admin/api/meetings/${m.id}`, payload: { cancelled: true, participants: [users.anna.id, users.oleg.id] } });
  assert.equal(cancelled.json().meeting.cancelled, 1);
});

test('напоминания: в нужный момент, без повторов, заново после переноса', () => {
  const { calendar, users } = base();
  const anna = users.anna;
  calendar.linkTelegram(calendar.telegramLinkCode(anna.id), 111);
  const start = new Date('2026-10-20T11:00:00Z');
  const m = calendar.create({ title: 'Защита стратегии', startsAt: start.toISOString(), remind: [1440, 15] }, anna);
  const at = (minBefore) => new Date(start.getTime() - minBefore * 60_000);

  assert.equal(calendar.dueReminders(at(1500)).length, 0, 'рано');
  const day = calendar.dueReminders(at(1439));
  assert.equal(day.length, 1);
  assert.equal(day[0].offset, 1440);
  assert.equal(day[0].user.chatId, '111');
  calendar.markSent(day[0]);
  assert.equal(calendar.dueReminders(at(600)).length, 0, 'суточное уже ушло');
  const soon = calendar.dueReminders(at(14));
  assert.equal(soon[0].offset, 15);
  calendar.markSent(soon[0]);
  assert.equal(calendar.dueReminders(at(5)).length, 0);
  assert.equal(calendar.dueReminders(new Date(start.getTime() + 60_000)).length, 0, 'после начала не напоминаем');

  // перенос на день позже — напоминания приходят снова
  const moved = new Date(start.getTime() + 24 * 3600_000);
  calendar.update(m.id, { startsAt: moved.toISOString() });
  assert.equal(calendar.dueReminders(new Date(moved.getTime() - 10 * 60_000))[0].offset, 15);
  // без Telegram сотруднику не напоминаем
  calendar.unlinkTelegram(anna.id);
  assert.equal(calendar.dueReminders(new Date(moved.getTime() - 10 * 60_000)).length, 0);
});

test('рассылка: текст напоминания и утренний план со встречами и задачами', async () => {
  const { calendar, crm, users } = base();
  const anna = users.anna;
  calendar.linkTelegram(calendar.telegramLinkCode(anna.id), 222);
  const client = crm.createClient({ name: 'ООО Ромашка' }, anna);
  calendar.create({ title: 'Созвон по отчёту', startsAt: '2026-10-20T15:00:00+03:00', clientId: client.id, format: 'online', provider: 'telemost', link: 'https://telemost.yandex.ru/j/123', remind: [60] }, anna);
  crm.createTask({ title: 'Сдать отчёт', clientId: client.id, assigneeId: anna.id, due: '2026-10-19' }, anna);
  crm.createTask({ title: 'Не моя задача', due: '2026-10-19' }, anna);

  const sent = [];
  let now = new Date('2026-10-20T09:30:00+03:00');
  const r = startReminders({ calendar, crm, send: async (chat, text) => sent.push({ chat, text }), log, publicUrl: 'https://assist.example.ru', intervalMs: 3_600_000, now: () => now });
  r.stop();
  await r.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /план на сегодня/);
  assert.match(sent[0].text, /15:00 — Созвон по отчёту \(ООО Ромашка\)/);
  assert.match(sent[0].text, /просрочено: Сдать отчёт/);
  assert.doesNotMatch(sent[0].text, /Не моя задача/);
  await r.tick();
  assert.equal(sent.length, 1, 'сводка — раз в день');

  now = new Date('2026-10-20T14:01:00+03:00');
  await r.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Через час: Созвон по отчёту/);
  assert.match(sent[1].text, /href="https:\/\/telemost\.yandex\.ru\/j\/123"/);
  assert.match(sent[1].text, /Клиент: ООО Ромашка/);
});

test('подписка на календарь: ссылка сотрудника, формат iCalendar', async () => {
  const { app, as } = await setup();
  const anna = await as('anna');
  await anna({ method: 'POST', url: '/admin/api/meetings', payload: { title: 'Очень длинное название встречи, чтобы проверить перенос строк в файле календаря, где строки ограничены', startsAt: '2026-10-20T14:00:00+03:00', agenda: 'Обсудить: бюджет; сроки, отчёт' } });
  const { url } = (await anna({ method: 'POST', url: '/admin/api/me/calendar-token', payload: {} })).json();
  assert.match(url, /^https:\/\/assist\.example\.ru\/calendar\/[\w-]+\.ics$/);
  const path = new URL(url).pathname;
  const ics = await app.inject({ url: path });
  assert.equal(ics.statusCode, 200);
  assert.match(ics.headers['content-type'], /text\/calendar/);
  assert.match(ics.body, /BEGIN:VEVENT\r\nUID:meeting-1@assist\.example\.ru/);
  assert.match(ics.body, /DTSTART:20261020T110000Z/);
  assert.match(ics.body, /Обсудить: бюджет\\; сроки\\, отчёт/);
  for (const line of ics.body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `строка длиннее 75 байт: ${line}`);
  // новая ссылка — старая перестаёт работать
  await anna({ method: 'POST', url: '/admin/api/me/calendar-token', payload: { regenerate: true } });
  assert.equal((await app.inject({ url: path })).statusCode, 404);
  assert.equal((await app.inject({ url: '/calendar/wrong.ics' })).statusCode, 404);
  assert.match(meetingsIcs([], {}), /END:VCALENDAR\r\n$/);
});

test('Zoom и Телемост: запросы к API и понятные ошибки', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).startsWith('https://zoom.us/oauth/token')) return json({ access_token: 'tok', expires_in: 3600 });
    if (String(url).includes('api.zoom.us')) return json({ id: 987, join_url: 'https://zoom.us/j/987', start_url: 'https://zoom.us/s/987' });
    if (String(url).includes('telemost-api')) return json({ id: 'abc', join_url: 'https://telemost.yandex.ru/j/abc' });
    return json({}, 404);
  };
  const video = createVideo(
    { zoom: { accountId: 'acc', clientId: 'id', clientSecret: 'sec', user: 'host@agency.ru' }, telemost: { token: 'ya', waitingRoom: 'ORGANIZATION' } },
    { fetchImpl },
  );
  assert.deepEqual(video.available, { zoom: true, telemost: true });
  const start = new Date('2026-10-20T11:00:00Z');
  const z = await video.create('zoom', { title: 'Созвон', start, duration: 30 });
  assert.deepEqual(z, { provider: 'zoom', link: 'https://zoom.us/j/987', hostLink: 'https://zoom.us/s/987', externalId: '987' });
  assert.match(calls[0].url, /grant_type=account_credentials&account_id=acc/);
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('id:sec').toString('base64')}`);
  assert.match(calls[1].url, /users\/host%40agency\.ru\/meetings$/);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.start_time, '2026-10-20T14:00:00', 'время по Москве');
  assert.equal(body.timezone, 'Europe/Moscow');
  await video.create('zoom', { title: 'Ещё', start, duration: 30 });
  assert.equal(calls.filter((c) => c.url.includes('oauth/token')).length, 1, 'токен Zoom переиспользуется');

  const t = await video.create('telemost', { title: 'Созвон', start, duration: 30 });
  assert.equal(t.link, 'https://telemost.yandex.ru/j/abc');
  const tc = calls.at(-1);
  assert.equal(tc.init.headers.authorization, 'OAuth ya');
  assert.deepEqual(JSON.parse(tc.init.body), { waiting_room_level: 'ORGANIZATION' });

  const failing = createVideo({ telemost: { token: 'x' } }, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'ApiRestrictedToOrganizations' }) }) });
  await assert.rejects(failing.create('telemost', { title: 'x', start, duration: 30 }), (err) => err instanceof VideoError && /Телемост: ApiRestrictedToOrganizations/.test(err.message));

  // не настроено — через API понятная ошибка
  const { as } = await setup();
  const anna = await as('anna');
  const res = await anna({ method: 'POST', url: '/admin/api/video', payload: { provider: 'zoom', title: 'x', startsAt: start.toISOString() } });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /ZOOM_ACCOUNT_ID/);
});

test('итоги встречи: резюме, список договорённостей → задачи исполнителям в проекте клиента', async () => {
  const { as, crm, users } = await setup();
  const anna = await as('anna');
  const oleg = await as('oleg');
  const client = crm.createClient({ name: 'Таллер' }, { name: 'Анна' });
  const m = (await anna({ method: 'POST', url: '/admin/api/meetings', payload: { title: 'Стратсессия Таллер', startsAt: '2026-10-20T14:00:00+03:00', clientId: client.id, participants: [users.anna.id, users.oleg.id] } })).json().meeting;

  const parsed = (await anna({ method: 'POST', url: `/admin/api/meetings/${m.id}/followup/parse`, payload: { text: '- Олег — креативы для РСЯ до 24.10 срочно\n- Анне: согласовать бюджет с клиентом 22.10 в 12\n- отправить клиенту отчёт' } })).json().items;
  assert.deepEqual(parsed.map((i) => [i.title, i.assigneeName, i.due, i.dueTime, i.priority]), [
    ['Креативы для РСЯ', 'Олег', '2026-10-24', null, 3],
    ['Согласовать бюджет с клиентом', 'Анна', '2026-10-22', '12:00', 0],
    ['Отправить клиенту отчёт', null, null, null, 0],
  ]);

  const res = await anna({ method: 'POST', url: `/admin/api/meetings/${m.id}/followup`, payload: { summary: 'Договорились запустить РСЯ до конца месяца.', send: true, items: parsed.map(({ title, assigneeId, due, dueTime, priority }) => ({ title, assigneeId, due, dueTime, priority })) } });
  assert.equal(res.statusCode, 200, res.body);
  const { meeting, tasks } = res.json();
  assert.equal(meeting.summary, 'Договорились запустить РСЯ до конца месяца.');
  assert.equal(meeting.summary_by, 'Анна');
  assert.equal(tasks.length, 3);
  assert.ok(tasks.every((t) => t.client_id === client.id), 'в проекте клиента встречи');
  assert.equal(tasks[0].assignee_id, users.oleg.id);
  assert.deepEqual(crm.linkedTasks('meeting', m.id).length, 3, 'задачи связаны со встречей');
  const olegNotes = (await oleg({ url: '/admin/api/notifications' })).json().items.map((n) => n.text);
  assert.ok(olegNotes.some((t) => /^Итоги встречи «Стратсессия Таллер»: задач — 3, ваших — 1/.test(t)));
  assert.ok(olegNotes.some((t) => /^Вам поручена задача «Креативы для РСЯ»/.test(t)));
  // на доске Олега — в «Моих задачах»
  assert.ok((await oleg({ url: '/admin/api/tasks?mine=true' })).json().tasks.some((t) => t.title === 'Креативы для РСЯ'));
});
