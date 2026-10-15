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

  // Медиапланы и нормативы агентства по каналам (средние ставки, CTR, конверсия — из прошлых кампаний)
  `CREATE TABLE mediaplans (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     title       TEXT NOT NULL,
     client      TEXT,
     lead_id     INTEGER REFERENCES leads(id),
     spec        TEXT NOT NULL,
     created_by  TEXT,
     updated_by  TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX mediaplans_lead ON mediaplans (lead_id);
   CREATE TABLE mp_benchmarks (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     channel     TEXT NOT NULL,
     model       TEXT NOT NULL DEFAULT 'cpc',
     cpc         REAL,
     cpm         REAL,
     ctr         REAL,
     cr          REAL,
     note        TEXT NOT NULL,
     updated_by  TEXT,
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Клиенты агентства и задачи команды по ним (доска в духе YouGile)
  `CREATE TABLE clients (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     name        TEXT NOT NULL,
     contact     TEXT,
     phone       TEXT,
     email       TEXT,
     site        TEXT,
     notes       TEXT,
     manager_id  INTEGER REFERENCES admin_users(id),
     lead_id     INTEGER REFERENCES leads(id),
     archived    INTEGER NOT NULL DEFAULT 0,
     created_by  TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE tasks (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
     title        TEXT NOT NULL,
     description  TEXT,
     status       TEXT NOT NULL DEFAULT 'todo',
     priority     INTEGER NOT NULL DEFAULT 0,
     assignee_id  INTEGER REFERENCES admin_users(id),
     due          TEXT,
     created_by   TEXT,
     created_by_id INTEGER REFERENCES admin_users(id),
     created_at   TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
     done_at      TEXT
   );
   CREATE INDEX tasks_client ON tasks (client_id);
   CREATE INDEX tasks_assignee ON tasks (assignee_id, status);
   CREATE TABLE task_comments (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     kind        TEXT NOT NULL DEFAULT 'comment',
     text        TEXT NOT NULL,
     author      TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX task_comments_task ON task_comments (task_id);`,

  // Календарь встреч; Telegram сотрудника для напоминаний; секретная ссылка на подписку календаря
  `ALTER TABLE admin_users ADD COLUMN telegram_chat_id TEXT;
   ALTER TABLE admin_users ADD COLUMN telegram_link_code TEXT;
   ALTER TABLE admin_users ADD COLUMN calendar_token TEXT;
   CREATE UNIQUE INDEX admin_users_calendar ON admin_users (calendar_token) WHERE calendar_token IS NOT NULL;
   CREATE TABLE meetings (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     title        TEXT NOT NULL,
     starts_at    TEXT NOT NULL,
     duration     INTEGER NOT NULL DEFAULT 60,
     format       TEXT NOT NULL DEFAULT 'online',
     provider     TEXT,
     link         TEXT,
     host_link    TEXT,
     external_id  TEXT,
     place        TEXT,
     client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
     lead_id      INTEGER REFERENCES leads(id),
     guests       TEXT,
     agenda       TEXT,
     remind       TEXT NOT NULL DEFAULT '[1440,15]',
     cancelled    INTEGER NOT NULL DEFAULT 0,
     created_by   TEXT,
     created_by_id INTEGER REFERENCES admin_users(id),
     created_at   TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX meetings_start ON meetings (starts_at);
   CREATE TABLE meeting_participants (
     meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     user_id     INTEGER NOT NULL REFERENCES admin_users(id),
     PRIMARY KEY (meeting_id, user_id)
   );
   CREATE TABLE meeting_reminders_sent (
     meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     user_id     INTEGER NOT NULL,
     offset_min  INTEGER NOT NULL,
     sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (meeting_id, user_id, offset_min)
   );
   CREATE TABLE digests_sent (
     user_id     INTEGER NOT NULL,
     day         TEXT NOT NULL,
     PRIMARY KEY (user_id, day)
   );`,

  // Журнал запросов к ИИ: кто, что и сколько — для контроля расходов (тексты не храним)
  `CREATE TABLE ai_log (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id     INTEGER,
     action      TEXT NOT NULL,
     provider    TEXT,
     model       TEXT,
     chars_in    INTEGER,
     chars_out   INTEGER,
     replaced    INTEGER,
     ok          INTEGER NOT NULL,
     error       TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  // Медиатека: фото и креативы для документов (файлы — в data/media, здесь описание)
  `CREATE TABLE media (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     sha256      TEXT NOT NULL,
     mime        TEXT NOT NULL,
     width       INTEGER NOT NULL,
     height      INTEGER NOT NULL,
     bytes       INTEGER NOT NULL,
     name        TEXT,
     uploaded_by TEXT,
     uploaded_by_id INTEGER,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX media_sha ON media (sha256);`,

  // Данные сотрудника: должность и телефон (видны коллегам в задачах и встречах)
  `ALTER TABLE admin_users ADD COLUMN position TEXT;
   ALTER TABLE admin_users ADD COLUMN phone TEXT;`,

  // Задачи как в YouGile: проект (клиент или «Общие задачи») → доски → свои колонки.
  // Старые статусы переезжают в колонки доски «Задачи» каждого проекта; «срочно» — важность «высокая».
  `CREATE TABLE task_boards (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     position    INTEGER NOT NULL DEFAULT 0,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX task_boards_client ON task_boards (client_id, position);
   CREATE TABLE task_columns (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     board_id    INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     color       TEXT NOT NULL DEFAULT 'gray',
     position    INTEGER NOT NULL DEFAULT 0,
     is_done     INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX task_columns_board ON task_columns (board_id, position);
   ALTER TABLE tasks ADD COLUMN column_id INTEGER REFERENCES task_columns(id) ON DELETE SET NULL;
   CREATE INDEX tasks_column ON tasks (column_id);
   INSERT INTO task_boards (client_id, name) SELECT DISTINCT client_id, 'Задачи' FROM tasks;
   INSERT INTO task_columns (board_id, name, color, position, is_done)
     SELECT b.id, c.name, c.color, c.pos, c.done FROM task_boards b,
       (SELECT 'К выполнению' AS name, 'gray' AS color, 0 AS pos, 0 AS done
        UNION ALL SELECT 'В работе', 'orange', 1, 0
        UNION ALL SELECT 'На проверке', 'violet', 2, 0
        UNION ALL SELECT 'Готово', 'green', 3, 1) c;
   UPDATE tasks SET column_id = (
     SELECT col.id FROM task_columns col JOIN task_boards b ON b.id = col.board_id
     WHERE b.client_id IS tasks.client_id
       AND col.position = CASE tasks.status WHEN 'doing' THEN 1 WHEN 'review' THEN 2 WHEN 'done' THEN 3 ELSE 0 END);
   UPDATE tasks SET status = 'todo' WHERE status != 'done';
   UPDATE tasks SET priority = 3 WHERE priority = 1;`,

  // Время дедлайна задачи (по Москве, ЧЧ:ММ); без времени срок — до конца дня
  `ALTER TABLE tasks ADD COLUMN due_time TEXT;`,

  // Личные настройки внешнего вида кабинета (JSON): тема, цвет, фон, плотность, панель, стартовый раздел
  `ALTER TABLE admin_users ADD COLUMN prefs TEXT;`,

  // Связи задачи с результатом работы: медиаплан, документ, встреча (создан из задачи или привязан)
  `CREATE TABLE task_links (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     kind       TEXT NOT NULL CHECK (kind IN ('mediaplan', 'document', 'meeting')),
     ref_id     INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE (task_id, kind, ref_id)
   );
   CREATE INDEX task_links_ref ON task_links (kind, ref_id);`,

  // ИИ-ассистент: регламенты агентства (база знаний) и история диалога каждого сотрудника
  `CREATE TABLE kb_docs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     title       TEXT NOT NULL,
     body        TEXT NOT NULL,
     updated_by  TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE assistant_messages (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
     role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
     text        TEXT NOT NULL,
     meta        TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX assistant_messages_user ON assistant_messages (user_id, id);`,

  // Уведомления в кабинете (колокольчик): назначения, комментарии, упоминания, приглашения
  `CREATE TABLE notifications (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
     kind        TEXT NOT NULL,
     text        TEXT NOT NULL,
     href        TEXT,
     actor       TEXT,
     actor_id    INTEGER,
     read_at     TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX notifications_user ON notifications (user_id, read_at, id);`,

  // Фото профиля: квадрат 256×256, хранится в своей базе на нашем сервере; версия — для кэша браузера
  `CREATE TABLE user_avatars (
     user_id     INTEGER PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
     mime        TEXT NOT NULL,
     data        BLOB NOT NULL,
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   ALTER TABLE admin_users ADD COLUMN avatar_ver INTEGER;`,

  // Файлы сотрудников (фото, видео, вложения) и «Новости» агентства: записи, кейсы, ссылки,
  // комментарии и реакции. news_seen — до какой записи сотрудник уже смотрел ленту (счётчик в меню).
  `CREATE TABLE files (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     sha256         TEXT NOT NULL,
     mime           TEXT NOT NULL,
     kind           TEXT NOT NULL,
     name           TEXT NOT NULL,
     bytes          INTEGER NOT NULL,
     uploaded_by    TEXT,
     uploaded_by_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
     created_at     TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE news_posts (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     kind        TEXT NOT NULL DEFAULT 'news',
     title       TEXT,
     body        TEXT NOT NULL DEFAULT '',
     link        TEXT,
     client_id   INTEGER REFERENCES clients(id) ON DELETE SET NULL,
     case_task   TEXT,
     case_result TEXT,
     verified    INTEGER NOT NULL DEFAULT 0,
     pinned      INTEGER NOT NULL DEFAULT 0,
     author_id   INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
     author      TEXT NOT NULL,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     edited_at   TEXT
   );
   CREATE INDEX news_posts_order ON news_posts (pinned, id);
   CREATE TABLE news_files (
     post_id  INTEGER NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE,
     file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     position INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (post_id, file_id)
   );
   CREATE TABLE news_comments (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     post_id    INTEGER NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE,
     author_id  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
     author     TEXT NOT NULL,
     body       TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX news_comments_post ON news_comments (post_id, id);
   CREATE TABLE news_reactions (
     post_id INTEGER NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
     emoji   TEXT NOT NULL,
     PRIMARY KEY (post_id, user_id, emoji)
   );
   ALTER TABLE admin_users ADD COLUMN news_seen INTEGER NOT NULL DEFAULT 0;`,

  // Повторяющиеся задачи: правило повтора и ссылка на уже созданную следующую (чтобы не плодить копии)
  `ALTER TABLE tasks ADD COLUMN repeat TEXT;
   ALTER TABLE tasks ADD COLUMN repeat_next INTEGER;`,

  // Чек-лист задачи: пункты с галочками (в том числе из регламентов агентства)
  `CREATE TABLE task_checklist (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     text       TEXT NOT NULL,
     done       INTEGER NOT NULL DEFAULT 0,
     position   INTEGER NOT NULL DEFAULT 0,
     done_by    TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX task_checklist_task ON task_checklist (task_id, position);`,

  // Вложения к задачам: файлы из общего хранилища (data/files)
  `CREATE TABLE task_files (
     task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     added_by   TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (task_id, file_id)
   );
   CREATE INDEX task_files_file ON task_files (file_id);`,

  // Деньги по клиентам: абонентская плата за ведение, день оплаты, счета и оплаты.
  // auto = 1 — ежемесячный счёт за ведение, создан сам (один на клиента и месяц).
  `ALTER TABLE clients ADD COLUMN fee REAL;
   ALTER TABLE clients ADD COLUMN pay_day INTEGER;
   CREATE TABLE client_payments (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
     kind       TEXT NOT NULL DEFAULT 'fee',
     title      TEXT,
     amount     REAL NOT NULL,
     period     TEXT,
     due        TEXT,
     paid_at    TEXT,
     invoice    TEXT,
     note       TEXT,
     auto       INTEGER NOT NULL DEFAULT 0,
     reminded   TEXT NOT NULL DEFAULT '',
     created_by TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX client_payments_client ON client_payments (client_id, due);
   CREATE UNIQUE INDEX client_payments_auto ON client_payments (client_id, period) WHERE auto = 1;`,

  // Итоги встречи (постмит): резюме; задачи по итогам — обычные задачи, связанные со встречей
  `ALTER TABLE meetings ADD COLUMN summary TEXT;
   ALTER TABLE meetings ADD COLUMN summary_by TEXT;
   ALTER TABLE meetings ADD COLUMN summary_at TEXT;`,

  // Файлы клиента: договор, брифы, доступы, макеты — из общего хранилища (data/files)
  `CREATE TABLE client_files (
     client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
     file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     added_by   TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (client_id, file_id)
   );
   CREATE INDEX client_files_file ON client_files (file_id);`,

  // Мессенджер: личные и групповые чаты сотрудников (в том числе по проекту клиента)
  `CREATE TABLE chats (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     kind       TEXT NOT NULL DEFAULT 'group',
     title      TEXT,
     client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,
     created_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE chat_members (
     chat_id   INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     user_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
     last_read INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (chat_id, user_id)
   );
   CREATE INDEX chat_members_user ON chat_members (user_id);
   CREATE TABLE chat_messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     author_id  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
     author     TEXT NOT NULL,
     body       TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     edited_at  TEXT,
     deleted    INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX chat_messages_chat ON chat_messages (chat_id, id);
   CREATE TABLE chat_files (
     message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
     file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     PRIMARY KEY (message_id, file_id)
   );
   CREATE INDEX chat_files_file ON chat_files (file_id);`,

  // Регулярные встречи: правило повтора и шаблон; сами встречи — обычные записи со ссылкой на серию
  `CREATE TABLE meeting_series (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     rule          TEXT NOT NULL,
     days          TEXT,
     start_date    TEXT NOT NULL,
     time          TEXT NOT NULL,
     until         TEXT,
     count         INTEGER,
     template      TEXT NOT NULL,
     generated_to  TEXT NOT NULL,
     created_by_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
     created_at    TEXT NOT NULL DEFAULT (datetime('now'))
   );
   ALTER TABLE meetings ADD COLUMN series_id INTEGER REFERENCES meeting_series(id) ON DELETE SET NULL;
   CREATE INDEX meetings_series ON meetings (series_id, starts_at);`,

  // Сводка ИИ по заявке: кто клиент, потенциал, комментарий менеджеру (JSON)
  `ALTER TABLE leads ADD COLUMN ai_summary TEXT;`,
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
    setSummary: db.prepare('UPDATE leads SET ai_summary = ? WHERE id = ?'),
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
      ai_summary: row.ai_summary ? JSON.parse(row.ai_summary) : null,
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
    /** Сводка ИИ по заявке (или null — убрать). */
    setLeadSummary: (id, summary) => q.setSummary.run(summary ? JSON.stringify(summary) : null, id),
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
