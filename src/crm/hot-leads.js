// Горячая заявка (уровень A–B, рейтинг 4–5) — сразу задача «Связаться» с важностью «Критичная».
// Срок — 15 минут в рабочее время (будни 9:00–20:00 по Москве); ночью и в выходные — 9:15
// ближайшего рабочего дня. Исполнитель — менеджер с наименьшим числом открытых задач.

import { ratingLetter } from '../core/scoring.js';

const MSK = 3 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');

/** Срок ответа по Москве: { due: 'ГГГГ-ММ-ДД', dueTime: 'ЧЧ:ММ' }. */
export function replyDeadline(now = new Date(), minutes = 15) {
  const m = new Date(now.getTime() + MSK);
  const working = (d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  const minute = m.getUTCHours() * 60 + m.getUTCMinutes();
  if (working(m) && minute >= 9 * 60 && minute + minutes <= 20 * 60) {
    const t = new Date(m.getTime() + minutes * 60e3);
    return { due: t.toISOString().slice(0, 10), dueTime: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` };
  }
  // следующее рабочее утро (сегодня, если ещё не наступило 9:00 буднего дня)
  const d = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate(), 12));
  if (!(working(m) && minute < 9 * 60)) d.setUTCDate(d.getUTCDate() + 1);
  while (!working(d)) d.setUTCDate(d.getUTCDate() + 1);
  return { due: d.toISOString().slice(0, 10), dueTime: `09:${pad(minutes)}` };
}

export function createHotLeads({ db, crm, minRating = 4 }) {
  const q = {
    // менеджеры (если их нет — администраторы), у кого меньше всего открытых задач
    pick: db.prepare(
      `SELECT u.id, u.name FROM admin_users u
       LEFT JOIN tasks t ON t.assignee_id = u.id AND t.status != 'done'
       WHERE u.disabled = 0 AND u.role = ?
       GROUP BY u.id ORDER BY COUNT(t.id), u.id LIMIT 1`,
    ),
  };
  const company = (lead) => lead.answers?.company?.raw ?? lead.answers?.company ?? null;
  const contact = (lead) => [lead.answers?.name?.raw ?? lead.answers?.name, lead.answers?.contact?.raw ?? lead.answers?.contact].filter((x) => typeof x === 'string' && x.trim()).join(', ');

  /** Вызывается на каждую новую заявку; возвращает созданную задачу или null. */
  function onLead(lead, now = new Date()) {
    if (!lead || lead.rating < minRating || lead.is_test || lead.meta?.test) return null;
    const assignee = q.pick.get('manager') ?? q.pick.get('admin');
    const { due, dueTime } = replyDeadline(now);
    const name = company(lead);
    const who = contact(lead);
    return crm.createTask(
      {
        title: `Связаться: горячая заявка №${lead.id}${name ? ` — ${name}` : ''}`,
        description: [
          `Уровень заявки ${ratingLetter(lead.rating)} — связаться в течение 15 минут (в рабочее время).`,
          who ? `Контакт: ${who}.` : null,
          lead.answers?.proposal_request ? `${lead.answers.proposal_request}.` : null,
          `Карточка заявки: #/leads?lead=${lead.id}`,
        ].filter(Boolean).join('\n'),
        assigneeId: assignee?.id ?? null,
        due,
        dueTime,
        priority: 4,
      },
      { id: null, name: 'Квалификатор', role: 'system' },
    );
  }
  return { onLead };
}
