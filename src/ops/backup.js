// Резервные копии: база + файлы, и проверка, что из копии можно восстановиться.
//
// data/backups/
//   kvalificator-ГГГГ-ММ-ДД-ЧЧ-ММ.db    — копия базы (VACUUM INTO, без остановки сервера)
//   kvalificator-ГГГГ-ММ-ДД-ЧЧ-ММ.json  — манифест: контрольная сумма, версия схемы, сколько файлов
//   data/files, data/media, data/documents — зеркало файлов. Файлы не меняются после записи
//                                           (имя — sha256 или метка времени), поэтому копируются только новые.
//                                           Удалённое из кабинета в зеркале остаётся: старая копия базы
//                                           на него ссылается.
//   status.json                          — итог последнего бэкапа и последней проверки (для «Состояния»)

import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../storage/db.js';
import { FILE_TYPES } from '../files/store.js';

const MEDIA_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const FILE_DIRS = ['files', 'media', 'documents'];
const DB_RE = /^kvalificator-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})\.db$/;
// полная контрольная сумма — для последних файлов; у остальных сверяем размер (видео бывают по 100 МБ)
const HASH_RECENT = 25;

export const backupDir = (dbPath) => join(dirname(dbPath), 'backups');

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function* walk(root) {
  if (!existsSync(root)) return;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'tmp') yield* walk(p);
    } else if (e.isFile()) yield p;
  }
}

/** Размер и число файлов в папке (для «Состояния»). */
export function dirUsage(root) {
  let bytes = 0;
  let count = 0;
  for (const p of walk(root)) {
    bytes += statSync(p).size;
    count += 1;
  }
  return { bytes, count };
}

function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function readStatus(dbPath) {
  try {
    return JSON.parse(readFileSync(join(backupDir(dbPath), 'status.json'), 'utf8'));
  } catch {
    return {};
  }
}

function saveStatus(dbPath, patch) {
  const dir = backupDir(dbPath);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'status.json'), { ...readStatus(dbPath), ...patch });
}

/** Копии базы, новые — последними. */
export function listBackups(dbPath) {
  const dir = backupDir(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => DB_RE.test(f))
    .sort()
    .map((f) => ({ file: join(dir, f), name: f, stamp: DB_RE.exec(f)[1], bytes: statSync(join(dir, f)).size }));
}

/** Зеркало файлов: копируем то, чего ещё нет (или размер другой), через временное имя. */
function mirrorFiles(dataDir, dir) {
  let copied = 0;
  let copiedBytes = 0;
  let total = 0;
  let totalBytes = 0;
  for (const sub of FILE_DIRS) {
    for (const src of walk(join(dataDir, sub))) {
      const rel = relative(dataDir, src);
      const dst = join(dir, 'data', rel);
      const size = statSync(src).size;
      total += 1;
      totalBytes += size;
      if (existsSync(dst) && statSync(dst).size === size) continue;
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, `${dst}.part`);
      renameSync(`${dst}.part`, dst);
      copied += 1;
      copiedBytes += size;
    }
  }
  return { total, totalBytes, copied, copiedBytes };
}

/**
 * Сделать копию: база (VACUUM INTO) + новые файлы в зеркало + манифест. Старые копии базы сверх keep удаляются.
 * now — для имени копии (в тестах).
 */
export async function createBackup({ dbPath, keep = 14, now = new Date() }) {
  const started = Date.now();
  const dir = backupDir(dbPath);
  const dataDir = dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const name = `kvalificator-${stamp}`;
  const target = join(dir, `${name}.db`);
  if (existsSync(target)) unlinkSync(target);
  const db = openDb(dbPath);
  try {
    db.raw.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(target, { readOnly: true });
  const integrity = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  const userVersion = copy.prepare('PRAGMA user_version').get().user_version;
  copy.close();
  const files = mirrorFiles(dataDir, dir);
  const manifest = {
    createdAt: now.toISOString(),
    db: { file: `${name}.db`, bytes: statSync(target).size, sha256: await sha256File(target), userVersion, integrity },
    files,
    durationMs: Date.now() - started,
  };
  writeJson(join(dir, `${name}.json`), manifest);

  const old = listBackups(dbPath).slice(0, -keep);
  for (const b of old) {
    unlinkSync(b.file);
    const m = b.file.replace(/\.db$/, '.json');
    if (existsSync(m)) unlinkSync(m);
  }
  saveStatus(dbPath, { backup: { ok: integrity === 'ok', ...manifest, removed: old.length } });
  return { ...manifest, path: target, removed: old.length };
}

/** Какие файлы нужны базе: путь относительно data/, размер, когда добавлен. */
function referencedFiles(db) {
  const out = [];
  for (const f of db.prepare('SELECT sha256, mime, bytes, created_at FROM files').all()) {
    out.push({ rel: join('files', `${f.sha256}.${FILE_TYPES[f.mime]?.[1] ?? 'bin'}`), bytes: f.bytes, sha256: f.sha256, at: f.created_at });
  }
  for (const m of db.prepare('SELECT sha256, mime, bytes, created_at FROM media').all()) {
    out.push({ rel: join('media', `${m.sha256}.${MEDIA_EXT[m.mime] ?? 'bin'}`), bytes: m.bytes, sha256: m.sha256, at: m.created_at });
  }
  for (const e of db.prepare('SELECT file, bytes, sha256, created_at FROM document_exports').all()) {
    // путь записан абсолютным (/app/data/documents/…): берём часть начиная с documents/
    const i = e.file.split(sep).lastIndexOf('documents');
    if (i > -1) out.push({ rel: e.file.split(sep).slice(i).join(sep), bytes: e.bytes, sha256: e.sha256, at: e.created_at });
  }
  // один файл может быть записан несколько раз (одинаковое содержимое)
  return [...new Map(out.map((x) => [x.rel, x])).values()];
}

/**
 * Проверка восстановления из последней (или указанной) копии в отдельной папке:
 * контрольная сумма, целостность, открывается текущим кодом (миграции применяются к копии копии),
 * все файлы, на которые ссылается база, есть в зеркале. Рабочая база не трогается.
 */
export async function checkBackup({ dbPath, file = null }) {
  const started = Date.now();
  const errors = [];
  const warnings = [];
  const backups = listBackups(dbPath);
  const target = file ?? backups.at(-1)?.file;
  if (!target) {
    const result = { ok: false, checkedAt: new Date().toISOString(), errors: ['Резервных копий нет'], warnings };
    saveStatus(dbPath, { check: result });
    return result;
  }
  const dir = backupDir(dbPath);
  const manifestPath = target.replace(/\.db$/, '.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  if (!manifest) warnings.push('У копии нет манифеста (сделана старой версией скрипта) — контрольную сумму сверить не с чем');
  else if ((await sha256File(target)) !== manifest.db.sha256) errors.push('Контрольная сумма копии базы не совпадает — файл повреждён');

  const tmp = mkdtempSync(join(tmpdir(), 'kval-restore-'));
  const counts = {};
  let missing = [];
  let userVersion = null;
  try {
    const restored = join(tmp, 'kvalificator.db');
    copyFileSync(target, restored);
    let db;
    try {
      db = openDb(restored); // так же, как при запуске сервера: с миграциями
    } catch (err) {
      errors.push(`Текущая версия не открывает копию: ${err.message}`);
    }
    if (db) {
      const raw = db.raw;
      const integrity = raw.prepare('PRAGMA integrity_check').get().integrity_check;
      if (integrity !== 'ok') errors.push(`Проверка целостности базы: ${integrity}`);
      const fk = raw.prepare('PRAGMA foreign_key_check').all().length;
      if (fk) warnings.push(`Связей без пары (foreign key): ${fk}`);
      userVersion = raw.prepare('PRAGMA user_version').get().user_version;
      for (const t of ['admin_users', 'clients', 'tasks', 'leads', 'documents', 'mediaplans', 'meetings', 'chat_messages', 'files']) {
        counts[t] = raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      }
      const refs = referencedFiles(raw);
      counts.referencedFiles = refs.length;
      missing = refs.filter((r) => {
        const p = join(dir, 'data', r.rel);
        return !existsSync(p) || statSync(p).size !== r.bytes;
      });
      const recent = refs.filter((r) => !missing.includes(r)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, HASH_RECENT);
      for (const r of recent) {
        if ((await sha256File(join(dir, 'data', r.rel))) !== r.sha256) errors.push(`Файл повреждён в копии: ${r.rel}`);
      }
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (missing.length) errors.push(`В копии нет ${missing.length} ${missing.length === 1 ? 'файла' : 'файлов'}, на которые ссылается база (например, ${missing[0].rel})`);
  const result = {
    ok: !errors.length,
    checkedAt: new Date().toISOString(),
    backup: target.split(sep).pop(),
    userVersion,
    counts,
    errors,
    warnings,
    durationMs: Date.now() - started,
  };
  saveStatus(dbPath, { check: result });
  return result;
}
