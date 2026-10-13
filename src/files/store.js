// Файлы сотрудников: фото и видео для «Новостей», вложения к задачам. Лежат на нашем сервере
// в data/files/<sha256>.<расширение>, описание — в базе. Принимаем только известные форматы и
// проверяем, что содержимое совпадает с заявленным типом: HTML или SVG под видом картинки не пройдёт.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export class FileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MB = 1024 * 1024;
export const FILE_LIMITS = { image: 20 * MB, video: 100 * MB, doc: 25 * MB };

// тип → [вид, расширение, проверка первых байтов]
const starts = (...sig) => (b) => sig.every((x, i) => x == null || b[i] === x);
const ascii = (s, at = 0) => (b) => b.slice(at, at + s.length).toString('latin1') === s;
const zip = starts(0x50, 0x4b, 0x03, 0x04);
export const FILE_TYPES = {
  'image/jpeg': ['image', 'jpg', starts(0xff, 0xd8, 0xff)],
  'image/png': ['image', 'png', starts(0x89, 0x50, 0x4e, 0x47)],
  'image/webp': ['image', 'webp', (b) => ascii('RIFF')(b) && ascii('WEBP', 8)(b)],
  'image/gif': ['image', 'gif', ascii('GIF8')],
  'video/mp4': ['video', 'mp4', ascii('ftyp', 4)],
  'video/quicktime': ['video', 'mov', ascii('ftyp', 4)],
  'video/webm': ['video', 'webm', starts(0x1a, 0x45, 0xdf, 0xa3)],
  'application/pdf': ['doc', 'pdf', ascii('%PDF')],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['doc', 'docx', zip],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['doc', 'xlsx', zip],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['doc', 'pptx', zip],
  'application/zip': ['doc', 'zip', zip],
  'text/plain': ['doc', 'txt', () => true],
  'text/csv': ['doc', 'csv', () => true],
};
export const UPLOAD_TYPES = Object.keys(FILE_TYPES);

/** Тип файла без параметров: «text/plain; charset=utf-8» → «text/plain». */
export const baseMime = (s) => String(s ?? '').split(';')[0].trim().toLowerCase();

/**
 * Кто может открыть файл: тот, кто загрузил; все сотрудники — если файл прикреплён к новости, задаче
 * или клиенту; вложение из чата — только участники этого чата (переписка личная, администратор тоже не видит).
 */
export function fileAccess(db) {
  let q = null;
  const sql = `SELECT f.uploaded_by_id = ?
      OR EXISTS (SELECT 1 FROM news_files WHERE file_id = f.id)
      OR EXISTS (SELECT 1 FROM task_files WHERE file_id = f.id)
      OR EXISTS (SELECT 1 FROM client_files WHERE file_id = f.id)
      OR EXISTS (SELECT 1 FROM chat_files cf JOIN chat_messages m ON m.id = cf.message_id AND m.deleted = 0
                 JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ? WHERE cf.file_id = f.id) AS ok
    FROM files f WHERE f.id = ?`;
  return (fileId, user) => Boolean(user?.id && (q ??= db.prepare(sql)).get(user.id, user.id, Number(fileId))?.ok);
}

export function createFiles({ db, dir }) {
  const root = join(dir, 'files');
  const q = {
    insert: db.prepare('INSERT INTO files (sha256, mime, kind, name, bytes, uploaded_by, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM files WHERE id = ?'),
    remove: db.prepare('DELETE FROM files WHERE id = ?'),
    sameFile: db.prepare('SELECT COUNT(*) AS n FROM files WHERE sha256 = ?'),
    used: db.prepare('SELECT (SELECT COUNT(*) FROM news_files WHERE file_id = ?) + (SELECT COUNT(*) FROM task_files WHERE file_id = ?) + (SELECT COUNT(*) FROM client_files WHERE file_id = ?) + (SELECT COUNT(*) FROM chat_files WHERE file_id = ?) AS n'),
  };
  const canRead = fileAccess(db);
  const pathOf = (f) => join(root, `${f.sha256}.${FILE_TYPES[f.mime]?.[1] ?? 'bin'}`);

  /** Сохранить файл из потока. Размер проверяется на лету — лишнее не дописываем на диск. */
  async function save(stream, { mime, name = '', user }) {
    const type = FILE_TYPES[baseMime(mime)];
    if (!type) throw new FileError('Такой формат не поддерживается: подойдут фото (JPG, PNG, WebP, GIF), видео (MP4, MOV, WebM), PDF, Word, Excel, PowerPoint, ZIP, TXT, CSV', 415);
    const [kind, , check] = type;
    const limit = FILE_LIMITS[kind];
    mkdirSync(join(root, 'tmp'), { recursive: true });
    const tmp = join(root, 'tmp', randomBytes(8).toString('hex'));
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, enc, cb) {
        bytes += chunk.length;
        if (bytes > limit) return cb(new FileError(`Файл больше ${limit / MB} МБ — уменьшите его${kind === 'video' ? ' или дайте ссылку на Rutube, VK Видео или Яндекс Диск' : ''}`, 413));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(tmp));
    } catch (err) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw err instanceof FileError ? err : new FileError('Файл не загрузился целиком — попробуйте ещё раз');
    }
    if (!bytes) {
      unlinkSync(tmp);
      throw new FileError('Пустой файл');
    }
    const head = Buffer.alloc(16);
    const fd = openSync(tmp, 'r');
    readSync(fd, head, 0, 16, 0);
    closeSync(fd);
    if (!check(head)) {
      unlinkSync(tmp);
      throw new FileError('Содержимое файла не совпадает с его форматом', 415);
    }
    const sha256 = hash.digest('hex');
    const row = { sha256, mime: baseMime(mime) };
    if (existsSync(pathOf(row))) unlinkSync(tmp);
    else renameSync(tmp, pathOf(row));
    const label = String(name).replace(/[\\/\0]/g, ' ').trim().slice(0, 200) || `файл.${type[1]}`;
    const { lastInsertRowid } = q.insert.run(sha256, row.mime, kind, label, bytes, user?.name ?? null, user?.id ?? null);
    return q.get.get(lastInsertRowid);
  }

  /** user — проверить доступ: чужой файл отвечает «не найден», чтобы нельзя было перебрать номера. */
  function get(id, user = null) {
    const f = q.get.get(Number(id));
    if (!f || (user && !canRead(f.id, user))) throw new FileError('Файл не найден', 404);
    return f;
  }

  function size(f) {
    const path = pathOf(f);
    if (!existsSync(path)) throw new FileError('Файл не найден на диске', 404);
    return statSync(path).size;
  }

  /** Поток для отдачи; range — { start, end } для перемотки видео. */
  function open(f, range = null) {
    return { size: size(f), stream: createReadStream(pathOf(f), range ?? {}) };
  }

  /** Удалить запись; сам файл — когда на него больше никто не ссылается. */
  function remove(id) {
    const f = q.get.get(Number(id));
    if (!f) return;
    q.remove.run(f.id);
    if (!q.sameFile.get(f.sha256).n && existsSync(pathOf(f))) unlinkSync(pathOf(f));
  }

  /** Удалить файл, если он больше нигде не прикреплён (ни к новостям, ни к задаче, ни к клиенту). */
  function removeIfUnused(id) {
    if (!q.used.get(Number(id), Number(id), Number(id), Number(id)).n) remove(id);
  }

  return { save, get, canRead, size, open, remove, removeIfUnused };
}
