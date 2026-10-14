// Напоминания о встречах и утренняя сводка — в личный Telegram сотрудника.
// Раз в минуту: кому из участников пора напомнить (за сутки, за час…). В 9:00 по Москве —
// встречи на сегодня и задачи со сроком на сегодня или просроченные.

import { fromDbTime, fmtMoscow, FORMATS, PROVIDERS, TZ } from './store.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const DIGEST_HOUR = 9;

export function telegramSender({ token, apiBase = 'https://api.telegram.org', fetchImpl = fetch }) {
  return async (chatId, html) => {
    const res = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Telegram: ${(await res.json().catch(() => ({}))).description ?? res.status}`);
  };
}

const time = (d) => fmtMoscow(d, { hour: '2-digit', minute: '2-digit' });
function leftText(min) {
  if (min >= 60 * 20) return 'Завтра';
  if (min >= 90) return `Через ${Math.round(min / 60)} ч`;
  if (min >= 55) return 'Через час';
  return `Через ${Math.max(1, min)} мин`;
}

export function reminderText({ meeting: m, left }, publicUrl) {
  const start = fromDbTime(m.starts_at);
  const end = new Date(start.getTime() + m.duration * 60_000);
  const where = m.format === 'online'
    ? m.link ? `<a href="${esc(m.link)}">Подключиться${m.provider ? ` (${esc(PROVIDERS[m.provider])})` : ''}</a>` : 'Онлайн, ссылки пока нет'
    : `${FORMATS[m.format]}${m.place ? `: ${esc(m.place)}` : ''}`;
  return [
    `⏰ <b>${leftText(left)}: ${esc(m.title)}</b>`,
    `${fmtMoscow(start, { weekday: 'short', day: 'numeric', month: 'long' })}, ${time(start)}–${time(end)} (МСК)`,
    m.client_name ? `Клиент: ${esc(m.client_name)}` : null,
    where,
    m.participants?.length > 1 ? `Участники: ${esc(m.participants.map((p) => p.name).join(', '))}` : null,
    publicUrl ? `<a href="${publicUrl}/admin/#/calendar?meeting=${m.id}">Открыть в календаре</a>` : null,
  ].filter(Boolean).join('\n');
}

export function startReminders({ calendar, crm = null, send, log, publicUrl = null, intervalMs = 60_000, now = () => new Date(), track = null }) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const r of calendar.dueReminders(now())) {
        try {
          await send(r.user.chatId, reminderText(r, publicUrl));
          calendar.markSent(r);
        } catch (err) {
          // не дошло — повторим через минуту; если сотрудник заблокировал бота, пометим и не будем спамить ошибками
          log.warn({ err: err.message, meeting: r.meeting.id, user: r.user.id }, 'Напоминание о встрече не отправлено');
          if (/blocked|chat not found|deactivated/i.test(err.message)) calendar.markSent(r);
        }
      }
      await digest();
    } catch (err) {
      log.error({ err }, 'Ошибка напоминаний');
    } finally {
      running = false;
    }
  }

  async function digest() {
    const t = now();
    const hour = Number(fmtMoscow(t, { hour: '2-digit', hour12: false }));
    if (hour < DIGEST_HOUR || hour > DIGEST_HOUR + 2) return;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(t);
    const dayStart = new Date(`${day}T00:00:00+03:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    for (const u of calendar.linkedUsers()) {
      if (calendar.digestSent(u.id, day)) continue;
      const meetings = calendar.meetingsForUser(u.id, dayStart, dayEnd).filter((m) => !m.cancelled);
      const tasks = crm ? crm.listTasks({ mine: u.id }).filter((x) => x.status !== 'done' && x.due && x.due <= day) : [];
      calendar.markDigest(u.id, day);
      if (!meetings.length && !tasks.length) continue;
      const lines = [`☀️ <b>${esc(u.name)}, план на сегодня</b>`];
      if (meetings.length) {
        lines.push('', '<b>Встречи</b>');
        for (const m of meetings) lines.push(`${time(fromDbTime(m.starts_at))} — ${esc(m.title)}${m.client_name ? ` (${esc(m.client_name)})` : ''}`);
      }
      if (tasks.length) {
        lines.push('', '<b>Задачи со сроком</b>');
        for (const x of tasks.slice(0, 15)) lines.push(`${x.due < day ? '🔴 просрочено' : x.due_time ? `• сегодня до ${x.due_time}` : '• сегодня'}: ${esc(x.title)}${x.client_name ? ` (${esc(x.client_name)})` : ''}`);
        if (tasks.length > 15) lines.push(`…и ещё ${tasks.length - 15}`);
      }
      try {
        await send(u.telegram_chat_id, lines.join('\n'));
      } catch (err) {
        log.warn({ err: err.message, user: u.id }, 'Утренняя сводка не отправлена');
      }
    }
  }

  // track — отметка в мониторе («Состояние системы»): когда работало и чем закончилось
  const timer = setInterval(() => (track ? track(tick) : tick()), intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
