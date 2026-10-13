// Медиатека документов: фото и креативы. Файлы лежат в data/media/<sha256>.<ext>, описание — в базе.
// Принимаем только JPEG и PNG: их понимают и браузер, и PowerPoint. WebP и фото с телефона браузер
// сотрудника заранее переводит в JPEG и разворачивает по EXIF (см. admin/docs.js).

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export class MediaError extends Error {}

export const MAX_BYTES = 15 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };

/** Размер картинки по заголовку файла: PNG — IHDR, JPEG — маркер SOF. */
export function imageInfo(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0–SOF15, кроме DHT (C4), JPG (C8) и DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export function createMedia({ db, dir }) {
  const root = join(dir, 'media');
  const q = {
    insert: db.prepare('INSERT INTO media (sha256, mime, width, height, bytes, name, uploaded_by, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM media WHERE id = ?'),
    bySha: db.prepare('SELECT * FROM media WHERE sha256 = ? ORDER BY id LIMIT 1'),
    list: db.prepare('SELECT * FROM media ORDER BY id DESC LIMIT ?'),
    remove: db.prepare('DELETE FROM media WHERE id = ?'),
    sameFile: db.prepare('SELECT COUNT(*) AS n FROM media WHERE sha256 = ?'),
  };
  const fileOf = (m) => join(root, `${m.sha256}.${EXT[m.mime]}`);

  function save(buf, { name = '', user }) {
    if (!buf?.length) throw new MediaError('Пустой файл');
    if (buf.length > MAX_BYTES) throw new MediaError('Файл больше 15 МБ — уменьшите его');
    const info = imageInfo(buf);
    if (!info || !info.width || !info.height) throw new MediaError('Нужен файл JPG или PNG');
    const sha256 = createHash('sha256').update(buf).digest('hex');
    // тот же файл уже загружали — возвращаем его, но под новым именем не плодим копии
    const existing = q.bySha.get(sha256);
    if (existing) return existing;
    mkdirSync(root, { recursive: true });
    const m = { sha256, mime: info.mime };
    writeFileSync(fileOf(m), buf);
    const label = String(name).replace(/[\\/]/g, ' ').trim().slice(0, 200) || null;
    const { lastInsertRowid } = q.insert.run(sha256, info.mime, info.width, info.height, buf.length, label, user?.name ?? null, user?.id ?? null);
    return q.get.get(lastInsertRowid);
  }

  function get(id) {
    const m = q.get.get(Number(id));
    if (!m) throw new MediaError('Изображение не найдено');
    return m;
  }

  const read = (m) => readFileSync(fileOf(m));

  /**
   * Подставляет в слайды сведения о картинках вместо номеров из медиатеки:
   * inline — данные внутри (PDF, PPTX, HTML-файл, проверка); иначе — ссылка (превью в админке, кешируется браузером).
   */
  function hydrate(spec, { inline = false } = {}) {
    const resolve = (id) => {
      const m = q.get.get(Number(id));
      if (!m || !existsSync(fileOf(m))) return { id, missing: true };
      const src = inline ? `data:${m.mime};base64,${read(m).toString('base64')}` : `/admin/api/media/${m.id}`;
      return { id: m.id, src, mime: m.mime, width: m.width, height: m.height };
    };
    const walk = (v, key) => {
      if (key === 'image' && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)))) return resolve(v);
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
      return v;
    };
    return { ...spec, slides: spec.slides.map((s) => walk(s)) };
  }

  return {
    save,
    get,
    read,
    list: (limit = 200) => q.list.all(limit),
    hydrate,
    remove(id, user) {
      const m = get(id);
      if (user.role !== 'admin' && m.uploaded_by_id !== user.id) throw new MediaError('Удалить изображение может тот, кто его загрузил, или администратор');
      q.remove.run(m.id);
      if (!q.sameFile.get(m.sha256).n && existsSync(fileOf(m))) unlinkSync(fileOf(m));
    },
  };
}
