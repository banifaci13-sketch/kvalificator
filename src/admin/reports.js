// Выборки для админки: список лидов с фильтрами, сводка, воронка опроса, выгрузка.
// Даты в базе — UTC; в интерфейсе и группировке по дням — московское время.

import { ratingLetter } from '../core/scoring.js';
// незавершённый опрос считаем брошенным после ABANDON_AFTER без ответа — так же, как в списке «Брошенные»
import { ABANDON_AFTER } from '../core/abandoned.js';

const MSK = '+3 hours';
const MSK_BACK = '-3 hours';
const PAGE_SIZE = 50;

export const LEAD_STATUSES = {
  new: 'Новый',
  in_work: 'В работе',
  proposal: 'КП отправлено',
  won: 'Сделка',
  lost: 'Отказ',
  spam: 'Спам',
};

export function createReports(db) {
  // SQLite сравнивает без учёта регистра только латиницу — для кириллицы своя функция
  db.function('ulower', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));

  function leadFilter(f = {}) {
    const where = ['is_test = ?'];
    const params = [f.test ? 1 : 0];
    if (f.rating?.length) {
      where.push(`rating IN (${f.rating.map(() => '?').join(',')})`);
      params.push(...f.rating);
    }
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => '?').join(',')})`);
      params.push(...f.status);
    }
    if (f.channel) {
      where.push('channel = ?');
      params.push(f.channel);
    }
    if (f.assignee) {
      where.push('assignee = ?');
      params.push(f.assignee);
    }
    if (f.from) {
      where.push(`created_at >= datetime(?, '${MSK_BACK}')`);
      params.push(f.from);
    }
    if (f.to) {
      where.push(`created_at < datetime(?, '+1 day', '${MSK_BACK}')`);
      params.push(f.to);
    }
    if (f.q) {
      const like = `%${f.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
      where.push(
        `(ulower(answers) LIKE ? ESCAPE '\\' OR ulower(comment) LIKE ? ESCAPE '\\' OR ulower(assignee) LIKE ? ESCAPE '\\' OR CAST(id AS TEXT) = ?)`,
      );
      params.push(like, like, like, f.q.replace(/^#/, ''));
    }
    return { sql: where.join(' AND '), params };
  }

  const parse = (row) => ({
    ...row,
    reasons: JSON.parse(row.reasons),
    tags: JSON.parse(row.tags),
    answers: JSON.parse(row.answers),
    meta: JSON.parse(row.meta),
    delivered: JSON.parse(row.delivered),
  });

  return {
    listLeads(f = {}) {
      const { sql, params } = leadFilter(f);
      const page = Math.max(1, Number(f.page) || 1);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${sql}`).get(...params).n;
      const rows = db
        .prepare(`SELECT * FROM leads WHERE ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
      return { total, page, pageSize: PAGE_SIZE, leads: rows.map(parse) };
    },

    /** Все лиды по фильтру — для выгрузки и канбана. */
    allLeads(f = {}, limit = 5000) {
      const { sql, params } = leadFilter(f);
      return db.prepare(`SELECT * FROM leads WHERE ${sql} ORDER BY id DESC LIMIT ?`).all(...params, limit).map(parse);
    },

    assignees() {
      return db
        .prepare('SELECT DISTINCT assignee FROM leads WHERE assignee IS NOT NULL ORDER BY assignee')
        .all()
        .map((r) => r.assignee);
    },

    stats(f = {}) {
      const { sql, params } = leadFilter({ ...f, rating: null, status: null });
      const rows = (query) => db.prepare(query).all(...params);

      const byDay = rows(
        `SELECT date(created_at, '${MSK}') AS day, channel, rating, COUNT(*) AS n
         FROM leads WHERE ${sql} GROUP BY day, channel, rating ORDER BY day`,
      );
      const byStatus = rows(`SELECT status, COUNT(*) AS n FROM leads WHERE ${sql} GROUP BY status`);

      // Воронка опроса: сколько начали, сколько дошли до конца, на каком вопросе ушли
      const sWhere = ["json_extract(meta, '$.test') IS NOT 1"];
      const sParams = [];
      if (f.test) sWhere[0] = "json_extract(meta, '$.test') = 1";
      if (f.channel) { sWhere.push('channel = ?'); sParams.push(f.channel); }
      if (f.from) { sWhere.push(`created_at >= datetime(?, '${MSK_BACK}')`); sParams.push(f.from); }
      if (f.to) { sWhere.push(`created_at < datetime(?, '+1 day', '${MSK_BACK}')`); sParams.push(f.to); }
      const sSql = sWhere.join(' AND ');
      const sessions = db
        .prepare(
          `SELECT
             COUNT(*) AS started,
             SUM(status = 'done') AS completed,
             SUM(status = 'abandoned' OR (status = 'active' AND updated_at < datetime('now', '${ABANDON_AFTER}'))) AS dropped
           FROM sessions WHERE ${sSql}`,
        )
        .get(...sParams);
      const dropOff = db
        .prepare(
          `SELECT json_extract(state, '$.stepId') AS step, COUNT(*) AS n FROM sessions
           WHERE ${sSql} AND (status = 'abandoned' OR (status = 'active' AND updated_at < datetime('now', '${ABANDON_AFTER}')))
           GROUP BY step ORDER BY n DESC`,
        )
        .all(...sParams);

      return {
        byDay,
        byStatus,
        funnel: {
          started: sessions.started ?? 0,
          completed: sessions.completed ?? 0,
          dropped: sessions.dropped ?? 0,
          dropOff,
        },
      };
    },
  };
}

/** CSV для Excel: разделитель «;», BOM — чтобы кириллица открывалась без настроек. */
export function leadsToCsv(leads, scenario) {
  const steps = scenario.steps.filter((s) => s.type !== 'consent');
  const header = [
    '№', 'Дата (МСК)', 'Уровень', 'Статус', 'Ответственный', 'Канал',
    ...steps.map((s) => s.label ?? s.id),
    'Теги', 'Почему такой уровень', 'Страница', 'UTM', 'Комментарий',
  ];
  const label = (step, value) => {
    if (value == null) return '';
    if (typeof value === 'object') return value.raw ?? JSON.stringify(value);
    return step.options?.find((o) => o.value === value)?.label ?? String(value);
  };
  const rows = leads.map((l) => [
    l.id,
    toMoscow(l.created_at),
    ratingLetter(l.rating),
    LEAD_STATUSES[l.status] ?? l.status,
    l.assignee ?? '',
    l.channel,
    ...steps.map((s) => label(s, l.answers[s.id])),
    l.tags.join(', '),
    l.reasons.join('; '),
    l.meta.page ?? '',
    Object.entries(l.meta.utm ?? {}).map(([k, v]) => `${k}=${v}`).join(', '),
    l.comment ?? '',
  ]);
  // Защита от формул: Excel выполняет ячейки, начинающиеся с = + - @
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

function toMoscow(utc) {
  const d = new Date(`${utc.replace(' ', 'T')}Z`);
  d.setUTCHours(d.getUTCHours() + 3);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
