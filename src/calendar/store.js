// Календарь встреч: встречи, участники-сотрудники, напоминания, подписка в формате iCalendar.
// Время хранится в UTC ('YYYY-MM-DD HH:MM:SS'), показывается по Москве.

import { randomBytes } from 'node:crypto';
import { HORIZON_DAYS, REPEATS, addDays, normalizeRepeat, repeatLabel, seriesDates } from './series.js';

export { REPEATS };

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
/** Московские дата 'YYYY-MM-DD' и время 'HH:MM' для времени из базы (Москва — UTC+3 без перехода). */
const mskIso = (dbTime) => new Date(fromDbTime(dbTime).getTime() + 3 * 3600_000).toISOString();
export const mskDate = (dbTime) => mskIso(dbTime).slice(0, 10);
export const mskTime = (dbTime) => mskIso(dbTime).slice(11, 16);
const atMsk = (date, time) => toDbTime(`${date}T${time}:00+03:00`);
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

  const sq = {
    insert: db.prepare(
      'INSERT INTO meeting_series (rule, days, start_date, time, until, count, template, generated_to, created_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    get: db.prepare('SELECT * FROM meeting_series WHERE id = ?'),
    // серии, которые пора продлить: созданы не на весь горизонт и ещё не закончились
    open: db.prepare('SELECT * FROM meeting_series WHERE generated_to < ? AND (until IS NULL OR until > generated_to)'),
    setGenerated: db.prepare('UPDATE meeting_series SET generated_to = ? WHERE id = ?'),
    setTemplate: db.prepare('UPDATE meeting_series SET template = ?, time = ? WHERE id = ?'),
    setUntil: db.prepare('UPDATE meeting_series SET until = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM meeting_series WHERE id = ?'),
    link: db.prepare('UPDATE meetings SET series_id = ? WHERE id = ?'),
    // следующие встречи серии (саму встречу, от которой считаем, исключаем: её время могли уже поменять)
    after: db.prepare('SELECT * FROM meetings WHERE series_id = ? AND starts_at > ? AND id != ? ORDER BY starts_at'),
    // будущие встречи серии без итогов — их можно убрать при смене правила или отмене серии
    dropAfter: db.prepare('DELETE FROM meetings WHERE series_id = ? AND starts_at > ? AND id != ? AND summary IS NULL'),
    before: db.prepare('SELECT count(*) AS n FROM meetings WHERE series_id = ? AND starts_at < ?'),
    left: db.prepare('SELECT count(*) AS n FROM meetings WHERE series_id = ?'),
    move: db.prepare("UPDATE meetings SET starts_at = ?, updated_at = datetime('now') WHERE id = ?"),
  };

  const seriesView = (id) => {
    const s = id && sq.get.get(id);
    if (!s) return null;
    const v = { id: s.id, rule: s.rule, days: s.days ? JSON.parse(s.days) : null, start: s.start_date, time: s.time, until: s.until, count: s.count };
    return { ...v, label: repeatLabel(v, s.time) };
  };
  const withPeople = (m) => m && { ...m, remind: JSON.parse(m.remind), participants: q.participants.all(m.id), series: seriesView(m.series_id) };

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

  function insertMeeting(m, startsAt, author, seriesId = null) {
    const { lastInsertRowid } = q.insert.run(
      m.title, startsAt, m.duration, m.format, m.provider, m.link, m.hostLink, m.externalId, m.place, m.clientId, m.leadId, m.guests, m.agenda,
      JSON.stringify(m.remind), author.name, author.id,
    );
    saveParticipants(lastInsertRowid, m.participants);
    if (seriesId) sq.link.run(seriesId, lastInsertRowid);
    return Number(lastInsertRowid);
  }

  // ---------- регулярные встречи ----------

  const todayMsk = () => mskDate(toDbTime(new Date()));
  const template = (m, author) => {
    const { startsAt: _, ...rest } = m;
    return { ...rest, author: { name: author.name, id: author.id } };
  };

  /** Новая серия. createdThrough — по какую дату встречи уже есть (первая встреча может быть уже создана). */
  function createSeries(m, repeat, author, createdThrough) {
    const { lastInsertRowid } = sq.insert.run(
      repeat.rule, repeat.days ? JSON.stringify(repeat.days) : null, mskDate(m.startsAt), mskTime(m.startsAt), repeat.until, repeat.count,
      JSON.stringify(template(m, author)), createdThrough, author.id ?? null,
    );
    return Number(lastInsertRowid);
  }

  /** Создать встречи серии после generated_to и до горизонта; возвращает id первой созданной. */
  function generate(seriesId, horizon = addDays(todayMsk(), HORIZON_DAYS)) {
    const s = sq.get.get(seriesId);
    const t = JSON.parse(s.template);
    const rule = { rule: s.rule, days: s.days ? JSON.parse(s.days) : null, start: s.start_date, until: s.until, count: s.count };
    let first = null;
    for (const { date } of seriesDates(rule, { after: s.generated_to, to: horizon })) {
      const id = insertMeeting(t, atMsk(date, s.time), t.author, s.id);
      first ??= id;
    }
    if (horizon > s.generated_to) sq.setGenerated.run(horizon, s.id);
    return first;
  }

  /** Серия заканчивается датой date: дальше встреч не будет; пустая серия удаляется. */
  function endSeries(seriesId, date) {
    const s = sq.get.get(seriesId);
    if (!s) return;
    if (!s.until || s.until > date) sq.setUntil.run(date, s.id);
    if (!sq.left.get(s.id).n) sq.remove.run(s.id);
  }

  function repeatFor(v, startsAt) {
    if (!v) return null;
    const r = normalizeRepeat(v, mskDate(startsAt));
    if (r.error) throw new CalendarError(r.error);
    return r;
  }

  function create(v, user) {
    const m = check({ format: 'online', ...v, participants: v.participants?.length ? v.participants : [user.id] });
    const repeat = repeatFor(v.repeat, m.startsAt);
    db.exec('BEGIN');
    try {
      let id;
      if (!repeat) id = insertMeeting(m, m.startsAt, user);
      else {
        // первая встреча — по правилу, начиная с выбранной даты (по будням с субботы — это понедельник)
        const start = mskDate(m.startsAt);
        const sid = createSeries(m, repeat, user, addDays(start, -1));
        // серия может начинаться и позже горизонта — тогда создаём хотя бы первые два месяца
        const horizon = addDays(todayMsk(), HORIZON_DAYS);
        id = generate(sid, addDays(start, 62) > horizon ? addDays(start, 62) : horizon);
        if (!id) throw new CalendarError('По этому правилу не получается ни одной встречи — проверьте дни недели и дату окончания');
      }
      db.exec('COMMIT');
      return get(id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Изменить встречу. scope: 'one' — только эту, 'following' — эту и следующие встречи серии.
   * patch.repeat: правило повтора (разовая встреча становится регулярной, у серии — новое правило
   * с этой встречи) или null — больше не повторять.
   */
  function update(id, patch, { scope = 'one' } = {}) {
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
    const hasRepeat = patch.repeat !== undefined;
    const repeat = repeatFor(patch.repeat, m.startsAt);
    const following = Boolean(cur.series_id) && scope === 'following';
    if (cur.series_id && !following && hasRepeat) throw new CalendarError('Правило повтора меняется для этой и следующих встреч');
    const author = { name: cur.created_by, id: cur.created_by_id };

    const write = (row, next, startsAt, cancelledFlag) => {
      q.update.run(
        next.title, startsAt, next.duration, next.format, next.provider, next.link, next.hostLink, next.externalId, next.place, next.clientId, next.leadId,
        next.guests, next.agenda, JSON.stringify(next.remind), cancelledFlag, row.id,
      );
      saveParticipants(row.id, next.participants);
      // перенесли встречу — напоминания должны прийти заново, к новому времени
      if (startsAt !== row.starts_at || JSON.stringify(next.remind) !== JSON.stringify(typeof row.remind === 'string' ? JSON.parse(row.remind) : row.remind)) q.clearSent.run(row.id);
    };

    db.exec('BEGIN');
    try {
      write(cur, m, m.startsAt, cancelled);
      if (following) {
        const s = sq.get.get(cur.series_id);
        const curDate = mskDate(cur.starts_at);
        const newDate = mskDate(m.startsAt);
        const sameRule = !hasRepeat || (repeat && repeat.rule === s.rule && JSON.stringify(repeat.days) === (s.days ?? 'null') && repeat.until === s.until && repeat.count === s.count);
        if (patch.cancelled === true) {
          // отменить эту и следующие: будущих встреч больше нет, эта остаётся отменённой в истории
          sq.dropAfter.run(s.id, cur.starts_at, cur.id);
          endSeries(s.id, curDate);
        } else if (sameRule && newDate === curDate) {
          // то же правило и тот же день — изменения во всех следующих, время сдвигается на ту же разницу
          const shift = fromDbTime(m.startsAt) - fromDbTime(cur.starts_at);
          for (const row of sq.after.all(s.id, cur.starts_at, cur.id)) write(row, m, toDbTime(new Date(fromDbTime(row.starts_at).getTime() + shift)), row.cancelled);
          sq.setTemplate.run(JSON.stringify(template(m, author)), mskTime(m.startsAt), s.id);
        } else {
          // новое правило или другой день — с этой встречи начинается новая серия
          sq.dropAfter.run(s.id, cur.starts_at, cur.id);
          let next = repeat;
          if (!hasRepeat) {
            const dayShift = Math.round((new Date(`${newDate}T12:00:00Z`) - new Date(`${curDate}T12:00:00Z`)) / 864e5);
            const days = s.days ? JSON.parse(s.days).map((d) => ((((d - 1 + dayShift) % 7) + 7) % 7) + 1).sort() : null;
            next = { rule: s.rule, days, until: s.until, count: s.count ? Math.max(2, s.count - sq.before.get(s.id, cur.starts_at).n) : null };
          }
          if (!next) endSeries(s.id, newDate);
          else {
            sq.link.run(null, cur.id);
            endSeries(s.id, addDays(curDate, -1));
            const sid = createSeries(m, next, author, newDate);
            sq.link.run(sid, cur.id);
            generate(sid);
          }
        }
      } else if (!cur.series_id && repeat) {
        // разовая встреча становится регулярной — первой в серии
        const sid = createSeries(m, repeat, author, mskDate(m.startsAt));
        sq.link.run(sid, cur.id);
        generate(sid);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return get(id);
  }

  /** Удалить встречу; scope 'following' — эту и все следующие встречи серии. */
  function remove(id, { scope = 'one' } = {}) {
    const cur = get(id);
    db.exec('BEGIN');
    try {
      q.remove.run(cur.id);
      if (cur.series_id && scope === 'following') {
        sq.dropAfter.run(cur.series_id, cur.starts_at, cur.id);
        endSeries(cur.series_id, addDays(mskDate(cur.starts_at), -1));
      } else if (cur.series_id && !sq.left.get(cur.series_id).n) endSeries(cur.series_id, mskDate(cur.starts_at));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Продлить регулярные встречи на горизонт вперёд (фоновая задача). Возвращает, сколько встреч создано. */
  function extendSeries(now = new Date()) {
    const horizon = addDays(mskDate(toDbTime(now)), HORIZON_DAYS);
    let made = 0;
    for (const s of sq.open.all(horizon)) {
      db.exec('BEGIN');
      try {
        const before = sq.left.get(s.id).n;
        generate(s.id, horizon);
        made += sq.left.get(s.id).n - before;
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    return made;
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

  const setSummaryQ = db.prepare("UPDATE meetings SET summary = ?, summary_by = ?, summary_at = datetime('now') WHERE id = ?");
  /** Итоги встречи: резюме (кто и когда записал). */
  function setSummary(id, summary, user) {
    const m = get(id);
    setSummaryQ.run(String(summary ?? '').trim().slice(0, 10000) || null, user.name, m.id);
    return get(id);
  }

  return {
    get,
    setSummary,
    create,
    update,
    remove,
    extendSeries,
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
