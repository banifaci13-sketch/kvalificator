// «Новости» агентства: сотрудники делятся новостями, кейсами, ссылками, фото и видео;
// остальные читают, ставят реакции и обсуждают в комментариях.
// Уведомления — только о важном: закреплённая запись (всем), упоминание @Имя, комментарий к вашей записи.

import { fileAccess } from '../files/store.js';

export class NewsError extends Error {}

export const NEWS_KINDS = { news: 'Новость', case: 'Кейс', link: 'Ссылка' };
export const REACTIONS = ['👍', '❤️', '🔥', '👏', '😂', '🎉'];
const MAX_FILES = 10;

const text = (v, max) => {
  const s = String(v ?? '').replace(/\r\n/g, '\n').trim();
  return s ? s.slice(0, max) : null;
};
function checkLink(v) {
  const s = text(v, 1000);
  if (!s) return null;
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new NewsError('Ссылка выглядит неправильно');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new NewsError('Подойдёт ссылка, которая начинается с http:// или https://');
  return u.href;
}

export function createNews({ db, files = null }) {
  const canReadFile = fileAccess(db);
  let notify = null;
  const q = {
    insert: db.prepare('INSERT INTO news_posts (kind, title, body, link, client_id, case_task, case_result, pinned, author_id, author) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    update: db.prepare("UPDATE news_posts SET kind = ?, title = ?, body = ?, link = ?, client_id = ?, case_task = ?, case_result = ?, verified = ?, pinned = ?, edited_at = datetime('now') WHERE id = ?"),
    setFlags: db.prepare('UPDATE news_posts SET pinned = ?, verified = ? WHERE id = ?'),
    get: db.prepare(
      `SELECT p.*, c.name AS client_name, u.avatar_ver AS author_avatar,
              (SELECT COUNT(*) FROM news_comments k WHERE k.post_id = p.id) AS comments
       FROM news_posts p LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN admin_users u ON u.id = p.author_id WHERE p.id = ?`,
    ),
    page: db.prepare(
      `SELECT p.*, c.name AS client_name,
              (SELECT COUNT(*) FROM news_comments k WHERE k.post_id = p.id) AS comments
       FROM news_posts p LEFT JOIN clients c ON c.id = p.client_id
       WHERE (? IS NULL OR p.id < ?) AND (? IS NULL OR p.kind = ?) AND (? = 0 OR p.pinned = 1)
       ORDER BY CASE WHEN ? IS NULL THEN p.pinned ELSE 0 END DESC, p.id DESC LIMIT ?`,
    ),
    remove: db.prepare('DELETE FROM news_posts WHERE id = ?'),
    files: db.prepare('SELECT f.id, f.mime, f.kind, f.name, f.bytes FROM news_files nf JOIN files f ON f.id = nf.file_id WHERE nf.post_id = ? ORDER BY nf.position'),
    attach: db.prepare('INSERT OR IGNORE INTO news_files (post_id, file_id, position) VALUES (?, ?, ?)'),
    detachAll: db.prepare('DELETE FROM news_files WHERE post_id = ?'),
    file: db.prepare('SELECT * FROM files WHERE id = ?'),
    comments: db.prepare('SELECT * FROM news_comments WHERE post_id = ? ORDER BY id'),
    comment: db.prepare('SELECT * FROM news_comments WHERE id = ?'),
    addComment: db.prepare('INSERT INTO news_comments (post_id, author_id, author, body) VALUES (?, ?, ?, ?)'),
    removeComment: db.prepare('DELETE FROM news_comments WHERE id = ?'),
    reactions: db.prepare('SELECT emoji, user_id FROM news_reactions WHERE post_id = ?'),
    hasReaction: db.prepare('SELECT 1 FROM news_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?'),
    addReaction: db.prepare('INSERT INTO news_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)'),
    removeReaction: db.prepare('DELETE FROM news_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?'),
    client: db.prepare('SELECT id FROM clients WHERE id = ?'),
    team: db.prepare('SELECT id, name FROM admin_users WHERE disabled = 0'),
    unseen: db.prepare('SELECT COUNT(*) AS n FROM news_posts WHERE id > (SELECT news_seen FROM admin_users WHERE id = ?) AND (author_id IS NULL OR author_id != ?)'),
    seen: db.prepare('UPDATE admin_users SET news_seen = (SELECT COALESCE(MAX(id), 0) FROM news_posts) WHERE id = ?'),
    avatars: db.prepare('SELECT id, avatar_ver FROM admin_users WHERE avatar_ver IS NOT NULL'),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  function hydrate(p, userId) {
    const reactions = {};
    for (const r of q.reactions.all(p.id)) {
      reactions[r.emoji] ??= { count: 0, mine: false };
      reactions[r.emoji].count += 1;
      if (r.user_id === userId) reactions[r.emoji].mine = true;
    }
    return { ...p, pinned: Boolean(p.pinned), verified: Boolean(p.verified), files: q.files.all(p.id), reactions };
  }

  function getRaw(id) {
    const p = q.get.get(Number(id));
    if (!p) throw new NewsError('Запись не найдена');
    return p;
  }
  const canEdit = (p, user) => user.role === 'admin' || p.author_id === user.id;

  function fields(v, user, cur = null) {
    const kind = v.kind ?? cur?.kind ?? 'news';
    if (!(kind in NEWS_KINDS)) throw new NewsError('Неизвестный вид записи');
    const out = {
      kind,
      title: v.title !== undefined ? text(v.title, 200) : cur?.title ?? null,
      body: v.body !== undefined ? text(v.body, 10000) ?? '' : cur?.body ?? '',
      link: v.link !== undefined ? checkLink(v.link) : cur?.link ?? null,
      clientId: v.clientId !== undefined ? v.clientId : cur?.client_id ?? null,
      caseTask: v.caseTask !== undefined ? text(v.caseTask, 2000) : cur?.case_task ?? null,
      caseResult: v.caseResult !== undefined ? text(v.caseResult, 2000) : cur?.case_result ?? null,
      pinned: v.pinned !== undefined ? Boolean(v.pinned) : Boolean(cur?.pinned),
      verified: v.verified !== undefined ? Boolean(v.verified) : Boolean(cur?.verified),
    };
    if (out.clientId != null && !q.client.get(Number(out.clientId))) throw new NewsError('Клиент не найден');
    if (kind === 'link' && !out.link) throw new NewsError('Добавьте ссылку');
    if (kind === 'case' && !out.title && !out.caseTask) throw new NewsError('Опишите кейс: название или задачу клиента');
    // закрепить и подтвердить цифры кейса может только администратор
    if (user.role !== 'admin') {
      if (out.pinned !== Boolean(cur?.pinned)) throw new NewsError('Закреплять записи может администратор');
      if (out.verified !== Boolean(cur?.verified)) throw new NewsError('Подтверждает кейс администратор');
    }
    return out;
  }

  function checkFiles(ids, user) {
    const list = [...new Set((ids ?? []).map(Number))];
    if (list.length > MAX_FILES) throw new NewsError(`Не больше ${MAX_FILES} файлов в записи`);
    for (const id of list) {
      const f = q.file.get(id);
      if (!f) throw new NewsError('Файл не найден — загрузите его ещё раз');
      if (f.uploaded_by_id !== user.id && !(user.role === 'admin' && canReadFile(f.id, user))) throw new NewsError('Можно прикрепить только свои файлы');
    }
    return list;
  }

  // ---------- уведомления ----------
  const href = (id) => `#/news?post=${id}`;
  const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const headline = (p) => short(p.title || p.case_task || p.body || p.link || 'запись');
  function mentioned(body) {
    const out = new Set();
    for (const m of String(body ?? '').matchAll(/@([A-Za-zА-Яа-яЁё]{2,})/g)) {
      const word = m[1].toLowerCase();
      for (const u of q.team.all()) {
        const first = u.name.split(/\s+/)[0].toLowerCase();
        const base = first.length > 4 ? first.slice(0, -1) : first;
        if (word.startsWith(base)) out.add(u.id);
      }
    }
    return out;
  }
  function tellPost(p, user, wasPinned = false) {
    if (!notify) return;
    const told = new Set();
    if (p.pinned && !wasPinned) {
      for (const u of q.team.all()) {
        notify.add(u.id, { kind: 'news', text: `Важное в новостях: ${headline(p)}`, href: href(p.id), actor: user.name, actorId: user.id });
        told.add(u.id);
      }
    }
    for (const uid of mentioned(`${p.title ?? ''} ${p.body}`)) {
      if (!told.has(uid)) notify.add(uid, { kind: 'mention', text: `Вас упомянули в новостях: ${headline(p)}`, href: href(p.id), actor: user.name, actorId: user.id });
    }
  }

  // ---------- записи ----------
  function create(v, user) {
    const f = fields(v, user);
    const fileIds = checkFiles(v.fileIds, user);
    if (!f.body && !f.title && !f.link && !fileIds.length && !f.caseTask) throw new NewsError('Пустая запись: добавьте текст, фото, видео или ссылку');
    const id = tx(() => {
      const { lastInsertRowid } = q.insert.run(f.kind, f.title, f.body, f.link, f.clientId, f.caseTask, f.caseResult, Number(f.pinned), user.id, user.name);
      fileIds.forEach((fid, i) => q.attach.run(lastInsertRowid, fid, i));
      return Number(lastInsertRowid);
    });
    const p = get(id, user.id);
    tellPost(p, user);
    return p;
  }

  function update(id, v, user) {
    const cur = getRaw(id);
    // закрепить или подтвердить — администратор, даже в чужой записи; остальное — автор или администратор
    const onlyFlags = Object.keys(v).every((k) => k === 'pinned' || k === 'verified');
    if (!onlyFlags && !canEdit(cur, user)) throw new NewsError('Изменить запись может её автор или администратор');
    const f = fields(v, user, cur);
    tx(() => {
      if (onlyFlags) q.setFlags.run(Number(f.pinned), Number(f.verified), cur.id);
      else q.update.run(f.kind, f.title, f.body, f.link, f.clientId, f.caseTask, f.caseResult, Number(f.verified), Number(f.pinned), cur.id);
      if (v.fileIds !== undefined) {
        const ids = checkFiles(v.fileIds, user);
        const before = q.files.all(cur.id).map((x) => x.id);
        q.detachAll.run(cur.id);
        ids.forEach((fid, i) => q.attach.run(cur.id, fid, i));
        for (const fid of before) if (!ids.includes(fid)) files?.removeIfUnused(fid);
      }
    });
    const p = get(cur.id, user.id);
    tellPost(p, user, Boolean(cur.pinned));
    return p;
  }

  function remove(id, user) {
    const cur = getRaw(id);
    if (!canEdit(cur, user)) throw new NewsError('Удалить запись может её автор или администратор');
    const attached = q.files.all(cur.id).map((x) => x.id);
    q.remove.run(cur.id);
    for (const fid of attached) files?.removeIfUnused(fid);
  }

  const get = (id, userId) => hydrate(getRaw(id), userId);

  function list(userId, { before = null, kind = null, pinned = false, limit = 20 } = {}) {
    const b = before ? Number(before) : null;
    const k = kind && kind in NEWS_KINDS ? kind : null;
    const rows = q.page.all(b, b, k, k, Number(pinned), b, Math.min(50, limit) + 1);
    const more = rows.length > limit;
    return { posts: rows.slice(0, limit).map((p) => hydrate(p, userId)), more, avatars: Object.fromEntries(q.avatars.all().map((r) => [r.id, r.avatar_ver])) };
  }

  // ---------- комментарии и реакции ----------
  function addComment(id, body, user) {
    const p = getRaw(id);
    const msg = text(body, 3000);
    if (!msg) throw new NewsError('Пустой комментарий');
    q.addComment.run(p.id, user.id, user.name, msg);
    if (notify) {
      const who = mentioned(msg);
      for (const uid of who) notify.add(uid, { kind: 'mention', text: `Вас упомянули в обсуждении: ${short(msg)}`, href: href(p.id), actor: user.name, actorId: user.id });
      if (p.author_id && !who.has(p.author_id)) notify.add(p.author_id, { kind: 'comment', text: `Комментарий к вашей записи «${headline(p)}»: ${short(msg)}`, href: href(p.id), actor: user.name, actorId: user.id });
    }
    return q.comments.all(p.id);
  }
  function removeComment(commentId, user) {
    const c = q.comment.get(Number(commentId));
    if (!c) throw new NewsError('Комментарий не найден');
    if (user.role !== 'admin' && c.author_id !== user.id) throw new NewsError('Удалить комментарий может его автор или администратор');
    q.removeComment.run(c.id);
    return q.comments.all(c.post_id);
  }
  function react(id, emoji, user) {
    const p = getRaw(id);
    if (!REACTIONS.includes(emoji)) throw new NewsError('Такой реакции нет');
    if (q.hasReaction.get(p.id, user.id, emoji)) q.removeReaction.run(p.id, user.id, emoji);
    else q.addReaction.run(p.id, user.id, emoji);
    return hydrate(getRaw(p.id), user.id).reactions;
  }

  return {
    list,
    get,
    create,
    update,
    remove,
    comments: (id) => q.comments.all(getRaw(id).id),
    addComment,
    removeComment,
    react,
    unseen: (userId) => q.unseen.get(userId, userId).n,
    markSeen: (userId) => q.seen.run(userId),
    useNotify: (n) => {
      notify = n;
    },
  };
}
