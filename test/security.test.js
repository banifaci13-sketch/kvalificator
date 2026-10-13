// Безопасность кабинета: без входа не отдаётся ничего, кроме страницы входа; личные переписки и их
// файлы видят только участники (администратор — тоже нет); перебор пароля не обходится поддельной cookie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea73581e40000000049454e44ae426082', 'hex');

async function setup() {
  const config = loadConfig({ DB_PATH: ':memory:' });
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  for (const [l, n, r] of [['anna', 'Анна', 'admin'], ['oleg', 'Олег', 'manager'], ['ira', 'Ира', 'manager']]) auth.addUser(l, n, { password: PASSWORD, role: r });
  const crm = createCrm({ db: db.raw });
  const files = createFiles({ db: db.raw, dir: mkdtempSync(join(tmpdir(), 'sec-')) });
  const app = await buildServer({
    config, qualifier: createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog }), logger: false,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), crm, files },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  };
  const id = (name) => auth.listUsers().find((u) => u.name === name).id;
  return { app, as, id, crm };
}

// все адреса API кабинета — прямо из исходников, чтобы новый раздел не проскочил без проверки
function apiRoutes() {
  const dir = new URL('../src/admin/', import.meta.url);
  const out = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/\.(get|post|put|patch|delete)\(\s*'(\/admin\/api\/[^']+)'/g)) {
      out.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  return [...out];
}
const PUBLIC = new Set(['GET /admin/api/auth', 'POST /admin/api/login', 'POST /admin/api/logout']);

test('без входа API кабинета не отдаёт ничего — ни данных, ни файлов', async () => {
  const { app, as } = await setup();
  const anna = await as('anna');
  const routes = apiRoutes();
  let checked = 0;
  for (const r of routes.filter((x) => !PUBLIC.has(x))) {
    const [method, path] = r.split(' ');
    const url = path.replace(/:[a-zA-Z]+/g, '1');
    const payload = method === 'GET' || method === 'DELETE' ? undefined : {};
    for (const cookie of [undefined, 'kval_admin=поддельная-сессия']) {
      const res = await app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });
      // модуль не подключён в этом тесте (ИИ, видео, медиапланы) — маршрута нет вовсе, проверять нечего
      if (res.statusCode === 404 && (await anna({ method, url, payload })).json().message?.startsWith('Route ')) continue;
      assert.equal(res.statusCode, 401, `${r} ${cookie ? 'с поддельной cookie' : 'без входа'} → ${res.statusCode}`);
      checked++;
    }
  }
  assert.ok(checked > 150, `проверено адресов: ${checked / 2}`);
  // загрузка файла без входа даже не принимается
  const up = await app.inject({ method: 'POST', url: '/admin/api/files', headers: { 'content-type': 'image/png' }, payload: PNG });
  assert.equal(up.statusCode, 401);
  // страница кабинета открывается (это только оболочка с формой входа), данных в ней нет
  assert.equal((await app.inject({ url: '/admin/' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/calendar/не-тот-токен.ics' })).statusCode, 404);
});

test('сессия: cookie только для сервера, SameSite=Strict, неверный пароль не пускает', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'anna', password: PASSWORD } });
  const c = res.cookies.find((x) => x.name === 'kval_admin');
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'Strict');
  assert.equal(c.path, '/admin');
  assert.equal((await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login: 'anna', password: 'не тот пароль' } })).statusCode, 401);
  const page = await app.inject({ url: '/admin/' });
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
});

test('перебор пароля: лимит по адресу, поддельные cookie его не обходят', async () => {
  const { app } = await setup();
  const codes = [];
  for (let i = 0; i < 12; i++) {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', headers: { cookie: `kval_admin=fake${i}` }, payload: { login: 'anna', password: `guess-${i}-xxxx` } });
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(codes.slice(10), [429, 429], 'после 10 попыток за 15 минут — стоп');
});

test('личная переписка: читают только участники, администратор — тоже нет; файлы из чата не открыть по номеру', async () => {
  const { as, id, crm } = await setup();
  const anna = await as('anna'); // администратор
  const oleg = await as('oleg');
  const ira = await as('ira');

  const c = (await oleg({ method: 'POST', url: '/admin/api/chats', payload: { userId: id('Ира') } })).json().chat;
  const file = (await oleg({ method: 'POST', url: '/admin/api/files', headers: { 'content-type': 'image/png', 'x-file-name': 'secret.png' }, payload: PNG })).json().file;
  const msg = (await oleg({ method: 'POST', url: `/admin/api/chats/${c.id}/messages`, payload: { text: 'Личное', fileIds: [file.id] } })).json().message;

  // собеседник видит и сообщение, и файл
  assert.equal((await ira({ url: `/admin/api/chats/${c.id}/messages` })).json().messages.at(-1).body, 'Личное');
  assert.equal((await ira({ url: `/admin/api/files/${file.id}` })).statusCode, 200);

  // администратор — не участник: ни списка, ни сообщений, ни файла, ни правки
  assert.deepEqual((await anna({ url: '/admin/api/chats' })).json().chats, []);
  assert.equal((await anna({ url: `/admin/api/chats/${c.id}/messages` })).statusCode, 400);
  assert.equal((await anna({ method: 'POST', url: `/admin/api/chats/${c.id}/messages`, payload: { text: 'я тут' } })).statusCode, 400);
  assert.equal((await anna({ method: 'PATCH', url: `/admin/api/chats/${c.id}`, payload: { addIds: [id('Анна')] } })).statusCode, 400, 'не добавить себя в чужой чат');
  assert.equal((await anna({ method: 'DELETE', url: `/admin/api/chat-messages/${msg.id}` })).statusCode, 400);
  assert.equal((await anna({ url: `/admin/api/chats/incoming` })).json().unread, 0);
  assert.equal((await anna({ url: `/admin/api/files/${file.id}` })).statusCode, 404, 'файл из чужого чата не открыть');

  // и не вытащить файл, прикрепив его к задаче, клиенту или новости
  const client = crm.createClient({ name: 'Таллер' }, { name: 'Анна' });
  const task = crm.createTask({ title: 'Отчёт', clientId: client.id }, { name: 'Анна', id: id('Анна') });
  assert.equal((await anna({ method: 'POST', url: `/admin/api/tasks/${task.id}/files`, payload: { fileIds: [file.id] } })).statusCode, 400);
  assert.equal((await anna({ method: 'POST', url: `/admin/api/clients/${client.id}/files`, payload: { fileIds: [file.id] } })).statusCode, 400);
  assert.equal((await anna({ method: 'POST', url: '/admin/api/news', payload: { body: 'смотрите', fileIds: [file.id] } })).statusCode, 400);
  // чужой ещё не отправленный файл тоже не открыть
  const draft = (await ira({ method: 'POST', url: '/admin/api/files', headers: { 'content-type': 'image/png' }, payload: PNG })).json().file;
  assert.equal((await oleg({ url: `/admin/api/files/${draft.id}` })).statusCode, 404);
  assert.equal((await ira({ url: `/admin/api/files/${draft.id}` })).statusCode, 200);
});
