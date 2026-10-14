import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { openDb } from '../src/storage/db.js';
import { createFiles } from '../src/files/store.js';
import { createBackup, checkBackup, listBackups, readStatus } from '../src/ops/backup.js';
import { createMonitor } from '../src/ops/monitor.js';
import { createQualifier } from '../src/core/qualifier.js';
import { buildServer } from '../src/http/server.js';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/admin/auth.js';
import { createReports } from '../src/admin/reports.js';
import { rules, staticSource, silentLog } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea73581e40000000049454e44ae426082', 'hex');

/** Рабочая папка с базой, двумя вложениями и выгрузкой документа. */
async function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'kval-ops-'));
  const dbPath = join(dir, 'kvalificator.db');
  const db = openDb(dbPath);
  const files = createFiles({ db: db.raw, dir });
  const user = { id: null, name: 'Анна' };
  const a = await files.save(Readable.from([PNG]), { mime: 'image/png', name: 'a.png', user });
  const b = await files.save(Readable.from([Buffer.from('%PDF-1.4 test')]), { mime: 'application/pdf', name: 'b.pdf', user });
  // выгрузка документа: запись в базе с абсолютным путём, как на сервере
  mkdirSync(join(dir, 'documents', '1'), { recursive: true });
  const exportFile = join(dir, 'documents', '1', '20261014T0800.pptx');
  writeFileSync(exportFile, 'pptx-bytes');
  db.raw.prepare("INSERT INTO documents (id, title, template, spec) VALUES (1, 'КП', 'kp', '{\"slides\":[]}')").run();
  db.raw.prepare("INSERT INTO document_exports (document_id, format, file, bytes, sha256, manifest) VALUES (1, 'pptx', ?, 10, ?, '{}')")
    .run(exportFile, createHash('sha256').update('pptx-bytes').digest('hex'));
  db.close();
  return { dir, dbPath, a, b };
}

test('бэкап: база и файлы, проверка восстановления, новые файлы докопируются', async () => {
  const { dir, dbPath, a } = await workspace();
  const r = await createBackup({ dbPath, now: new Date('2026-10-14T08:00:00Z') });
  assert.equal(r.db.integrity, 'ok');
  assert.equal(r.files.total, 3);
  assert.equal(r.files.copied, 3);
  assert.ok(existsSync(join(dir, 'backups', 'data', 'files', `${a.sha256}.png`)), 'вложение в зеркале');
  assert.ok(existsSync(join(dir, 'backups', 'data', 'documents', '1', '20261014T0800.pptx')), 'выгрузка в зеркале');
  const manifest = JSON.parse(readFileSync(join(dir, 'backups', 'kvalificator-2026-10-14-08-00.json'), 'utf8'));
  assert.match(manifest.db.sha256, /^[0-9a-f]{64}$/);

  const c = await checkBackup({ dbPath });
  assert.equal(c.counts.referencedFiles, 3);
  assert.equal(c.ok, true, c.errors.join('; '));

  // второй бэкап: копируется только новое
  const r2 = await createBackup({ dbPath, now: new Date('2026-10-15T08:00:00Z') });
  assert.equal(r2.files.copied, 0);
  assert.equal(listBackups(dbPath).length, 2);
  assert.equal(readStatus(dbPath).backup.createdAt, '2026-10-15T08:00:00.000Z');
});

test('проверка восстановления ловит пропавший файл и повреждённую копию базы', async () => {
  const { dir, dbPath, a } = await workspace();
  await createBackup({ dbPath, now: new Date('2026-10-14T08:00:00Z') });
  let c = await checkBackup({ dbPath });
  assert.equal(c.ok, true, c.errors.join('; '));
  assert.equal(readStatus(dbPath).check.ok, true);

  unlinkSync(join(dir, 'backups', 'data', 'files', `${a.sha256}.png`));
  c = await checkBackup({ dbPath });
  assert.equal(c.ok, false);
  assert.match(c.errors.join(' '), /нет 1 файла/);

  const copy = listBackups(dbPath).at(-1).file;
  const buf = readFileSync(copy);
  buf[buf.length - 100] ^= 0xff;
  writeFileSync(copy, buf);
  c = await checkBackup({ dbPath });
  assert.match(c.errors.join(' '), /Контрольная сумма копии базы не совпадает/);
  assert.equal(readStatus(dbPath).check.ok, false);
});

test('бэкап: старые копии базы удаляются вместе с манифестами, зеркало файлов остаётся', async () => {
  const { dir, dbPath } = await workspace();
  for (let d = 1; d <= 4; d++) await createBackup({ dbPath, keep: 2, now: new Date(`2026-10-0${d}T08:00:00Z`) });
  const names = readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('kvalificator-')).sort();
  assert.deepEqual(names, ['kvalificator-2026-10-03-08-00.db', 'kvalificator-2026-10-03-08-00.json', 'kvalificator-2026-10-04-08-00.db', 'kvalificator-2026-10-04-08-00.json']);
  assert.equal(readdirSync(join(dir, 'backups', 'data', 'files')).length, 2);
});

test('без копий проверка честно говорит, что восстанавливаться не из чего', async () => {
  const { dbPath } = await workspace();
  const c = await checkBackup({ dbPath });
  assert.equal(c.ok, false);
  assert.deepEqual(c.errors, ['Резервных копий нет']);
});

test('монитор: фоновая задача, сбой, «давно не запускалась», ошибки из журнала', async () => {
  let t = Date.parse('2026-10-14T08:00:00Z');
  const m = createMonitor({ now: () => new Date(t) });
  const job = m.job('leads', 'Досылка заявок', 5 * 60e3);
  assert.equal(await job(() => 7), 7);
  await job(() => {
    throw new Error('Telegram недоступен');
  });
  let s = m.snapshot();
  assert.deepEqual([s.jobs[0].runs, s.jobs[0].fails, s.jobs[0].lastError, s.jobs[0].stale], [2, 1, 'Telegram недоступен', false]);
  assert.equal(s.errors[0].where, 'Фоновая задача «Досылка заявок»');
  t += 16 * 60e3;
  assert.equal(m.snapshot().jobs[0].stale, true, 'три интервала без запуска');

  // хук журнала: ошибки попадают в список, обычные записи — нет
  const calls = [];
  const method = (...args) => calls.push(args);
  m.logHook.call(null, [{ err: new Error('SQLITE_BUSY') }, 'Ошибка обработки запроса'], method, 50);
  m.logHook.call(null, ['всё хорошо'], method, 30);
  s = m.snapshot();
  assert.equal(calls.length, 2, 'журнал пишется как раньше');
  assert.deepEqual([s.errors[0].where, s.errors[0].message, s.errors.length], ['Ошибка обработки запроса', 'SQLITE_BUSY', 2]);
});

test('«Состояние системы»: только администратору, без секретов', async () => {
  const { dbPath } = await workspace();
  await createBackup({ dbPath });
  await checkBackup({ dbPath });
  const config = loadConfig({ DB_PATH: dbPath, TELEGRAM_BOT_TOKEN: '123456:SECRET-TOKEN-VALUE', TELEGRAM_MANAGER_CHAT_ID: '-100500' });
  const db = openDb(dbPath);
  const auth = createAuth(db.raw);
  auth.addUser('anna', 'Анна', { password: 'correct-horse-battery', role: 'admin' });
  auth.addUser('oleg', 'Олег', { password: 'correct-horse-battery', role: 'manager' });
  const monitor = createMonitor();
  await monitor.job('money', 'Счета и напоминания об оплате', 3600e3)(() => 0);
  const app = await buildServer({
    config, qualifier: createQualifier({ db, scenarioSource: staticSource(), rules, log: silentLog }), logger: false,
    admin: { auth, reports: createReports(db.raw), db, scenarioSource: staticSource(), monitor },
  });
  const as = async (login) => {
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { login, password: 'correct-horse-battery' } });
    const c = res.cookies.find((x) => x.name === 'kval_admin');
    return (url) => app.inject({ url, headers: { cookie: `kval_admin=${c.value}` } });
  };
  assert.equal((await app.inject({ url: '/admin/api/system' })).statusCode, 401);
  assert.equal((await (await as('oleg'))('/admin/api/system')).statusCode, 403);
  const res = await (await as('anna'))('/admin/api/system');
  assert.equal(res.statusCode, 200);
  const s = res.json();
  assert.equal(s.backup.copies, 1);
  assert.equal(s.backup.fresh, true);
  assert.equal(s.backup.check.ok, true, JSON.stringify(s.backup.check.errors));
  assert.equal(s.storage.files.count, 2);
  assert.equal(s.leads.recipients, true);
  assert.deepEqual(s.jobs.map((j) => [j.name, j.runs]), [['money', 1]]);
  assert.doesNotMatch(res.body, /SECRET-TOKEN|-100500|correct-horse/, 'ключей и паролей в ответе нет');
  await app.close();
  db.close();
});
