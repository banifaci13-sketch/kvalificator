import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('задачи: доска, исполнитель, статус, лента изменений, комментарии', async () => {
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

  const task = (await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Собрать семантику', clientId: client.id, assigneeId: id('Олег'), due: '2026-10-20', priority: 1 } })).json().task;
  assert.equal(task.status, 'todo');
  assert.equal(task.client_name, 'ООО Ромашка');
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Внутренняя задача' } });

  const mine = (await oleg({ url: '/admin/api/tasks?mine=true' })).json().tasks;
  assert.deepEqual(mine.map((t) => t.title), ['Собрать семантику']);
  assert.equal((await oleg({ url: `/admin/api/tasks?client=${client.id}` })).json().tasks.length, 1);

  const moved = await oleg({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { status: 'doing' } });
  assert.equal(moved.statusCode, 200);
  await oleg({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { assigneeId: id('Ира'), status: 'review' } });
  await ira({ method: 'POST', url: `/admin/api/tasks/${task.id}/comments`, payload: { text: 'Проверю до вечера' } });
  const done = (await ira({ method: 'PATCH', url: `/admin/api/tasks/${task.id}`, payload: { status: 'done' } })).json().task;
  assert.ok(done.done_at);
  const feed = done.comments.map((c) => `${c.author}: ${c.text}`);
  assert.deepEqual(feed, [
    'Олег: К выполнению → В работе',
    'Олег: В работе → На проверке',
    'Олег: Исполнитель: Ира',
    'Ира: Проверю до вечера',
    'Ира: На проверке → Готово',
  ]);
  const card = (await anna({ url: `/admin/api/clients/${client.id}` })).json();
  assert.equal(card.client.open_tasks ?? 0, 0);
  assert.equal(card.tasks[0].comments, 1);

  // удалить — автор или администратор
  assert.equal((await oleg({ method: 'DELETE', url: `/admin/api/tasks/${task.id}` })).statusCode, 400);
  assert.equal((await anna({ method: 'DELETE', url: `/admin/api/tasks/${task.id}` })).statusCode, 200);
  // клиента удаляет администратор, остальные — в архив
  assert.equal((await oleg({ method: 'DELETE', url: `/admin/api/clients/${client.id}` })).statusCode, 403);
  const archived = (await oleg({ method: 'PUT', url: `/admin/api/clients/${client.id}`, payload: { archived: true } })).json().client;
  assert.equal(archived.archived, 1);
  assert.equal((await oleg({ url: '/admin/api/clients' })).json().clients.length, 0);
});

test('доски: по клиенту и «Внутренние», счётчики по статусам, просрочка, мои', async () => {
  const { as } = await setup();
  const anna = await as('anna');
  const team = (await anna({ url: '/admin/api/team' })).json().team;
  const annaId = team.find((u) => u.name === 'Анна').id;
  const a = (await anna({ method: 'POST', url: '/admin/api/clients', payload: { name: 'Альфа' } })).json().client;
  await anna({ method: 'POST', url: '/admin/api/clients', payload: { name: 'Бета' } });
  const t1 = (await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Аудит', clientId: a.id, assigneeId: annaId, due: '2020-01-01' } })).json().task;
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Запуск', clientId: a.id, status: 'doing' } });
  await anna({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Обновить шаблоны КП' } });
  await anna({ method: 'PATCH', url: `/admin/api/tasks/${t1.id}`, payload: { status: 'review' } });

  const boards = (await anna({ url: '/admin/api/boards' })).json().boards;
  assert.deepEqual(boards.map((b) => b.name), ['Альфа', 'Бета', 'Внутренние задачи']);
  const alpha = boards[0];
  assert.deepEqual(alpha.counts, { todo: 0, doing: 1, review: 1, done: 0 });
  assert.equal(alpha.overdue, 1);
  assert.equal(alpha.mine, 1);
  assert.equal(boards[2].counts.todo, 1);

  const internal = (await anna({ url: '/admin/api/tasks?client=none' })).json().tasks;
  assert.deepEqual(internal.map((t) => t.title), ['Обновить шаблоны КП']);
  assert.equal((await anna({ url: '/admin/api/tasks?client=abc' })).statusCode, 400);
});
