// SQLite (встроенный node:sqlite): сессии диалогов и готовые лиды.
// Персональные данные хранятся только здесь — сервер размещается в РФ (152-ФЗ).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Миграции применяются по порядку; номер последней хранится в PRAGMA user_version.
// Существующие миграции не меняем — только добавляем новые в конец.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id              TEXT PRIMARY KEY,
     token           TEXT NOT NULL,
     channel         TEXT NOT NULL,
     channel_user_id TEXT,
     handoff_code    TEXT UNIQUE,
     state           TEXT NOT NULL,
     meta            TEXT NOT NULL DEFAULT '{}',
     status          TEXT NOT NULL DEFAULT 'active',
     created_at      TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX IF NOT EXISTS sessions_channel_user ON sessions (channel, channel_user_id, status);
   CREATE TABLE IF NOT EXISTS leads (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id         TEXT NOT NULL UNIQUE REFERENCES sessions(id),
     channel            TEXT NOT NULL,
     rating             INTEGER NOT NULL,
     score              REAL NOT NULL,
     reasons            TEXT NOT NULL,
     tags               TEXT NOT NULL,
     answers            TEXT NOT NULL,
     meta               TEXT NOT NULL,
     status             TEXT NOT NULL DEFAULT 'new',
     assignee           TEXT,
     delivered          TEXT NOT NULL DEFAULT '[]',
     notified           INTEGER NOT NULL DEFAULT 0,
     created_at         TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Админка: тестовые лиды, комментарии, история изменений, сотрудники и их сессии
  `ALTER TABLE leads ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE leads ADD COLUMN comment TEXT;
   CREATE INDEX leads_created ON leads (created_at);
   CREATE INDEX sessions_created ON sessions (created_at);
   CREATE TABLE lead_events (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     lead_id INTEGER NOT NULL REFERENCES leads(id),
     at      TEXT NOT NULL DEFAULT (datetime('now')),
     actor   TEXT NOT NULL,
     type    TEXT NOT NULL,
     data    TEXT NOT NULL DEFAULT '{}'
   );
   CREATE INDEX lead_events_lead ON lead_events (lead_id);
   CREATE TABLE admin_users (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name          TEXT NOT NULL,
     password_hash TEXT,
     yandex_id     TEXT UNIQUE,
     disabled      INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE admin_sessions (
     token_hash TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES admin_users(id),
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Роли сотрудников: первый заведённый сотрудник становится администратором
  `ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'manager';
   UPDATE admin_users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM admin_users);`,

  // Документы (презентации, КП, отчёты), пользовательские шаблоны и выгрузки
  `CREATE TABLE doc_templates (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     name        TEXT NOT NULL,
     description TEXT,
     variables   TEXT NOT NULL DEFAULT '[]',
     spec        TEXT NOT NULL,
     created_by  TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE documents (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     title       TEXT NOT NULL,
     spec        TEXT NOT NULL,
     template    TEXT,
     lead_id     INTEGER REFERENCES leads(id),
     created_by  TEXT,
     updated_by  TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX documents_lead ON documents (lead_id);
   CREATE TABLE document_exports (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     format      TEXT NOT NULL,
     file        TEXT NOT NULL,
     bytes       INTEGER NOT NULL,
     sha256      TEXT NOT NULL,
     manifest    TEXT NOT NULL,
     created_by  TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX document_exports_doc ON document_exports (document_id);`,
];

/** Номер текущей версии схемы базы. */
export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Миграция базы №${v + 1} не применилась: ${err.message}`);
    }
  }
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);

  const q = {
    insertSession: db.prepare(
      `INSERT INTO sessions (id, token, channel, channel_user_id, handoff_code, state, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    getByHandoff: db.prepare('SELECT * FROM sessions WHERE handoff_code = ?'),
    getActiveByUser: db.prepare(
      `SELECT * FROM sessions WHERE channel = ? AND channel_user_id = ? AND status = 'active'
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    ),
    abandonActive: db.prepare(
      `UPDATE sessions SET status = 'abandoned', updated_at = datetime('now')
       WHERE channel = ? AND channel_user_id = ? AND status = 'active'`,
    ),
    updateState: db.prepare(
      `UPDATE sessions SET state = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    moveToChannel: db.prepare(
      `UPDATE sessions SET channel = ?, channel_user_id = ?, meta = ?, handoff_code = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ),
    insertLead: db.prepare(
      `INSERT INTO leads (session_id, channel, rating, score, reasons, tags, answers, meta, is_test)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertEvent: db.prepare('INSERT INTO lead_events (lead_id, actor, type, data) VALUES (?, ?, ?, ?)'),
    listEvents: db.prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY id'),
    getLead: db.prepare('SELECT * FROM leads WHERE id = ?'),
    setDelivered: db.prepare('UPDATE leads SET delivered = ?, notified = ? WHERE id = ?'),
    unnotified: db.prepare(
      `SELECT * FROM leads WHERE notified = 0 AND created_at <= datetime('now', '-' || ? || ' seconds')
       ORDER BY id LIMIT 20`,
    ),
    assignLead: db.prepare(
      `UPDATE leads SET status = 'in_work', assignee = ? WHERE id = ? AND status = 'new'`,
    ),
  };

  const parseSession = (row) =>
    row && { ...row, state: JSON.parse(row.state), meta: JSON.parse(row.meta) };
  const parseLead = (row) =>
    row && {
      ...row,
      reasons: JSON.parse(row.reasons),
      tags: JSON.parse(row.tags),
      answers: JSON.parse(row.answers),
      meta: JSON.parse(row.meta),
      delivered: JSON.parse(row.delivered),
    };

  return {
    createSession({ id, token, channel, channelUserId = null, handoffCode = null, state, meta = {} }) {
      // В мессенджере у пользователя один активный опрос: новый закрывает предыдущий
      if (channelUserId != null) q.abandonActive.run(channel, String(channelUserId));
      q.insertSession.run(id, token, channel, channelUserId, handoffCode, JSON.stringify(state), JSON.stringify(meta));
      return parseSession(q.getSession.get(id));
    },
    getSession: (id) => parseSession(q.getSession.get(id)),
    getSessionByHandoff: (code) => parseSession(q.getByHandoff.get(code)),
    getActiveSession: (channel, userId) => parseSession(q.getActiveByUser.get(channel, String(userId))),
    saveState(id, state, status = 'active') {
      q.updateState.run(JSON.stringify(state), status, id);
    },
    /** Переносит диалог в мессенджер (deep link из виджета); метаданные сайта сохраняются. */
    moveToChannel(id, channel, userId, extraMeta = {}) {
      const session = parseSession(q.getSession.get(id));
      q.abandonActive.run(channel, String(userId));
      q.moveToChannel.run(channel, String(userId), JSON.stringify({ ...session.meta, ...extraMeta }), id);
    },
    /** Сохраняет лид и закрывает сессию одной транзакцией. */
    completeSession(session, state, lead) {
      db.exec('BEGIN');
      try {
        q.updateState.run(JSON.stringify(state), 'done', session.id);
        const { lastInsertRowid } = q.insertLead.run(
          session.id,
          session.channel,
          lead.rating,
          lead.score,
          JSON.stringify(lead.reasons),
          JSON.stringify(lead.tags),
          JSON.stringify(state.answers),
          JSON.stringify(session.meta),
          session.meta.test ? 1 : 0,
        );
        q.insertEvent.run(lastInsertRowid, 'система', 'created', JSON.stringify({ rating: lead.rating }));
        db.exec('COMMIT');
        return parseLead(q.getLead.get(lastInsertRowid));
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    getLead: (id) => parseLead(q.getLead.get(id)),
    setDelivered: (id, delivered, complete) => q.setDelivered.run(JSON.stringify(delivered), complete ? 1 : 0, id),
    /** Лиды, не дошедшие до всех получателей. Свежие пропускаем — их ещё отправляет основной поток. */
    unnotifiedLeads: (minAgeSeconds = 60) => q.unnotified.all(minAgeSeconds).map(parseLead),
    /** true, если лид был свободен и теперь закреплён за assignee. */
    assignLead(id, assignee) {
      if (q.assignLead.run(assignee, id).changes !== 1) return false;
      q.insertEvent.run(id, assignee, 'status', JSON.stringify({ from: 'new', to: 'in_work' }));
      q.insertEvent.run(id, assignee, 'assignee', JSON.stringify({ from: null, to: assignee }));
      return true;
    },
    /** Правка лида из админки: каждое изменённое поле пишется в историю. */
    updateLead(id, patch, actor) {
      const lead = q.getLead.get(id);
      if (!lead) return null;
      db.exec('BEGIN');
      try {
        for (const field of ['status', 'assignee', 'comment']) {
          if (!(field in patch) || patch[field] === lead[field]) continue;
          db.prepare(`UPDATE leads SET ${field} = ? WHERE id = ?`).run(patch[field], id);
          const data = field === 'comment' ? { text: patch[field] } : { from: lead[field], to: patch[field] };
          q.insertEvent.run(id, actor, field, JSON.stringify(data));
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return parseLead(q.getLead.get(id));
    },
    leadEvents: (id) => q.listEvents.all(id).map((e) => ({ ...e, data: JSON.parse(e.data) })),
    /** Для отчётов и админки, которым нужны собственные запросы. */
    raw: db,
    close: () => db.close(),
  };
}
