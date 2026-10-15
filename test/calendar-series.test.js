import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { createCalendar, mskDate, mskTime } from '../src/calendar/store.js';
import { createVideo } from '../src/calendar/video.js';
import { seriesDates, repeatLabel, normalizeRepeat, addDays } from '../src/calendar/series.js';
import { rules, staticSource, silentLog } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
const dates = (rule, to) => [...seriesDates(rule, { to })].map((x) => x.date);

test('правила повтора: даты по Москве', () => {
  // 2026-10-15 — четверг
  assert.deepEqual(dates({ rule: 'weekdays', start: '2026-10-15' }, '2026-10-21'), ['2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21']);
  assert.deepEqual(dates({ rule: 'weekly', days: [1, 4], start: '2026-10-15' }, '2026-10-29'), ['2026-10-15', '2026-10-19', '2026-10-22', '2026-10-26', '2026-10-29']);
  assert.deepEqual(dates({ rule: 'biweekly', days: [4], start: '2026-10-15' }, '2026-11-30'), ['2026-10-15', '2026-10-29', '2026-11-12', '2026-11-26']);
  assert.deepEqual(dates({ rule: 'monthly', start: '2026-01-31' }, '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'], '31-го — в коротких месяцах последний день');
  // 15.10.2026 — третий четверг октября
  assert.deepEqual(dates({ rule: 'monthly_weekday', start: '2026-10-15' }, '2027-01-31'), ['2026-10-15', '2026-11-19', '2026-12-17', '2027-01-21']);
  assert.deepEqual(dates({ rule: 'monthly_weekday', start: '2026-10-29' }, '2026-12-31'), ['2026-10-29', '2026-11-26', '2026-12-31'], 'последний четверг');
  assert.deepEqual(dates({ rule: 'daily', start: '2026-10-15', count: 3 }, '2026-12-31'), ['2026-10-15', '2026-10-16', '2026-10-17']);
  assert.deepEqual(dates({ rule: 'weekly', start: '2026-10-15', until: '2026-10-29' }, '2026-12-31'), ['2026-10-15', '2026-10-22', '2026-10-29']);

  assert.equal(repeatLabel({ rule: 'weekly', days: [1, 4], start: '2026-10-15', until: '2026-12-31' }, '10:00'), 'Каждую неделю по пн и чт в 10:00, до 31 декабря 2026 г.');
  assert.equal(repeatLabel({ rule: 'monthly_weekday', start: '2026-10-30' }), 'Каждый месяц в последнюю пятницу');
  assert.equal(repeatLabel({ rule: 'monthly_weekday', start: '2026-10-13' }), 'Каждый месяц во второй вторник'.replace('во ', 'в '));
  assert.equal(repeatLabel({ rule: 'daily', start: '2026-10-15', count: 22 }), 'Каждый день, 22 встречи');
  assert.equal(normalizeRepeat({ rule: 'weekly', until: '2026-01-01' }, '2026-10-15').error, 'Дата окончания раньше первой встречи');
  assert.deepEqual(normalizeRepeat({ rule: 'weekly' }, '2026-10-15').days, [4], 'по умолчанию — день недели первой встречи');
});

function base() {
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna', 'Анна', { password: PASSWORD, role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: PASSWORD, role: 'manager' });
  const users = Object.fromEntries(auth.listUsers().map((u) => [u.login, { ...u }]));
  return { db, users, calendar: createCalendar({ db: db.raw }), auth };
}
// ближайший понедельник через неделю, 10:00 по Москве
const nextMonday = () => {
  const today = mskDate(new Date().toISOString().replace('T', ' ').slice(0, 19));
  const wd = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return addDays(today, 8 - wd + 7);
};
const at = (date, time = '10:00') => `${date}T${time}:00+03:00`;

test('регулярная встреча: серия на полгода, правка «эта и следующие», отмена и удаление', () => {
  const { calendar, users, db } = base();
  const mon = nextMonday();
  const first = calendar.create({ title: 'Планёрка', startsAt: at(mon), duration: 30, repeat: { rule: 'weekly', days: [1, 3] }, participants: [users.anna.id, users.oleg.id] }, users.anna);
  assert.equal(mskDate(first.starts_at), mon);
  assert.equal(first.series.label, 'Каждую неделю по пн и ср в 10:00');
  const all = () => db.raw.prepare('SELECT * FROM meetings WHERE series_id = ? ORDER BY starts_at').all(first.series.id);
  const n = all().length;
  assert.ok(n >= 45 && n <= 54, `около полугода вперёд: ${n}`);
  assert.deepEqual(calendar.get(all()[1].id).participants.map((p) => p.name).sort(), ['Анна', 'Олег'], 'участники у каждой встречи');

  // только эта: перенос одной встречи не трогает остальные
  const second = all()[1];
  calendar.update(second.id, { startsAt: at(mskDate(second.starts_at), '15:00') });
  assert.equal(mskTime(calendar.get(second.id).starts_at), '15:00');
  assert.equal(mskTime(all()[2].starts_at), '10:00');

  // эта и следующие: тема и время меняются у всех следующих, прошлые — как были
  const third = all()[2];
  calendar.update(third.id, { title: 'Планёрка команды', startsAt: at(mskDate(third.starts_at), '11:00') }, { scope: 'following' });
  const after = all();
  assert.equal(after[0].title, 'Планёрка');
  assert.ok(after.slice(2).every((m) => m.title === 'Планёрка команды' && mskTime(m.starts_at) === '11:00'));
  assert.equal(calendar.get(third.id).series.time, '11:00', 'новые встречи серии — тоже в 11:00');

  // сменить правило с пятой встречи: раз в две недели по пятницам
  const fifth = all()[4];
  calendar.update(fifth.id, { repeat: { rule: 'biweekly', days: [5] } }, { scope: 'following' });
  const old = all();
  assert.equal(old.length, 4, 'старая серия заканчивается перед пятой встречей');
  const moved = calendar.get(fifth.id);
  assert.notEqual(moved.series.id, first.series.id);
  assert.match(moved.series.label, /^Раз в две недели по пт/);

  // отменить эту и следующие: будущих встреч нет, эта — отменённая в истории
  const later = db.raw.prepare('SELECT * FROM meetings WHERE series_id = ? ORDER BY starts_at').all(moved.series.id);
  calendar.update(later[2].id, { cancelled: true }, { scope: 'following' });
  const rest = db.raw.prepare('SELECT * FROM meetings WHERE series_id = ? ORDER BY starts_at').all(moved.series.id);
  assert.equal(rest.length, 3);
  assert.equal(rest[2].cancelled, 1);
  assert.equal(calendar.extendSeries(new Date(Date.now() + 400 * 864e5)), 0, 'законченная серия не продлевается');

  // удалить эту и следующие
  calendar.remove(old[1].id, { scope: 'following' });
  assert.equal(all().length, 1);
  assert.throws(() => calendar.update(all()[0].id, { repeat: { rule: 'daily' } }), /для этой и следующих/);
});

test('серия продлевается вперёд; количество встреч и разовая встреча → регулярная', () => {
  const { calendar, users, db } = base();
  const mon = nextMonday();
  const s = calendar.create({ title: 'Отчёт клиенту', startsAt: at(mon), repeat: { rule: 'monthly', count: 3 } }, users.anna);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM meetings WHERE series_id = ?').get(s.series.id).n, 3);

  const daily = calendar.create({ title: 'Стендап', startsAt: at(mon, '09:30'), duration: 15, repeat: { rule: 'weekdays' } }, users.anna);
  const count = () => db.raw.prepare('SELECT count(*) n FROM meetings WHERE series_id = ?').get(daily.series.id).n;
  const before = count();
  assert.ok(calendar.extendSeries(new Date(Date.now() + 30 * 864e5)) > 0);
  assert.ok(count() > before + 15, 'через месяц серия продлена ещё на месяц');
  assert.equal(calendar.extendSeries(new Date(Date.now() + 30 * 864e5)), 0, 'повторный запуск ничего не дублирует');

  const one = calendar.create({ title: 'Созвон', startsAt: at(mon, '16:00') }, users.oleg);
  assert.equal(one.series, null);
  const now = calendar.update(one.id, { repeat: { rule: 'weekly', count: 4 } });
  assert.equal(now.series.label, 'Каждую неделю по пн в 16:00, 4 встречи');
  assert.equal(db.raw.prepare('SELECT count(*) n FROM meetings WHERE series_id = ?').get(now.series.id).n, 4);
  assert.throws(() => calendar.create({ title: 'x', startsAt: at(mon), repeat: { rule: 'weekly', until: addDays(mon, -3) } }, users.anna), /раньше первой/);
});

test('API: создание серии, уведомление одно, правка и удаление с scope', async () => {
  const b = base();
  const config = loadConfig({ DB_PATH: ':memory:', PUBLIC_URL: 'https://assist.example.ru' });
  const qualifier = createQualifier({ db: b.db, scenarioSource: staticSource(), rules, log: silentLog });
  const app = await buildServer({
    config, qualifier, logger: false,
    admin: { auth: b.auth, reports: createReports(b.db.raw), db: b.db, scenarioSource: staticSource(), calendar: b.calendar, video: createVideo(config) },
  });
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'anna', password: PASSWORD } });
  const cookie = `kval_admin=${res.cookies.find((x) => x.name === 'kval_admin').value}`;
  const call = (opts) => app.inject({ ...opts, headers: { cookie } });

  const settings = (await call({ method: 'GET', url: '/admin/api/calendar/settings' })).json();
  assert.ok(settings.repeats.weekly);
  const mon = nextMonday();
  let r = await call({ method: 'POST', url: '/admin/api/meetings', payload: { title: 'Планёрка', startsAt: at(mon), repeat: { rule: 'weekly', days: [1] }, participants: [b.users.anna.id, b.users.oleg.id] } });
  assert.equal(r.statusCode, 200, r.body);
  const m = r.json().meeting;
  assert.equal(m.series.label, 'Каждую неделю по пн в 10:00');
  const notes = b.db.raw.prepare("SELECT text FROM notifications WHERE kind = 'meeting'").all();
  assert.equal(notes.length, 1, 'одно уведомление Олегу (себе автор не получает), а не на каждую встречу');
  assert.match(notes[0].text, /регулярную встречу «Планёрка» — каждую неделю по пн в 10:00, первая/);

  r = await call({ method: 'POST', url: '/admin/api/meetings', payload: { title: 'x', startsAt: at(mon), repeat: { rule: 'yearly' } } });
  assert.equal(r.statusCode, 400);

  const second = b.db.raw.prepare('SELECT id FROM meetings WHERE series_id = ? ORDER BY starts_at LIMIT 1 OFFSET 1').get(m.series.id).id;
  r = await call({ method: 'PUT', url: `/admin/api/meetings/${second}`, payload: { title: 'Планёрка v2', scope: 'following' } });
  assert.equal(r.json().meeting.title, 'Планёрка v2');
  assert.equal(b.calendar.get(m.id).title, 'Планёрка');
  r = await call({ method: 'DELETE', url: `/admin/api/meetings/${second}?scope=following` });
  assert.equal(r.statusCode, 200);
  assert.equal(b.db.raw.prepare('SELECT count(*) n FROM meetings WHERE series_id = ?').get(m.series.id).n, 1);
});
