import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { openDb } from '../src/storage/db.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { loadBrand } from '../src/brand/index.js';
import { createDocLibrary } from '../src/docs/library.js';
import { createMedia, imageInfo } from '../src/docs/media.js';
import { closeBrowser } from '../src/docs/browser.js';
import { rules, staticSource, silentLog } from './helpers.js';

const PASSWORD = 'correct-horse-battery';
const brand = loadBrand();

/** Однотонный PNG нужного размера — без сторонних библиотек. */
function makePng(w, h, [r, g, b] = [14, 154, 166]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function setup() {
  const config = loadConfig({ DB_PATH: ':memory:' });
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  auth.addUser('anna', 'Анна', { password: PASSWORD, role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: PASSWORD });
  const dir = mkdtempSync(join(tmpdir(), 'media-'));
  const media = createMedia({ db: db.raw, dir });
  const library = createDocLibrary({ db: db.raw, brand, templatesDir: resolve(config.root, 'templates/decks'), dataDir: dir, media });
  const qualifier = createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog });
  const app = await buildServer({
    config, qualifier, logger: false, brand,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), library, brand, media },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: PASSWORD } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (opts) => app.inject({ ...opts, headers: { ...opts.headers, cookie: `kval_admin=${c.value}` } });
  };
  return { as, library };
}

const upload = (req, buf, mime = 'image/png', name = 'Баннер VK.png') =>
  req({ method: 'POST', url: '/admin/api/media', headers: { 'content-type': mime, 'x-file-name': encodeURIComponent(name) }, payload: buf });

test('размер картинки по заголовку: PNG и JPEG', () => {
  assert.deepEqual(imageInfo(makePng(30, 20)), { mime: 'image/png', width: 30, height: 20 });
  // минимальный JPEG: SOI, APP0, SOF0 с размером 640×480
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageInfo(jpeg), { mime: 'image/jpeg', width: 640, height: 480 });
  assert.equal(imageInfo(Buffer.from('not an image')), null);
});

test('медиатека: загрузка, без дублей, только картинки, удаляет автор или администратор', async () => {
  const { as } = await setup();
  const oleg = await as('oleg');
  const anna = await as('anna');
  const png = makePng(1600, 900);
  const res = await upload(oleg, png);
  assert.equal(res.statusCode, 200, res.body);
  const m = res.json().media;
  assert.deepEqual([m.width, m.height, m.mime, m.name], [1600, 900, 'image/png', 'Баннер VK.png']);
  assert.equal((await upload(oleg, png)).json().media.id, m.id, 'тот же файл не дублируется');
  assert.equal((await upload(oleg, Buffer.from('<svg/>'), 'image/png')).statusCode, 400);
  assert.equal((await oleg({ method: 'POST', url: '/admin/api/media', headers: { 'content-type': 'image/svg+xml' }, payload: '<svg/>' })).statusCode, 415);

  const file = await anna({ url: `/admin/api/media/${m.id}` });
  assert.equal(file.headers['content-type'], 'image/png');
  assert.equal(file.rawPayload.length, png.length);
  assert.equal((await anna({ url: '/admin/api/media' })).json().media.length, 1);

  const other = (await upload(anna, makePng(800, 800))).json().media;
  assert.equal((await oleg({ method: 'DELETE', url: `/admin/api/media/${other.id}` })).statusCode, 400);
  assert.equal((await anna({ method: 'DELETE', url: `/admin/api/media/${other.id}` })).statusCode, 200);
});

test('слайды с фото и креативами: превью, проверка, PowerPoint; удалённое фото — ошибка', async () => {
  const { as, library } = await setup();
  const anna = await as('anna');
  const photo = (await upload(anna, makePng(1600, 1200))).json().media;
  const banner = (await upload(anna, makePng(1080, 1080, [235, 104, 52]), 'image/png', 'Креатив 1x1.png')).json().media;
  const doc = library.createDocument({
    spec: {
      meta: {},
      slides: [
        { type: 'image', layout: 'left', title: 'Как выглядит реклама', text: 'Фото с площадки', image: photo.id, fit: 'cover', caption: 'SberAds, лента' },
        { type: 'gallery', layout: 'grid', title: 'Креативы для теста', items: [{ image: banner.id, caption: 'Квадрат' }, { image: photo.id, caption: '4:3' }], fit: 'contain' },
        { type: 'cover', layout: 'image', title: 'Стратегия', image: photo.id },
      ],
    },
  }, 'Анна');

  const preview = await anna({ url: `/admin/api/documents/${doc.id}/preview?slide=0` });
  assert.match(preview.body, new RegExp(`src="/admin/api/media/${photo.id}"`), 'в превью — ссылка, а не данные');
  assert.match(preview.headers['content-security-policy'], /img-src data: 'self'/);

  const qa = (await anna({ method: 'POST', url: `/admin/api/documents/${doc.id}/qa` })).json().qa;
  assert.deepEqual(qa.errors, [], JSON.stringify(qa.errors));

  const exp = await anna({ method: 'POST', url: `/admin/api/documents/${doc.id}/export`, payload: { format: 'pptx' } });
  assert.equal(exp.statusCode, 200, exp.body);
  const file = await anna({ url: `/admin/api/exports/${exp.json().exportId}` });
  const zip = await JSZip.loadAsync(file.rawPayload);
  assert.ok(Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/')).length >= 2, 'картинки внутри PowerPoint');

  await anna({ method: 'DELETE', url: `/admin/api/media/${banner.id}` });
  const after = (await anna({ method: 'POST', url: `/admin/api/documents/${doc.id}/qa` })).json().qa;
  assert.ok(after.errors.some((e) => /креатив 1: изображение удалено/.test(e)), JSON.stringify(after.errors));
  await closeBrowser();
});
