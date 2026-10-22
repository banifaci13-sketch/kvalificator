// Уведомления на почту (SMTP): карточка каждого нового лида и письмо о брошенном диалоге —
// посетитель начал разговор с квалификатором и ушёл, не оставив контакт.
// Почтовый ящик и пароль — только в .env на сервере (SMTP_*), получатели — NOTIFY_EMAIL.

import nodemailer from 'nodemailer';
import { formatLeadCard } from './telegram.js';
import { ratingLetter } from '../core/scoring.js';

const CHANNELS = { web: 'виджет на сайте', telegram: 'Telegram', max: 'MAX' };
const MSK = { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' };
// телефоны и почта в письме о брошенном диалоге не показываем: согласия на обработку не было
const PHONE_RE = /(?:\+?\d[\s()‐–-]*){10,15}/g;
const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[a-zа-я]{2,}/gi;

const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const when = (sqlTime) => new Date(`${String(sqlTime).replace(' ', 'T')}Z`).toLocaleString('ru-RU', MSK);
// HTML карточки (как в Telegram: <b>, <i>, переносы строк) → письмо и простой текст
const toHtml = (body) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1b2430">${body.replace(/\n/g, '<br>')}</div>`;
const toText = (body) => body.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

export function createEmailNotifier({ smtp, to, publicUrl = null, transport = null }) {
  const mailer = transport ?? nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  const from = smtp.from || smtp.user;
  const link = (hash, label) => (publicUrl ? `\n\n<a href="${esc(`${publicUrl}/admin/#/${hash}`)}">${esc(label)}</a>` : '');
  const send = ({ subject, body }) => mailer.sendMail({ from, to: to.join(', '), subject, html: toHtml(body), text: toText(body) });

  return {
    /** Карточка нового лида: то же, что в Telegram, плюс диалог целиком. */
    async notifyLead(lead, scenario) {
      const company = lead.answers?.company?.raw ?? lead.answers?.company;
      const dialog = lead.meta?.dialog?.length
        ? `\n\n<b>Диалог с клиентом</b>\n${lead.meta.dialog.map((m) => `${m.from === 'user' ? '<b>Клиент:</b>' : 'Бот:'} ${esc(m.text)}`).join('\n')}`
        : '';
      await send({
        subject: `Новый лид #${lead.id} — уровень ${ratingLetter(lead.rating)}${company ? ` — ${String(company).slice(0, 80)}` : ''}`,
        body: formatLeadCard(lead, scenario).replace(/\n<i>Диалог с клиентом — [^\n]*<\/i>/, '') + dialog + link(`leads?lead=${lead.id}`, 'Открыть заявку в кабинете'),
      });
    },

    /** Брошенный диалог: что успели понять, где остановились и сама переписка (без телефонов и почты). */
    async notifyAbandoned(d, scenario) {
      const label = (stepId, v) => scenario.steps.find((s) => s.id === stepId)?.options?.find((o) => o.value === v)?.label ?? v;
      const f = d.found ?? {};
      const services = (f.services ?? []).map((v) => label('service', v)).join(', ');
      const clean = (t) => String(t ?? '').replace(EMAIL_RE, '[почта скрыта]').replace(PHONE_RE, '[телефон скрыт]');
      const rows = [
        `<b>Брошенный диалог</b> — ${esc(CHANNELS[d.channel] ?? d.channel)}, начат ${esc(when(d.startedAt))}, последнее сообщение ${esc(when(d.lastAt))}`,
        'Посетитель начал разговор, но не оставил контакт.',
        '',
        f.company ? `<b>Компания / сайт:</b> ${esc(clean(f.company))}` : null,
        services ? `<b>Услуги:</b> ${esc(services)}` : null,
        f.budget ? `<b>Бюджет:</b> ${esc(label('budget', f.budget))}` : null,
        f.start ? `<b>Старт:</b> ${esc(label('start', f.start))}` : null,
        f.summary ? `<b>Суть задачи:</b> ${esc(clean(f.summary))}` : null,
        d.page ? `<b>Страница:</b> ${esc(d.page)}` : null,
        d.utm && Object.keys(d.utm).length ? `<b>UTM:</b> ${esc(Object.entries(d.utm).map(([k, v]) => `${k}=${v}`).join(', '))}` : null,
        '',
        '<b>Переписка</b>',
        ...(d.dialog ?? []).map((m) => `${m.from === 'user' ? '<b>Посетитель:</b>' : 'Бот:'} ${esc(clean(m.text))}`),
      ].filter((l) => l !== null);
      await send({
        subject: `Брошенный диалог${services ? ` — ${services}` : ''}${f.company ? ` — ${String(clean(f.company)).slice(0, 60)}` : ''}`,
        body: rows.join('\n') + link('abandoned', 'Все брошенные диалоги в кабинете'),
      });
    },
  };
}
