// SQLite (встроенный node:sqlite): сессии диалогов и готовые лиды.
// Персональные данные хранятся только здесь — сервер размещается в РФ (152-ФЗ).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
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
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const q = {
    insertSession: db.prepare(
      `INSERT INTO sessions (id, token, channel, channel_user_id, handoff_code, state, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    getByHandoff: db.prepare('SELECT * FROM sessions WHERE handoff_code = ?'),
    getActiveByUser: db.prepare(
      `SELECT * FROM sessions WHERE channel = ? AND channel_user_id = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`,
    ),
    updateState: db.prepare(
      `UPDATE sessions SET state = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    moveToChannel: db.prepare(
      `UPDATE sessions SET channel = ?, channel_user_id = ?, handoff_code = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ),
    insertLead: db.prepare(
      `INSERT INTO leads (session_id, channel, rating, score, reasons, tags, answers, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
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
      q.insertSession.run(id, token, channel, channelUserId, handoffCode, JSON.stringify(state), JSON.stringify(meta));
      return parseSession(q.getSession.get(id));
    },
    getSession: (id) => parseSession(q.getSession.get(id)),
    getSessionByHandoff: (code) => parseSession(q.getByHandoff.get(code)),
    getActiveSession: (channel, userId) => parseSession(q.getActiveByUser.get(channel, String(userId))),
    saveState(id, state, status = 'active') {
      q.updateState.run(JSON.stringify(state), status, id);
    },
    moveToChannel(id, channel, userId) {
      q.moveToChannel.run(channel, String(userId), id);
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
        );
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
    assignLead: (id, assignee) => q.assignLead.run(assignee, id).changes === 1,
    close: () => db.close(),
  };
}
