// Календарь встреч: встречи, участники-сотрудники, напоминания, подписка в формате iCalendar.
// Время хранится в UTC ('YYYY-MM-DD HH:MM:SS'), показывается по Москве.

import { randomBytes } from 'node:crypto';

export class CalendarError extends Error {}

export const FORMATS = { online: 'Онлайн', office: 'В офисе', call: 'Звонок' };
export const PROVIDERS = { zoom: 'Zoom', telemost: 'Телемост', other: 'Своя ссылка' };
// Варианты напоминаний, минут до начала
export const REMIND_OPTIONS = [
  [1440, 'за сутки'],
  [120, 'за 2 часа'],
  [60, 'за час'],
  [30, 'за 30 минут'],
  [15, 'за 15 минут'],
  [5, 'за 5 минут'],
];
const REMIND_VALUES = REMIND_OPTIONS.map(([m]) => m);
export const TZ = 'Europe/Moscow';

/** ISO-строка или Date → 'YYYY-MM-DD HH:MM:SS' в UTC. */
export function toDbTime(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new CalendarError('Неверная дата или время');
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
export const fromDbTime = (s) => new Date(`${s.replace(' ', 'T')}Z`);

export function fmtMoscow(date, opts = {}) {
  return date.toLocaleString('ru-RU', { timeZone: TZ, ...opts });
}
export const fmtWhen = (d) => `${fmtMoscow(d, { weekday: 'short', day: 'numeric', month: 'long' })}, ${fmtMoscow(d, { hour: '2-digit', minute: '2-digit' })}`;

const text = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

export function createCalendar({ db }) {
  const q = {
    meeting: db.prepare(
      `SELECT m.*, c.name AS client_name FROM meetings m LEFT JOIN clients c ON c.id = m.client_id WHERE m.id = ?`,
    ),
    range: db.prepare(
      `SELECT m.*, c.name AS client_name FROM meetings m LEFT JOIN clients c ON c.id = m.client_id
       WHERE m.starts_at < ? AND datetime(m.starts_at, '+' || m.duration || ' minutes') > ? ORDER BY m.starts_at`,
    ),
    participants: db.prepare(
      `SELECT u.id, u.name FROM meeting_participants p JOIN admin_users u ON u.id = p.user_id WHERE p.meeting_id = ? ORDER BY u.name`,
    ),
    insert: db.prepare(
      `INSERT INTO meetings (title, starts_at, duration, format, provider, link, host_link, external_id, place, client_id, lead_id, guests, agenda, remind, created_by, created_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    update: db.prepare(
      `UPDATE meetings SET title = ?, starts_at = ?, duration = ?, format = ?, provider = ?, link = ?, host_link = ?, external_id = ?, place = ?,
         client_id = ?, lead_id = ?, guests = ?, agenda = ?, remind = ?, cancelled = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    remove: db.prepare('DELETE FROM meetings WHERE id = ?'),
    clearParticipants: db.prepare('DELETE FROM meeting_participants WHERE meeting_id = ?'),
    addParticipant: db.prepare('INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)'),
    clearSent: db.prepare('DELETE FROM meeting_reminders_sent WHERE meeting_id = ?'),
    user: db.prepare('SELECT id FROM admin_users WHERE id = ? AND disabled = 0'),
    client: db.prepare('SELECT id FROM clients WHERE id = ?'),
    // напоминания: встречи, которые начнутся в ближайшие сутки, и участники с Telegram
    upcoming: db.prepare(
      `SELECT m.*, c.name AS client_name, u.id AS user_id, u.name AS user_name, u.telegram_chat_id
       FROM meetings m JOIN meeting_participants p ON p.meeting_id = m.id JOIN admin_users u ON u.id = p.user_id
       LEFT JOIN clients c ON c.id = m.client_id
       WHERE m.cancelled = 0 AND u.disabled = 0 AND u.telegram_chat_id IS NOT NULL AND m.starts_at > ? AND m.starts_at <= ?`,
    ),
    sent: db.prepare('SELECT 1 FROM meeting_reminders_sent WHERE meeting_id = ? AND user_id = ? AND offset_min = ?'),
    markSent: db.prepare('INSERT OR IGNORE INTO meeting_reminders_sent (meeting_id, user_id, offset_min) VALUES (?, ?, ?)'),
    forUser: db.prepare(
      `SELECT m.*, c.name AS client_name FROM meetings m JOIN meeting_participants p ON p.meeting_id = m.id
       LEFT JOIN clients c ON c.id = m.client_id
       WHERE p.user_id = ? AND m.starts_at >= ? AND m.starts_at < ? ORDER BY m.starts_at`,
    ),
    linkedUsers: db.prepare('SELECT id, name, telegram_chat_id FROM admin_users WHERE disabled = 0 AND telegram_chat_id IS NOT NULL'),
    digestSent: db.prepare('SELECT 1 FROM digests_sent WHERE user_id = ? AND day = ?'),
    markDigest: db.prepare('INSERT OR IGNORE INTO digests_sent (user_id, day) VALUES (?, ?)'),
    // Telegram и подписка
    setLinkCode: db.prepare('UPDATE admin_users SET telegram_link_code = ? WHERE id = ?'),
    byLinkCode: db.prepare('SELECT id, name FROM admin_users WHERE telegram_link_code = ? AND disabled = 0'),
    linkChat: db.prepare('UPDATE admin_users SET telegram_chat_id = ?, telegram_link_code = NULL WHERE id = ?'),
    unlinkChat: db.prepare('UPDATE admin_users SET telegram_chat_id = NULL, telegram_link_code = NULL WHERE id = ?'),
    staff: db.prepare('SELECT id, name, telegram_chat_id, calendar_token FROM admin_users WHERE id = ?'),
    setCalToken: db.prepare('UPDATE admin_users SET calendar_token = ? WHERE id = ?'),
    byCalToken: db.prepare('SELECT id, name FROM admin_users WHERE calendar_token = ? AND disabled = 0'),
  };

  const withPeople = (m) => m && { ...m, remind: JSON.parse(m.remind), participants: q.participants.all(m.id) };

  function get(id) {
    const m = withPeople(q.meeting.get(Number(id)));
    if (!m) throw new CalendarError('Встреча не найдена');
    return m;
  }

  function check(v) {
    const title = text(v.title, 200);
    if (!title) throw new CalendarError('Укажите тему встречи');
    const startsAt = toDbTime(v.startsAt);
    const duration = Number(v.duration ?? 60);
    if (!Number.isInteger(duration) || duration < 5 || duration > 720) throw new CalendarError('Длительность — от 5 минут до 12 часов');
    if (!(v.format in FORMATS)) throw new CalendarError('Неизвестный формат встречи');
    if (v.provider != null && !(v.provider in PROVIDERS)) throw new CalendarError('Неизвестный сервис видеосвязи');
    const link = text(v.link, 1000);
    if (link && !/^https:\/\//i.test(link)) throw new CalendarError('Ссылка на встречу должна начинаться с https://');
    if (v.clientId != null && !q.client.get(Number(v.clientId))) throw new CalendarError('Клиент не найден');
    const remind = [...new Set((v.remind ?? [1440, 15]).map(Number))].filter((m) => REMIND_VALUES.includes(m)).sort((a, b) => b - a);
    const participants = [...new Set((v.participants ?? []).map(Number))];
    for (const id of participants) if (!q.user.get(id)) throw new CalendarError('Участник не найден или отключён');
    return {
      title, startsAt, duration, format: v.format, provider: v.format === 'online' ? (v.provider ?? null) : null,
      link: v.format === 'online' ? link : null,
      hostLink: v.format === 'online' ? text(v.hostLink, 2000) : null,
      externalId: v.format === 'online' ? text(v.externalId, 200) : null,
      place: text(v.place, 300),
      clientId: v.clientId == null ? null : Number(v.clientId),
      leadId: v.leadId ?? null,
      guests: text(v.guests, 1000),
      agenda: text(v.agenda, 5000),
      remind, participants,
    };
  }

  function saveParticipants(id, list) {
    q.clearParticipants.run(id);
    for (const u of list) q.addParticipant.run(id, u);
  }

  function create(v, user) {
    const m = check({ format: 'online', ...v, participants: v.participants?.length ? v.participants : [user.id] });
    db.exec('BEGIN');
    try {
      const { lastInsertRowid } = q.insert.run(
        m.title, m.startsAt, m.duration, m.format, m.provider, m.link, m.hostLink, m.externalId, m.place, m.clientId, m.leadId, m.guests, m.agenda,
        JSON.stringify(m.remind), user.name, user.id,
      );
      saveParticipants(lastInsertRowid, m.participants);
      db.exec('COMMIT');
      return get(lastInsertRowid);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function update(id, patch) {
    const cur = get(id);
    const pick = (k, dbk = k) => (patch[k] !== undefined ? patch[k] : cur[dbk]);
    const m = check({
      title: pick('title'),
      startsAt: patch.startsAt ?? fromDbTime(cur.starts_at),
      duration: pick('duration'),
      format: pick('format'),
      provider: pick('provider'),
      link: pick('link'),
      hostLink: pick('hostLink', 'host_link'),
      externalId: pick('externalId', 'external_id'),
      place: pick('place'),
      clientId: pick('clientId', 'client_id'),
      leadId: pick('leadId', 'lead_id'),
      guests: pick('guests'),
      agenda: pick('agenda'),
      remind: pick('remind'),
      participants: patch.participants ?? cur.participants.map((p) => p.id),
    });
    const cancelled = patch.cancelled !== undefined ? Number(Boolean(patch.cancelled)) : cur.cancelled;
    db.exec('BEGIN');
    try {
      q.update.run(
        m.title, m.startsAt, m.duration, m.format, m.provider, m.link, m.hostLink, m.externalId, m.place, m.clientId, m.leadId, m.guests, m.agenda,
        JSON.stringify(m.remind), cancelled, cur.id,
      );
      saveParticipants(cur.id, m.participants);
      // перенесли встречу — напоминания должны прийти заново, к новому времени
      if (m.startsAt !== cur.starts_at || JSON.stringify(m.remind) !== JSON.stringify(cur.remind)) q.clearSent.run(cur.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return get(id);
  }

  /** Встречи, пересекающиеся с [from, to). mine — только где сотрудник участник. */
  function list({ from, to, userId = null, clientId = null }) {
    let rows = q.range.all(toDbTime(to), toDbTime(from)).map(withPeople);
    if (userId) rows = rows.filter((m) => m.participants.some((p) => p.id === Number(userId)));
    if (clientId) rows = rows.filter((m) => m.client_id === Number(clientId));
    return rows;
  }

  /** Напоминания, которые пора отправить: [{ meeting, user, offset }]. */
  function dueReminders(now = new Date()) {
    const horizon = new Date(now.getTime() + 24 * 60 * 60_000 + 60_000);
    const out = [];
    for (const row of q.upcoming.all(toDbTime(now), toDbTime(horizon))) {
      const start = fromDbTime(row.starts_at);
      const left = (start - now) / 60_000;
      // самое близкое из наступивших напоминаний; ранние, если их пропустили (сервер был выключен), не досылаем
      const offsets = JSON.parse(row.remind).filter((o) => left <= o);
      if (!offsets.length) continue;
      const offset = Math.min(...offsets);
      if (q.sent.get(row.id, row.user_id, offset)) continue;
      out.push({ meeting: { ...row, participants: q.participants.all(row.id) }, user: { id: row.user_id, name: row.user_name, chatId: row.telegram_chat_id }, offset, left: Math.round(left) });
    }
    return out;
  }

  function markSent({ meeting, user, offset }) {
    // помечаем и все более ранние напоминания этой встречи — чтобы не прислать «за сутки» после «за час»
    const all = Array.isArray(meeting.remind) ? meeting.remind : JSON.parse(meeting.remind ?? '[]');
    for (const o of [offset, ...all]) if (o >= offset) q.markSent.run(meeting.id, user.id, o);
  }

  return {
    get,
    create,
    update,
    remove: (id) => {
      get(id);
      q.remove.run(Number(id));
    },
    list,
    dueReminders,
    markSent,
    meetingsForUser: (userId, from, to) => q.forUser.all(userId, toDbTime(from), toDbTime(to)).map(withPeople),
    linkedUsers: () => q.linkedUsers.all(),
    digestSent: (userId, day) => Boolean(q.digestSent.get(userId, day)),
    markDigest: (userId, day) => q.markDigest.run(userId, day),

    // ---------- Telegram сотрудника ----------
    telegramLinkCode(userId) {
      const code = randomBytes(12).toString('base64url');
      q.setLinkCode.run(code, userId);
      return code;
    },
    linkTelegram(code, chatId) {
      const u = q.byLinkCode.get(String(code));
      if (!u) return null;
      q.linkChat.run(String(chatId), u.id);
      return u;
    },
    unlinkTelegram: (userId) => q.unlinkChat.run(userId),

    // ---------- подписка на календарь ----------
    staffInfo: (userId) => q.staff.get(userId),
    calendarToken(userId, { regenerate = false } = {}) {
      const cur = q.staff.get(userId)?.calendar_token;
      if (cur && !regenerate) return cur;
      const token = randomBytes(24).toString('base64url');
      q.setCalToken.run(token, userId);
      return token;
    },
    userByCalendarToken: (token) => q.byCalToken.get(String(token)),
  };
}

// ---------- iCalendar ----------

const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Сворачивание строк по 75 байт (RFC 5545), не разрывая символы UTF-8. */
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function meetingsIcs(meetings, { name = 'Встречи', host = 'soroka-assistant' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Soroka Marketing//Assistant//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(name)}`,
    `X-WR-TIMEZONE:${TZ}`,
  ];
  const stamp = icsTime(new Date());
  for (const m of meetings) {
    const start = fromDbTime(m.starts_at);
    const end = new Date(start.getTime() + m.duration * 60_000);
    const desc = [m.client_name ? `Клиент: ${m.client_name}` : null, m.link ? `Ссылка: ${m.link}` : null, m.agenda ? `\n${m.agenda}` : null].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:meeting-${m.id}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(start)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsText(m.title)}`,
      desc ? `DESCRIPTION:${icsText(desc)}` : null,
      m.link || m.place ? `LOCATION:${icsText(m.link ?? m.place)}` : null,
      m.link ? `URL:${m.link}` : null,
      `STATUS:${m.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
      `LAST-MODIFIED:${icsTime(fromDbTime(m.updated_at))}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(fold).join('\r\n') + '\r\n';
}
