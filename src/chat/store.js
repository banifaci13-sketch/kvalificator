// Мессенджер сотрудников: личные чаты (на двоих, один на пару) и групповые — в том числе по проекту
// клиента. Хранится в нашей базе. Непрочитанное считается по последнему прочитанному сообщению
// участника; упоминание @Имя в группе — уведомление в колокольчик.

import { fileAccess } from '../files/store.js';

export class ChatError extends Error {}

const MAX_TEXT = 4000;
const MAX_FILES = 10;

export function createChat({ db, files = null }) {
  const canReadFile = fileAccess(db);
  let notify = null;
  const q = {
    chat: db.prepare('SELECT ch.*, c.name AS client_name FROM chats ch LEFT JOIN clients c ON c.id = ch.client_id WHERE ch.id = ?'),
    member: db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?'),
    members: db.prepare('SELECT u.id, u.name, u.position, u.avatar_ver, m.last_read FROM chat_members m JOIN admin_users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY u.name'),
    direct: db.prepare(
      `SELECT ch.id FROM chats ch
       JOIN chat_members a ON a.chat_id = ch.id AND a.user_id = ?
       JOIN chat_members b ON b.chat_id = ch.id AND b.user_id = ?
       WHERE ch.kind = 'direct' LIMIT 1`,
    ),
    insertChat: db.prepare('INSERT INTO chats (kind, title, client_id, created_by) VALUES (?, ?, ?, ?)'),
    addMember: db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id, last_read) VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE chat_id = ?))'),
    removeMember: db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?'),
    rename: db.prepare('UPDATE chats SET title = ?, client_id = ? WHERE id = ?'),
    touch: db.prepare("UPDATE chats SET last_at = datetime('now') WHERE id = ?"),
    list: db.prepare(
      `SELECT ch.*, c.name AS client_name, m.last_read,
              (SELECT COUNT(*) FROM chat_messages x WHERE x.chat_id = ch.id AND x.id > m.last_read AND x.deleted = 0 AND x.author_id IS NOT NULL AND x.author_id != ?) AS unread,
              (SELECT x.id FROM chat_messages x WHERE x.chat_id = ch.id ORDER BY x.id DESC LIMIT 1) AS last_id
       FROM chat_members m JOIN chats ch ON ch.id = m.chat_id LEFT JOIN clients c ON c.id = ch.client_id
       WHERE m.user_id = ? ORDER BY ch.last_at DESC, ch.id DESC`,
    ),
    lastMessage: db.prepare('SELECT id, author_id, author, body, deleted, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1'),
    filesOf: db.prepare('SELECT f.id, f.mime, f.kind, f.name, f.bytes FROM chat_files cf JOIN files f ON f.id = cf.file_id WHERE cf.message_id = ?'),
    page: db.prepare('SELECT * FROM chat_messages WHERE chat_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?'),
    after: db.prepare('SELECT * FROM chat_messages WHERE chat_id = ? AND id > ? ORDER BY id LIMIT 200'),
    insert: db.prepare('INSERT INTO chat_messages (chat_id, author_id, author, body) VALUES (?, ?, ?, ?)'),
    attach: db.prepare('INSERT OR IGNORE INTO chat_files (message_id, file_id) VALUES (?, ?)'),
    message: db.prepare('SELECT * FROM chat_messages WHERE id = ?'),
    edit: db.prepare("UPDATE chat_messages SET body = ?, edited_at = datetime('now') WHERE id = ?"),
    softDelete: db.prepare("UPDATE chat_messages SET deleted = 1, body = '', edited_at = datetime('now') WHERE id = ?"),
    detachAll: db.prepare('DELETE FROM chat_files WHERE message_id = ?'),
    read: db.prepare('UPDATE chat_members SET last_read = MAX(last_read, ?) WHERE chat_id = ? AND user_id = ?'),
    user: db.prepare('SELECT id, name FROM admin_users WHERE id = ? AND disabled = 0'),
    team: db.prepare('SELECT id, name FROM admin_users WHERE disabled = 0'),
    file: db.prepare('SELECT id, uploaded_by_id FROM files WHERE id = ?'),
    client: db.prepare('SELECT id, name FROM clients WHERE id = ?'),
    // новые сообщения во всех чатах сотрудника — для всплывающих окон и счётчика
    incoming: db.prepare(
      `SELECT x.id, x.chat_id, x.author_id, x.author, x.body, x.created_at, ch.kind, ch.title, cl.name AS client_name
       FROM chat_messages x JOIN chat_members m ON m.chat_id = x.chat_id AND m.user_id = ?
       JOIN chats ch ON ch.id = x.chat_id LEFT JOIN clients cl ON cl.id = ch.client_id
       WHERE x.id > ? AND x.id > m.last_read AND x.deleted = 0 AND x.author_id IS NOT NULL AND x.author_id != ?
       ORDER BY x.id LIMIT 20`,
    ),
    unreadTotal: db.prepare(
      `SELECT COUNT(*) AS n FROM chat_messages x JOIN chat_members m ON m.chat_id = x.chat_id AND m.user_id = ?
       WHERE x.id > m.last_read AND x.deleted = 0 AND x.author_id IS NOT NULL AND x.author_id != ?`,
    ),
    maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages'),
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

  function access(chatId, user) {
    const ch = q.chat.get(Number(chatId));
    if (!ch) throw new ChatError('Чат не найден');
    if (!q.member.get(ch.id, user.id)) throw new ChatError('Вы не участник этого чата');
    return ch;
  }

  /** Название чата для конкретного сотрудника: в личном — имя собеседника. */
  function view(ch, user) {
    const members = q.members.all(ch.id);
    const other = ch.kind === 'direct' ? members.find((m) => m.id !== user.id) ?? members[0] : null;
    const last = q.lastMessage.get(ch.id);
    return {
      id: ch.id,
      kind: ch.kind,
      title: ch.kind === 'direct' ? other?.name ?? 'Личный чат' : ch.title || (ch.client_name ? `Проект «${ch.client_name}»` : 'Группа'),
      client_id: ch.client_id,
      client_name: ch.client_name,
      peer: other ? { id: other.id, name: other.name, position: other.position } : null,
      members: members.map((m) => ({ id: m.id, name: m.name, position: m.position, last_read: m.last_read })),
      unread: ch.unread ?? 0,
      last_at: ch.last_at,
      last: last ? { id: last.id, author: last.author, author_id: last.author_id, text: last.deleted ? 'Сообщение удалено' : last.body.slice(0, 140), at: last.created_at, files: last.deleted ? 0 : q.filesOf.all(last.id).length } : null,
    };
  }

  const message = (m) => ({ ...m, deleted: Boolean(m.deleted), files: m.deleted ? [] : q.filesOf.all(m.id) });

  function list(user) {
    return q.list.all(user.id, user.id).map((ch) => view(ch, user));
  }

  /** Личный чат с коллегой — существующий или новый. */
  function direct(user, otherId) {
    const other = q.user.get(Number(otherId));
    if (!other) throw new ChatError('Сотрудник не найден');
    if (other.id === user.id) throw new ChatError('Личный чат — с коллегой, не с собой');
    const found = q.direct.get(user.id, other.id);
    if (found) return view(q.chat.get(found.id), user);
    const id = tx(() => {
      const { lastInsertRowid } = q.insertChat.run('direct', null, null, user.id);
      q.addMember.run(lastInsertRowid, user.id, lastInsertRowid);
      q.addMember.run(lastInsertRowid, other.id, lastInsertRowid);
      return Number(lastInsertRowid);
    });
    return view(q.chat.get(id), user);
  }

  /** Групповой чат: название, участники; clientId — чат проекта клиента. */
  function group(user, { title = '', memberIds = [], clientId = null }) {
    const client = clientId ? q.client.get(Number(clientId)) : null;
    if (clientId && !client) throw new ChatError('Клиент не найден');
    const name = String(title ?? '').trim().slice(0, 100) || (client ? `Проект «${client.name}»` : '');
    if (!name) throw new ChatError('Назовите чат');
    const ids = [...new Set([user.id, ...memberIds.map(Number)])];
    if (ids.length < 2) throw new ChatError('Добавьте хотя бы одного коллегу');
    if (ids.length > 100) throw new ChatError('Не больше 100 участников');
    for (const id of ids) if (!q.user.get(id)) throw new ChatError('Сотрудник не найден');
    const id = tx(() => {
      const { lastInsertRowid } = q.insertChat.run('group', name, client?.id ?? null, user.id);
      for (const uid of ids) q.addMember.run(lastInsertRowid, uid, lastInsertRowid);
      q.insert.run(lastInsertRowid, null, 'Ассистент', `${user.name} создал(а) чат «${name}»`);
      return Number(lastInsertRowid);
    });
    return view(q.chat.get(id), user);
  }

  function update(chatId, user, { title, addIds = [], removeIds = [] }) {
    const ch = access(chatId, user);
    if (ch.kind === 'direct') throw new ChatError('Личный чат не меняется — создайте группу');
    tx(() => {
      if (title !== undefined) {
        const name = String(title ?? '').trim().slice(0, 100);
        if (!name) throw new ChatError('Назовите чат');
        q.rename.run(name, ch.client_id, ch.id);
      }
      const added = [];
      for (const uid of addIds.map(Number)) {
        const u = q.user.get(uid);
        if (u && !q.member.get(ch.id, uid)) (q.addMember.run(ch.id, uid, ch.id), added.push(u.name));
      }
      const removed = [];
      for (const uid of removeIds.map(Number)) {
        const u = q.user.get(uid);
        if (u && q.member.get(ch.id, uid)) (q.removeMember.run(ch.id, uid), removed.push(u.name));
      }
      if (added.length) q.insert.run(ch.id, null, 'Ассистент', `${user.name} добавил(а): ${added.join(', ')}`);
      if (removed.length) q.insert.run(ch.id, null, 'Ассистент', removed.length === 1 && removeIds.map(Number)[0] === user.id ? `${user.name} вышел(а) из чата` : `${user.name} убрал(а): ${removed.join(', ')}`);
    });
    return removeIds.map(Number).includes(user.id) ? null : view(q.chat.get(ch.id), user);
  }

  function messages(chatId, user, { before = null, after = null, limit = 50 } = {}) {
    const ch = access(chatId, user);
    const rows = after != null ? q.after.all(ch.id, Number(after)) : q.page.all(ch.id, before, before, Math.min(100, limit)).reverse();
    return { chat: view({ ...ch, unread: 0 }, user), messages: rows.map(message) };
  }

  function send(chatId, user, { text = '', fileIds = [] }) {
    const ch = access(chatId, user);
    const body = String(text ?? '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
    const ids = [...new Set(fileIds.map(Number))];
    if (!body && !ids.length) throw new ChatError('Пустое сообщение');
    if (ids.length > MAX_FILES) throw new ChatError(`Не больше ${MAX_FILES} файлов в сообщении`);
    for (const fid of ids) {
      const f = q.file.get(fid);
      if (!f) throw new ChatError('Файл не найден — загрузите его ещё раз');
      if (f.uploaded_by_id !== user.id && !(user.role === 'admin' && canReadFile(f.id, user))) throw new ChatError('Можно отправить только свои файлы');
    }
    const id = tx(() => {
      const { lastInsertRowid } = q.insert.run(ch.id, user.id, user.name, body);
      for (const fid of ids) q.attach.run(lastInsertRowid, fid);
      q.touch.run(ch.id);
      q.read.run(lastInsertRowid, ch.id, user.id);
      return Number(lastInsertRowid);
    });
    // упоминание @Имя в группе — в колокольчик (сами сообщения приходят в мессенджер)
    if (notify && ch.kind !== 'direct' && body.includes('@')) {
      const members = new Set(q.members.all(ch.id).map((m) => m.id));
      for (const m of body.matchAll(/@([A-Za-zА-Яа-яЁё]{2,})/g)) {
        const word = m[1].toLowerCase();
        for (const u of q.team.all()) {
          const first = u.name.split(/\s+/)[0].toLowerCase();
          const base = first.length > 4 ? first.slice(0, -1) : first;
          if (members.has(u.id) && word.startsWith(base)) notify.add(u.id, { kind: 'mention', text: `Вас упомянули в чате «${view(ch, { id: u.id }).title}»: ${body.slice(0, 120)}`, href: `#/chat?id=${ch.id}`, actor: user.name, actorId: user.id });
        }
      }
    }
    return message(q.message.get(id));
  }

  function edit(messageId, user, text) {
    const m = q.message.get(Number(messageId));
    if (!m || m.deleted) throw new ChatError('Сообщение не найдено');
    access(m.chat_id, user);
    if (m.author_id !== user.id) throw new ChatError('Изменить можно только своё сообщение');
    const body = String(text ?? '').trim().slice(0, MAX_TEXT);
    if (!body) throw new ChatError('Пустое сообщение');
    q.edit.run(body, m.id);
    return message(q.message.get(m.id));
  }

  function remove(messageId, user) {
    const m = q.message.get(Number(messageId));
    if (!m || m.deleted) throw new ChatError('Сообщение не найдено');
    access(m.chat_id, user);
    if (m.author_id !== user.id && user.role !== 'admin') throw new ChatError('Удалить можно только своё сообщение');
    const attached = q.filesOf.all(m.id).map((f) => f.id);
    tx(() => {
      q.softDelete.run(m.id);
      q.detachAll.run(m.id);
    });
    for (const fid of attached) files?.removeIfUnused(fid);
    return message(q.message.get(m.id));
  }

  function markRead(chatId, user, lastId) {
    const ch = access(chatId, user);
    q.read.run(Number(lastId), ch.id, user.id);
    return q.unreadTotal.get(user.id, user.id).n;
  }

  /** Новые сообщения после id (для всплывающих окон) и общее число непрочитанных. */
  function incoming(user, after = null) {
    const unread = q.unreadTotal.get(user.id, user.id).n;
    if (after == null) return { unread, last: q.maxId.get().id, messages: [] };
    const rows = q.incoming.all(user.id, Number(after), user.id).map((x) => ({
      ...x,
      chat_title: x.kind === 'direct' ? x.author : x.title || (x.client_name ? `Проект «${x.client_name}»` : 'Группа'),
      files: q.filesOf.all(x.id).length,
    }));
    return { unread, last: Math.max(Number(after), ...rows.map((r) => r.id)), messages: rows };
  }

  return {
    list,
    direct,
    group,
    update,
    messages,
    send,
    edit,
    remove,
    markRead,
    incoming,
    useNotify: (n) => {
      notify = n;
    },
  };
}
