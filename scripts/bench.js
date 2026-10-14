// Замер скорости основных экранов на синтетических данных: npm run bench [-- --scale 2]
// База создаётся во временной папке и удаляется; рабочие данные не трогаются. Объём по умолчанию —
// с запасом для агентства: 30 сотрудников, 300 клиентов, 6000 задач, 3000 заявок, 20 000 сообщений.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { createCrm } from '../src/crm/store.js';
import { createCalendar } from '../src/calendar/store.js';
import { createFiles } from '../src/files/store.js';
import { createMoney } from '../src/crm/money.js';

const scaleArg = process.argv.indexOf('--scale');
const S = scaleArg > -1 ? Number(process.argv[scaleArg + 1]) : 1;
const N = { users: 30, clients: 300 * S, tasks: 6000 * S, leads: 3000 * S, messages: 20000 * S, meetings: 1500 * S };
const PASSWORD = 'bench-password-123';

const dir = mkdtempSync(join(tmpdir(), 'kval-bench-'));
const dbPath = join(dir, 'bench.db');
const db = openDb(dbPath);
const raw = db.raw;
const auth = createAuth(raw);
const crm = createCrm({ db: raw });
const calendar = createCalendar({ db: raw });
const t0 = performance.now();
raw.exec('PRAGMA synchronous = OFF'); // только на время наполнения временной базы

// ---------- данные ----------
for (let i = 0; i < N.users; i++) auth.addUser(`user${i}`, `Сотрудник ${i}`, { password: PASSWORD, role: i === 0 ? 'admin' : 'manager' });
const users = auth.listUsers();
const sys = { id: users[0].id, name: users[0].name, role: 'admin' };
raw.exec('BEGIN');
const clients = [];
for (let i = 0; i < N.clients; i++) clients.push(crm.createClient({ name: `Клиент ${i}`, managerId: users[i % users.length].id }, sys));
raw.exec('COMMIT');
const day = (d) => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
for (let i = 0; i < N.tasks; i++) {
  crm.createTask({
    title: `Задача ${i}: подготовить отчёт`, clientId: clients[i % clients.length].id,
    assigneeId: users[i % users.length].id, due: day((i % 40) - 10), priority: i % 5,
  }, sys);
}
const insLead = raw.prepare(`INSERT INTO leads (session_id, channel, rating, score, reasons, tags, answers, meta, status, created_at)
  VALUES (?, 'web', ?, 1, '[]', '[]', ?, '{}', 'new', datetime('now', ?))`);
const insSession = raw.prepare("INSERT INTO sessions (id, token, channel, state) VALUES (?, 'x', 'web', '{}')");
raw.exec('BEGIN');
for (let i = 0; i < N.leads; i++) {
  const sid = randomUUID();
  insSession.run(sid);
  insLead.run(sid, 1 + (i % 5), JSON.stringify({ company: `Компания ${i}`, contact: `+7900${String(i).padStart(7, '0')}` }), `-${i % 365} days`);
}
raw.exec('COMMIT');
for (let i = 0; i < N.meetings; i++) {
  calendar.create({ title: `Встреча ${i}`, startsAt: new Date(Date.now() + ((i % 120) - 60) * 86400e3).toISOString(), participantIds: [users[i % users.length].id] }, sys);
}
// чаты: личные пары и сообщения
const insChat = raw.prepare("INSERT INTO chats (kind, created_by) VALUES ('direct', ?)");
const insMember = raw.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)');
const insMsg = raw.prepare('INSERT INTO chat_messages (chat_id, author_id, author, body) VALUES (?, ?, ?, ?)');
raw.exec('BEGIN');
const chats = [];
for (let i = 1; i < users.length; i++) {
  const { lastInsertRowid } = insChat.run(users[0].id);
  insMember.run(lastInsertRowid, users[0].id);
  insMember.run(lastInsertRowid, users[i].id);
  chats.push(Number(lastInsertRowid));
}
for (let i = 0; i < N.messages; i++) {
  const c = chats[i % chats.length];
  insMsg.run(c, i % 2 ? users[0].id : users[(i % (users.length - 1)) + 1].id, 'x', `Сообщение ${i}`);
}
raw.exec('COMMIT');
const seedMs = performance.now() - t0;
raw.exec('PRAGMA synchronous = NORMAL');

// ---------- сервер ----------
const config = loadConfig({ DB_PATH: dbPath });
const files = createFiles({ db: raw, dir });
const app = await buildServer({
  config,
  qualifier: createQualifier({ db, scenarioSource: { get: () => ({ steps: [] }), stop() {} }, rules: {}, log: { info() {}, warn() {}, error() {} } }),
  logger: false,
  admin: { auth, reports: createReports(raw), db, scenarioSource: { get: () => ({ steps: [] }) }, crm, calendar, files, money: createMoney({ db: raw }) },
});
const login = async (l) => {
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: l, password: PASSWORD } });
  const c = res.cookies.find((x) => x.name === 'kval_admin');
  return (url) => app.inject({ url, headers: { cookie: `kval_admin=${c.value}` } });
};
const admin = await login('user0');
const manager = await login('user5');

const from = new Date(Date.now() - 3 * 86400e3).toISOString();
const to = new Date(Date.now() + 4 * 86400e3).toISOString();
const CASES = [
  ['Главная (администратор)', admin, '/admin/api/home'],
  ['Главная (менеджер)', manager, '/admin/api/home'],
  ['Список клиентов', admin, '/admin/api/clients'],
  ['Проекты (меню задач)', admin, '/admin/api/projects'],
  ['Задачи проекта', admin, `/admin/api/tasks?client=${clients[7].id}`],
  ['Мои задачи', manager, '/admin/api/tasks?mine=true'],
  ['Заявки', admin, '/admin/api/leads'],
  ['Сводка квалификатора', admin, '/admin/api/stats'],
  ['Календарь на неделю', admin, `/admin/api/calendar?from=${from}&to=${to}`],
  ['Список чатов', admin, '/admin/api/chats'],
  ['Сообщения чата', admin, `/admin/api/chats/${chats[0]}/messages`],
  ['Новые сообщения (опрос)', manager, '/admin/api/chats/incoming?after=0'],
  ['Уведомления (опрос)', manager, '/admin/api/notifications?after=0'],
  ['Деньги', admin, '/admin/api/money'],
];
const RUNS = 40;
const pct = (arr, p) => arr.sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const rows = [];
for (const [name, as, url] of CASES) {
  const res = await as(url);
  if (res.statusCode !== 200) {
    rows.push({ name, status: `${res.statusCode} ${res.body.slice(0, 80)}` });
    continue;
  }
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const s = performance.now();
    await as(url);
    times.push(performance.now() - s);
  }
  rows.push({ name, p50: pct(times, 50), p95: pct(times, 95), kb: res.rawPayload.length / 1024 });
}
await app.close();
const size = statSync(dbPath).size + (statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0);
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(`Данные: ${Object.entries(N).map(([k, v]) => `${k} ${v}`).join(', ')}; наполнение ${(seedMs / 1000).toFixed(1)} с; база ${(size / 1048576).toFixed(1)} МБ`);
console.log(`Node ${process.version}, ${RUNS} запросов на экран (без сети и TLS — только время сервера)\n`);
console.log('| Экран | p50, мс | p95, мс | Ответ, КБ |\n|---|---:|---:|---:|');
for (const r of rows) console.log(r.status ? `| ${r.name} | код ${r.status} | | |` : `| ${r.name} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.kb.toFixed(0)} |`);
