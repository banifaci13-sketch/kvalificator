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
  auth.addUser('anna', 'Анна', { password: PASSWORD, role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: PASSWORD, role: 'manager' });
  auth.addUser('ira', 'Ира', { password: PASSWORD, role: 'manager' });
  const crm = createCrm({ db: db.raw });
  const files = createFiles({ db: db.raw, dir: mkdtempSync(join(tmpdir(), 'news-')) });
  const app = await buildServer({
    config, qualifier: createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog }), logger: false,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), crm, files },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  };
  return { as, crm, db };
}

const png = () => {
  const b = Buffer.alloc(300);
  b.writeUInt32BE(0x89504e47, 0);
  return b;
};
const mp4 = (size = 4000) => {
  const b = Buffer.alloc(size, 7);
  b.write('ftypisom', 4, 'latin1');
  return b;
};

test('файлы: загрузка потоком, проверка формата, видео с перемоткой', async () => {
  const { as } = await setup();
  const oleg = await as('oleg');
  const up = (body, type, name = 'файл') => oleg({ method: 'POST', url: '/admin/api/files', headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) }, payload: body });

  const img = await up(png(), 'image/png', 'макет.png');
  assert.equal(img.statusCode, 200, img.body);
  assert.deepEqual([img.json().file.kind, img.json().file.name], ['image', 'макет.png']);
  assert.equal((await up(Buffer.from('<html><script>alert(1)</script>'), 'image/png')).statusCode, 415, 'HTML под видом картинки не пройдёт');
  assert.equal((await up(Buffer.from('<svg/>'), 'image/svg+xml')).statusCode, 415, 'SVG не принимаем');

  const vid = (await up(mp4(), 'video/mp4', 'ролик.mp4')).json().file;
  const full = await oleg({ url: `/admin/api/files/${vid.id}` });
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.rawPayload.length, 4000);
  const part = await oleg({ url: `/admin/api/files/${vid.id}`, headers: { range: 'bytes=100-199' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], 'bytes 100-199/4000');
  assert.equal(part.rawPayload.length, 100);
  assert.equal((await oleg({ url: `/admin/api/files/${vid.id}`, headers: { range: 'bytes=5000-' } })).statusCode, 416);

  const doc = (await up(Buffer.from('%PDF-1.4 test'), 'application/pdf', 'бриф.pdf')).json().file;
  assert.match((await oleg({ url: `/admin/api/files/${doc.id}` })).headers['content-disposition'], /^inline; filename\*=UTF-8''%D0%B1/);
  const txt = (await up(Buffer.from('заметка'), 'text/plain; charset=utf-8', 'заметка.txt')).json().file;
  assert.match((await oleg({ url: `/admin/api/files/${txt.id}` })).headers['content-disposition'], /^attachment/, 'документы скачиваются, а не открываются');
  assert.equal((await (await setup()).as('oleg').then((r) => r({ url: `/admin/api/files/${vid.id}` }))).statusCode, 404, 'другая база — другого файла нет');
});

test('новости: запись с фото, кейс, ссылка; реакции, комментарии, уведомления; права', async () => {
  const { as, crm } = await setup();
  const anna = await as('anna');
  const oleg = await as('oleg');
  const ira = await as('ira');
  const team = (await anna({ url: '/admin/api/team' })).json().team;
  const id = (name) => team.find((u) => u.name === name).id;
  const talle = crm.createClient({ name: 'Таллер' }, { name: 'Анна' });

  const photo = (await oleg({ method: 'POST', url: '/admin/api/files', headers: { 'content-type': 'image/png' }, payload: png() })).json().file;
  assert.equal((await oleg({ method: 'POST', url: '/admin/api/news', payload: { body: ' ' } })).statusCode, 400, 'пустую запись не публикуем');
  const post = (await oleg({ method: 'POST', url: '/admin/api/news', payload: { body: 'Запустили РСЯ для Таллера, @Ира посмотри креативы', fileIds: [photo.id] } })).json().post;
  assert.deepEqual(post.files.map((f) => f.id), [photo.id]);
  assert.match((await ira({ url: '/admin/api/notifications' })).json().items[0].text, /^Вас упомянули в новостях/);
  assert.equal((await ira({ method: 'POST', url: '/admin/api/news', payload: { body: 'чужое фото', fileIds: [photo.id] } })).statusCode, 400, 'чужие файлы не прикрепить');

  const kase = await oleg({ method: 'POST', url: '/admin/api/news', payload: { kind: 'case', title: 'Таллер: заявки ×2', clientId: talle.id, caseTask: 'Мало заявок с сайта', caseResult: 'Заявок в 2 раза больше за 3 месяца' } });
  assert.equal(kase.statusCode, 200, kase.body);
  assert.equal(kase.json().post.client_name, 'Таллер');
  assert.equal(kase.json().post.verified, false, 'кейс подтверждает администратор');
  assert.equal((await oleg({ method: 'PATCH', url: `/admin/api/news/${kase.json().post.id}`, payload: { verified: true } })).statusCode, 400);
  assert.equal((await anna({ method: 'PATCH', url: `/admin/api/news/${kase.json().post.id}`, payload: { verified: true } })).json().post.verified, true);
  assert.equal((await oleg({ method: 'POST', url: '/admin/api/news', payload: { kind: 'link', link: 'javascript:alert(1)' } })).statusCode, 400);
  const link = (await ira({ method: 'POST', url: '/admin/api/news', payload: { kind: 'link', link: 'vc.ru/marketing/123', body: 'Полезная статья' } })).json().post;
  assert.equal(link.link, 'https://vc.ru/marketing/123');

  // реакции: повторное нажатие снимает
  let r = (await ira({ method: 'POST', url: `/admin/api/news/${post.id}/react`, payload: { emoji: '🔥' } })).json().reactions;
  assert.deepEqual(r['🔥'], { count: 1, mine: true });
  r = (await anna({ method: 'POST', url: `/admin/api/news/${post.id}/react`, payload: { emoji: '🔥' } })).json().reactions;
  assert.deepEqual(r['🔥'], { count: 2, mine: true });
  r = (await anna({ method: 'POST', url: `/admin/api/news/${post.id}/react`, payload: { emoji: '🔥' } })).json().reactions;
  assert.deepEqual(r['🔥'], { count: 1, mine: false });
  assert.equal((await anna({ method: 'POST', url: `/admin/api/news/${post.id}/react`, payload: { emoji: '💩' } })).statusCode, 400);

  // комментарий: автору записи — уведомление
  const comments = (await anna({ method: 'POST', url: `/admin/api/news/${post.id}/comments`, payload: { text: 'Отлично!' } })).json().comments;
  assert.equal(comments.length, 1);
  assert.match((await oleg({ url: '/admin/api/notifications' })).json().items[0].text, /^Комментарий к вашей записи/);
  assert.equal((await ira({ method: 'DELETE', url: `/admin/api/news/comments/${comments[0].id}` })).statusCode, 400, 'чужой комментарий не удалить');

  // закрепить — только администратор; закреплённое приходит всем и стоит первым
  assert.equal((await oleg({ method: 'PATCH', url: `/admin/api/news/${link.id}`, payload: { pinned: true } })).statusCode, 400);
  await anna({ method: 'PATCH', url: `/admin/api/news/${post.id}`, payload: { pinned: true } });
  assert.match((await ira({ url: '/admin/api/notifications' })).json().items[0].text, /^Важное в новостях/);
  // счётчик новых в меню: Ира видела только свою запись — две новые от Олега
  assert.equal((await ira({ url: '/admin/api/news/unseen' })).json().unseen, 2);
  const feed = (await ira({ url: '/admin/api/news' })).json();
  assert.equal(feed.posts[0].id, post.id, 'закреплённая — первой');
  assert.equal(feed.posts[0].comments, 1);
  assert.equal((await ira({ url: '/admin/api/news/unseen' })).json().unseen, 0, 'открыл ленту — прочитано');
  assert.deepEqual((await ira({ url: '/admin/api/news?kind=case' })).json().posts.map((p) => p.kind), ['case']);

  // правка и удаление — автор или администратор
  assert.equal((await ira({ method: 'PATCH', url: `/admin/api/news/${post.id}`, payload: { body: 'взлом' } })).statusCode, 400);
  assert.ok((await oleg({ method: 'PATCH', url: `/admin/api/news/${post.id}`, payload: { body: 'Запустили РСЯ' } })).json().post.edited_at);
  assert.equal((await ira({ method: 'DELETE', url: `/admin/api/news/${post.id}` })).statusCode, 400);
  assert.equal((await anna({ method: 'DELETE', url: `/admin/api/news/${post.id}` })).statusCode, 200);
  assert.equal((await oleg({ url: `/admin/api/files/${photo.id}` })).statusCode, 404, 'файл удалённой записи стёрт');
  assert.equal(id('Ира') > 0, true);
});

test('вложения к задаче: прикрепить, видно на карточке, открепить — файл стирается, если больше нигде не нужен', async () => {
  const { as } = await setup();
  const oleg = await as('oleg');
  const ira = await as('ira');
  const up = async (who, body, type, name) => (await who({ method: 'POST', url: '/admin/api/files', headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) }, payload: body })).json().file;
  const task = (await oleg({ method: 'POST', url: '/admin/api/tasks', payload: { title: 'Креативы для РСЯ' } })).json().task;
  const brief = await up(oleg, Buffer.from('%PDF-1.4 бриф'), 'application/pdf', 'бриф.pdf');
  const pic = await up(oleg, png(), 'image/png', 'баннер.png');

  let files = (await oleg({ method: 'POST', url: `/admin/api/tasks/${task.id}/files`, payload: { fileIds: [brief.id, pic.id] } })).json().files;
  assert.deepEqual(files.map((f) => f.name), ['бриф.pdf', 'баннер.png']);
  const full = (await oleg({ url: `/admin/api/tasks/${task.id}` })).json().task;
  assert.equal(full.files.length, 2);
  assert.match(full.comments.at(-1).text, /^Файлы: бриф\.pdf, баннер\.png/);
  assert.equal((await oleg({ url: '/admin/api/tasks?mine=false' })).json().tasks.find((t) => t.id === task.id).files, 2);
  assert.equal((await ira({ method: 'POST', url: `/admin/api/tasks/${task.id}/files`, payload: { fileIds: [pic.id] } })).statusCode, 400, 'чужой файл не прикрепить');

  // тот же баннер в новостях — при откреплении от задачи он остаётся
  await oleg({ method: 'POST', url: '/admin/api/news', payload: { body: 'Новые баннеры', fileIds: [pic.id] } });
  files = (await oleg({ method: 'DELETE', url: `/admin/api/tasks/${task.id}/files/${pic.id}` })).json().files;
  assert.deepEqual(files.map((f) => f.name), ['бриф.pdf']);
  assert.equal((await oleg({ url: `/admin/api/files/${pic.id}` })).statusCode, 200, 'нужен в новостях');
  await oleg({ method: 'DELETE', url: `/admin/api/tasks/${task.id}/files/${brief.id}` });
  assert.equal((await oleg({ url: `/admin/api/files/${brief.id}` })).statusCode, 404, 'больше нигде не нужен — стёрт');
});
