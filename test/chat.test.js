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
import { createFiles } from '../src/files/store.js';
import { rules, staticSource, silentLog } from './helpers.js';

const PASSWORD = 'correct-horse-battery';

async function setup() {
  const config = loadConfig({ DB_PATH: ':memory:' });
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  for (const [l, n, r] of [['anna', 'Анна', 'admin'], ['oleg', 'Олег', 'manager'], ['ira', 'Ира', 'manager']]) auth.addUser(l, n, { password: PASSWORD, role: r });
  const crm = createCrm({ db: db.raw });
  const files = createFiles({ db: db.raw, dir: mkdtempSync(join(tmpdir(), 'chat-')) });
  const app = await buildServer({
    config, qualifier: createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog }), logger: false,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), crm, files },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  };
  const team = auth.listUsers();
  const id = (name) => team.find((u) => u.name === name).id;
  return { as, id, crm };
}

test('мессенджер: личный чат один на пару, сообщения, непрочитанное, прочитано', async () => {
  const { as, id } = await setup();
  const anna = await as('anna');
  const oleg = await as('oleg');
  const ira = await as('ira');
  const start = (await oleg({ url: '/admin/api/chats/incoming' })).json();
  assert.equal(start.unread, 0);

  const c = (await anna({ method: 'POST', url: '/admin/api/chats', payload: { userId: id('Олег') } })).json().chat;
  assert.equal(c.title, 'Олег', 'в личном чате — имя собеседника');
  assert.equal((await anna({ method: 'POST', url: '/admin/api/chats', payload: { userId: id('Олег') } })).json().chat.id, c.id, 'второй раз — тот же чат');
  assert.equal((await oleg({ method: 'POST', url: '/admin/api/chats', payload: { userId: id('Анна') } })).json().chat.id, c.id);

  await anna({ method: 'POST', url: `/admin/api/chats/${c.id}/messages`, payload: { text: 'Привет! Макеты готовы?' } });
  const m2 = (await anna({ method: 'POST', url: `/admin/api/chats/${c.id}/messages`, payload: { text: 'Клиент ждёт к 15:00' } })).json().message;
  assert.equal((await anna({ method: 'POST', url: `/admin/api/chats/${c.id}/messages`, payload: { text: '  ' } })).statusCode, 400);
  assert.equal((await ira({ url: `/admin/api/chats/${c.id}/messages` })).statusCode, 400, 'чужой чат не прочитать');

  let inc = (await oleg({ url: `/admin/api/chats/incoming?after=${start.last}` })).json();
  assert.equal(inc.unread, 2);
  assert.deepEqual(inc.messages.map((x) => [x.author, x.body, x.chat_title]), [['Анна', 'Привет! Макеты готовы?', 'Анна'], ['Анна', 'Клиент ждёт к 15:00', 'Анна']]);
  const list = (await oleg({ url: '/admin/api/chats' })).json().chats;
  assert.deepEqual([list[0].title, list[0].unread, list[0].last.text], ['Анна', 2, 'Клиент ждёт к 15:00']);

  assert.equal((await oleg({ method: 'POST', url: `/admin/api/chats/${c.id}/read`, payload: { lastId: m2.id } })).json().unread, 0);
  inc = (await oleg({ url: `/admin/api/chats/incoming?after=${inc.last}` })).json();
  assert.deepEqual([inc.unread, inc.messages.length], [0, 0]);

  // правка и удаление — только своё
  assert.equal((await oleg({ method: 'PATCH', url: `/admin/api/chat-messages/${m2.id}`, payload: { text: 'взлом' } })).statusCode, 400);
  assert.equal((await anna({ method: 'PATCH', url: `/admin/api/chat-messages/${m2.id}`, payload: { text: 'Клиент ждёт к 16:00' } })).json().message.body, 'Клиент ждёт к 16:00');
  assert.equal((await anna({ method: 'DELETE', url: `/admin/api/chat-messages/${m2.id}` })).json().message.deleted, true);
  const msgs = (await oleg({ url: `/admin/api/chats/${c.id}/messages` })).json().messages;
  assert.equal(msgs.at(-1).deleted, true);
});

test('мессенджер: группа по проекту, файлы, упоминания, участники', async () => {
  const { as, id, crm } = await setup();
  const anna = await as('anna');
  const oleg = await as('oleg');
  const ira = await as('ira');
  const client = crm.createClient({ name: 'Таллер' }, { name: 'Анна' });
  const g = (await anna({ method: 'POST', url: '/admin/api/chats', payload: { clientId: client.id, memberIds: [id('Олег')] } })).json().chat;
  assert.equal(g.title, 'Проект «Таллер»');
  assert.deepEqual(g.members.map((m) => m.name).sort(), ['Анна', 'Олег']);
  assert.equal((await anna({ method: 'POST', url: '/admin/api/chats', payload: { title: 'Пусто', memberIds: [] } })).statusCode, 400);

  const png = Buffer.alloc(200);
  png.writeUInt32BE(0x89504e47, 0);
  const file = (await oleg({ method: 'POST', url: '/admin/api/files', headers: { 'content-type': 'image/png' }, payload: png })).json().file;
  const msg = (await oleg({ method: 'POST', url: `/admin/api/chats/${g.id}/messages`, payload: { text: '@Анна вот макет', fileIds: [file.id] } })).json().message;
  assert.equal(msg.files.length, 1);
  assert.match((await anna({ url: '/admin/api/notifications' })).json().items[0].text, /^Вас упомянули в чате «Проект «Таллер»»/);

  const upd = (await anna({ method: 'PATCH', url: `/admin/api/chats/${g.id}`, payload: { addIds: [id('Ира')], title: 'Таллер: РК' } })).json().chat;
  assert.equal(upd.title, 'Таллер: РК');
  assert.equal(upd.members.length, 3);
  // новый участник видит переписку, но старое не считается непрочитанным
  assert.equal((await ira({ url: '/admin/api/chats/incoming' })).json().unread, 0);
  assert.ok((await ira({ url: `/admin/api/chats/${g.id}/messages` })).json().messages.some((m) => m.body === '@Анна вот макет'));
  // выйти из чата
  assert.equal((await ira({ method: 'PATCH', url: `/admin/api/chats/${g.id}`, payload: { removeIds: [id('Ира')] } })).json().chat, null);
  assert.equal((await ira({ url: '/admin/api/chats' })).json().chats.length, 0);
  // удалили сообщение — файл стёрт
  await oleg({ method: 'DELETE', url: `/admin/api/chat-messages/${msg.id}` });
  assert.equal((await oleg({ url: `/admin/api/files/${file.id}` })).statusCode, 404);
});
