import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { createCrm } from '../src/crm/store.js';
import { rules, staticSource, silentLog, typicalAnswers } from './helpers.js';

const PASSWORD = 'correct-horse-battery';

async function setup() {
  const config = loadConfig({ DB_PATH: ':memory:' });
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna', 'Анна', { password: PASSWORD, role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: PASSWORD, role: 'manager' });
  auth.addUser('ira', 'Ира', { password: PASSWORD, role: 'manager' });
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog });
  const app = await buildServer({
    config, qualifier, logger: false,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), crm: createCrm({ db: db.raw }) },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  };
  return { as, qualifier };
}

test('клиент из заявки: название и контакт из ответов, повторно — нельзя', async () => {
  const { as, qualifier } = await setup();
  const { session } = qualifier.startSession({ channel: 'web' });
  let reply = qualifier.resume(session);
  while (reply.type === 'question') {
    const { id, required } = reply.step;
    reply = await qualifier.answer(session.id, id in typicalAnswers ? { value: typicalAnswers[id] } : { skip: !required });
  }
  const oleg = await as('oleg');
  const lead = (await oleg({ url: '/admin/api/leads' })).json().leads[0];
  const res = await oleg({ method: 'POST', url: '/admin/api/clients', payload: { fromLead: lead.id } });
  assert.equal(res.statusCode, 200);
  const client = res.json().client;
  assert.equal(client.name, lead.answers.company.raw ?? lead.answers.company);
  assert.equal(client.lead_id, lead.id);
  assert.equal(client.manager_name, 'Олег');
  assert.equal((await oleg({ method: 'POST', url: '/admin/api/clients', payload: { fromLead: lead.id } })).statusCode, 400);
});

test('задачи: колонки вместо статусов, выполнение, лента изменений, комментарии', async () => {
  const { as } = await setup();
  const anna = await as('anna');
  const oleg = await as('oleg');
  const ira = await as('ira');
  const team = (await oleg({ url: '/admin/api/team' })).json().team;
  const id = (name) => team.find((u) => u.name === name).id;
  assert.equal(team.length, 3);

  const client = (await anna({ method: 'POST', url: '/admin/api/clients', payload: { name: 'ООО Ромашка', managerId: id('Анна') } })).json().client;
  assert.equal((await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: ' ' } })).statusCode, 400);
  const bad = await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'x', due: '13.10.2026' } });
  assert.match(bad.json().error, /ГГГГ-ММ-ДД/);

  // задача по клиенту без доски — в первую колонку первой доски проекта
  const task = (await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Собрать семантику', clientId: client.id, assigneeId: id('Олег'), due: '2026-10-20', priority: 3 } })).json().task;
  assert.equal((await anna({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { priority: 7 } })).statusCode, 400);
  assert.equal(task.status, 'todo');
  assert.equal(task.client_name, 'ООО Ромашка');
  assert.deepEqual([task.board_name, task.column_name], ['Задачи', 'К выполнению']);
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Внутренняя задача' } });

  const mine = (await oleg({ url: '/admin/api/tasks?mine=true' })).json().tasks;
  assert.deepEqual(mine.map((t) => t.title), ['Собрать семантику']);
  assert.equal((await oleg({ url: `/admin/api/tasks?client=${client.id}` })).json().tasks.length, 1);

  const [board] = (await oleg({ url: `/admin/api/projects/${client.id}/boards` })).json().boards;
  const col = Object.fromEntries(board.columns.map((c) => [c.name, c]));
  assert.deepEqual(board.columns.map((c) => [c.name, c.is_done]), [['К выполнению', 0], ['В работе', 0], ['На проверке', 0], ['Готово', 1]]);

  const moved = await oleg({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { columnId: col['В работе'].id } });
  assert.equal(moved.statusCode, 200);
  await oleg({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { assigneeId: id('Ира'), columnId: col['На проверке'].id, priority: 4 } });
  await ira({ method: 'POST', url: `/admin/api/tasks/${task.id}/comments`, payload: { text: 'Проверю до вечера' } });
  // галочка «выполнено» — задача остаётся в своей колонке
  const checked = (await ira({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { done: true } })).json().task;
  assert.equal(checked.status, 'done');
  assert.equal(checked.column_name, 'На проверке');
  assert.ok(checked.done_at);
  await ira({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { done: false } });
  // в колонку «Готово» — выполнена автоматически
  const done = (await ira({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { columnId: col['Готово'].id } })).json().task;
  assert.equal(done.status, 'done');
  const feed = done.comments.map((c) => `${c.author}: ${c.text}`);
  assert.deepEqual(feed, [
    'Олег: К выполнению → В работе',
    'Олег: В работе → На проверке',
    'Олег: Исполнитель: Ира',
    'Олег: Важность: Критичная',
    'Ира: Проверю до вечера',
    'Ира: Выполнена',
    'Ира: Снова в работе',
    'Ира: На проверке → Готово',
    'Ира: Выполнена',
  ]);
  const card = (await anna({ url: `/admin/api/clients/${client.id}` })).json();
  assert.equal(card.client.open_tasks ?? 0, 0);
  assert.equal(card.tasks[0].comments, 1);

  // в другой проект — на его первую доску
  const other = (await anna({ method: 'POST', url: '/admin/api/clients', payload: { name: 'Бета' } })).json().client;
  const away = (await anna({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { clientId: other.id } })).json().task;
  assert.deepEqual([away.client_name, away.column_name, away.status], ['Бета', 'К выполнению', 'todo']);

  // удалить — автор или администратор
  assert.equal((await oleg({ method: 'DELETE', url: `/admin/api/tasks/${task.id}` })).statusCode, 400);
  assert.equal((await anna({ method: 'DELETE', url: `/admin/api/tasks/${task.id}` })).statusCode, 200);
  // клиента удаляет администратор, остальные — в архив
  assert.equal((await oleg({ method: 'DELETE', url: `/admin/api/clients/${client.id}` })).statusCode, 403);
  const archived = (await oleg({ method: 'PUT', url: `/admin/api/clients/${client.id}`, payload: { archived: true } })).json().client;
  assert.equal(archived.archived, 1);
  assert.deepEqual((await oleg({ url: '/admin/api/clients' })).json().clients.map((c) => c.name), ['Бета']);
});

test('проекты: клиенты и «Общие задачи», доски-вкладки, свои колонки', async () => {
  const { as } = await setup();
  const anna = await as('anna');
  const team = (await anna({ url: '/admin/api/team' })).json().team;
  const annaId = team.find((u) => u.name === 'Анна').id;
  const a = (await anna({ method: 'POST', url: '/admin/api/clients', payload: { name: 'Альфа' } })).json().client;
  await anna({ method: 'POST', url: '/admin/api/clients', payload: { name: 'Бета' } });
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Аудит', clientId: a.id, assigneeId: annaId, due: '2020-01-01' } });
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Запуск', clientId: a.id } });
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Обновить шаблоны КП' } });

  const projects = (await anna({ url: '/admin/api/projects' })).json().projects;
  assert.deepEqual(projects.map((p) => [p.name, p.open, p.overdue, p.mine]), [['Альфа', 2, 1, 1], ['Бета', 0, 0, 0], ['Общие задачи', 1, 0, 0]]);

  // вторая доска «Трафик» со своими колонками
  const traffic = (await anna({ method: 'POST', url: '/admin/api/boards', payload: { clientId: a.id, name: 'Трафик' } })).json().board;
  assert.equal(traffic.columns.length, 4);
  const [todo, , review, ready] = traffic.columns;
  const client = (await anna({ method: 'POST', url: `/admin/api/boards/${traffic.id}/columns`, payload: { name: 'На проверке у клиента', color: 'cyan' } })).json().column;
  assert.equal(client.position, 4);
  // переставить левее «Готово», переименовать, удалить пустую
  await anna({ method: 'PATCH', url: `/admin/api/columns/${client.id}`, payload: { move: -1 } });
  await anna({ method: 'PATCH', url: `/admin/api/columns/${review.id}`, payload: { name: 'На проверке в Сороке' } });
  assert.equal((await anna({ method: 'PATCH', url: `/admin/api/columns/${review.id}`, payload: { color: '#ff0000' } })).statusCode, 400);
  let boards = (await anna({ url: `/admin/api/projects/${a.id}/boards` })).json().boards;
  assert.deepEqual(boards.map((b) => b.name), ['Задачи', 'Трафик']);
  assert.deepEqual(boards[1].columns.map((c) => c.name), ['К выполнению', 'В работе', 'На проверке в Сороке', 'На проверке у клиента', 'Готово']);

  // задача на доску — в первую колонку; доску с задачами и колонку с задачами не удалить
  const t = (await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'РК по Самаре', boardId: traffic.id } })).json().task;
  assert.deepEqual([t.board_name, t.column_name], ['Трафик', 'К выполнению']);
  assert.match((await anna({ method: 'DELETE', url: `/admin/api/columns/${todo.id}` })).json().error, /перенесите/);
  assert.match((await anna({ method: 'DELETE', url: `/admin/api/boards/${traffic.id}` })).json().error, /перенесите или удалите/);
  assert.equal((await anna({ url: `/admin/api/tasks?board=${traffic.id}` })).json().tasks.length, 1);

  // колонка «выполнено»: отметка переносится на задачи в ней
  await anna({ method: 'PATCH', url: `/admin/api/columns/${todo.id}`, payload: { isDone: true } });
  assert.equal((await anna({ url: `/admin/api/tasks/${t.id}` })).json().task.status, 'done');
  await anna({ method: 'PATCH', url: `/admin/api/columns/${todo.id}`, payload: { isDone: false } });
  assert.equal((await anna({ url: `/admin/api/tasks/${t.id}` })).json().task.status, 'todo');
  await anna({ method: 'PATCH', url: `/admin/api/tasks/${t.id}`, payload: { columnId: ready.id } });
  assert.equal((await anna({ method: 'DELETE', url: `/admin/api/columns/${todo.id}` })).statusCode, 200);
  // доску-вкладку переставить первой
  await anna({ method: 'PATCH', url: `/admin/api/boards/${traffic.id}`, payload: { move: -1, name: 'Трафик и реклама' } });
  boards = (await anna({ url: `/admin/api/projects/${a.id}/boards` })).json().boards;
  assert.deepEqual(boards.map((b) => b.name), ['Трафик и реклама', 'Задачи']);

  // «Общие задачи» — тоже проект со своей доской
  const internal = (await anna({ url: '/admin/api/projects/none/boards' })).json();
  assert.equal(internal.project.name, 'Общие задачи');
  assert.deepEqual((await anna({ url: '/admin/api/tasks?client=none' })).json().tasks.map((x) => x.title), ['Обновить шаблоны КП']);
  assert.equal((await anna({ url: '/admin/api/tasks?client=abc' })).statusCode, 400);
  assert.equal((await anna({ url: '/admin/api/projects/abc/boards' })).statusCode, 400);

  // срок со временем: просрочено, как только время по Москве прошло
  const late = (await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Созвон-отчёт', clientId: a.id, due: '2020-01-01', dueTime: '13:00' } })).json().task;
  assert.equal(late.due_time, '13:00');
  assert.equal((await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'x', dueTime: '13:00' } })).statusCode, 400, 'время без даты');
  assert.equal((await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'x', due: '2030-01-01', dueTime: '25:00' } })).statusCode, 400);
  const later = (await anna({ method: 'PATCH', url: `/admin/api/tasks/${late.id}`, payload: { due: '2099-12-31' } })).json().task;
  assert.equal(later.due_time, '13:00', 'новая дата сохраняет время');
  assert.equal(later.comments.at(-1).text, 'Срок: 31 декабря, 13:00');
  const cleared = (await anna({ method: 'PATCH', url: `/admin/api/tasks/${late.id}`, payload: { due: null } })).json().task;
  assert.deepEqual([cleared.due, cleared.due_time], [null, null], 'снятый срок снимает и время');
  const msk = new Date(Date.now() + 3 * 3600e3);
  const today = msk.toISOString().slice(0, 10);
  const past = new Date(msk.getTime() - 3600e3).toISOString().slice(11, 16);
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Час назад', clientId: a.id, due: today, dueTime: past } });
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Сегодня без времени', clientId: a.id, due: today } });
  const alpha = (await anna({ url: '/admin/api/projects' })).json().projects.find((p) => p.name === 'Альфа');
  // «Аудит» (2020) + «Час назад»; задача на сегодня без времени ещё не просрочена
  if (msk.getUTCHours() >= 1) assert.equal(alpha.overdue, 2);

  // единственную доску проекта не удалить
  const [only] = (await anna({ url: '/admin/api/projects/none/boards' })).json().boards;
  assert.match((await anna({ method: 'DELETE', url: `/admin/api/boards/${only.id}` })).json().error, /единственная/);
});

test('обновление базы: старые статусы задач становятся колонками доски «Задачи»', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'crm-')), 'old.db');
  const fresh = openDb(path);
  // состояние до досок: колонок и досок ещё нет, у задач — статусы
  fresh.raw.exec(`ALTER TABLE admin_users DROP COLUMN prefs; DROP INDEX tasks_column; DROP TABLE tasks; DROP TABLE task_columns; DROP TABLE task_boards;
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 0, assignee_id INTEGER REFERENCES admin_users(id), due TEXT,
      created_by TEXT, created_by_id INTEGER REFERENCES admin_users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT);
    INSERT INTO clients (name) VALUES ('Альфа');
    INSERT INTO tasks (client_id, title, status, priority) VALUES (1, 'А', 'doing', 1), (1, 'Б', 'review', 0), (NULL, 'В', 'todo', 0), (1, 'Г', 'done', 0);
    PRAGMA user_version = 10;`);
  fresh.close();

  const db = openDb(path);
  const rows = db.raw
    .prepare(`SELECT t.title, t.status, t.priority, col.name AS col, b.name AS board, b.client_id FROM tasks t JOIN task_columns col ON col.id = t.column_id JOIN task_boards b ON b.id = col.board_id ORDER BY t.id`)
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { title: 'А', status: 'todo', priority: 3, col: 'В работе', board: 'Задачи', client_id: 1 },
    { title: 'Б', priority: 0, status: 'todo', col: 'На проверке', board: 'Задачи', client_id: 1 },
    { title: 'В', priority: 0, status: 'todo', col: 'К выполнению', board: 'Задачи', client_id: null },
    { title: 'Г', priority: 0, status: 'done', col: 'Готово', board: 'Задачи', client_id: 1 },
  ]);
  db.close();
});
