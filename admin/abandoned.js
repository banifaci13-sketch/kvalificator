// «Квалификатор» → «Брошенные» (только администратор): диалоги, в которых посетитель не оставил
// контакт. Помогает понять, что спрашивают и на каком вопросе уходят. Хранятся N дней, потом
// переписка стирается автоматически (на сервере, ежечасно).

import { h, api, app, shell, navigate, ctx, fmtDateTime, plural, answerText } from './admin.js';
import { fill } from './docs.js';

const CHANNELS = { web: 'Сайт', telegram: 'Telegram', max: 'MAX' };
const STEP = {
  name: 'на имени', task: 'на описании задачи', criteria: 'на выборе исполнителя', consent: 'на согласии', contact: 'на контакте',
  clarify: 'на уточняющих вопросах', clarify_company: 'на вопросе о компании', clarify_services: 'на вопросе об услугах', clarify_budget: 'на вопросе о бюджете',
  clarify_start: 'на вопросе о сроках', clarify_agency_experience: 'на вопросе о прошлых подрядчиках', clarify_dissatisfaction: 'на вопросе, почему меняют подрядчика', clarify_site: 'на вопросе о сайте',
};

export async function renderAbandoned() {
  if (ctx.me.role !== 'admin') return navigate('leads');
  const box = h('div', { class: 'abandoned' }, h('p', { class: 'muted' }, 'Загружаю…'));
  const lead = h('p', { class: 'lead-text' });
  fill(app, shell('abandoned', [h('div', { class: 'page-head' }, h('h1', {}, 'Брошенные диалоги')), lead, box]));
  let data;
  try {
    data = await api('/admin/api/abandoned');
  } catch (err) {
    if (err.status !== 401) fill(box, h('p', { class: 'error' }, err.message));
    return;
  }
  lead.textContent = `Разговоры с квалификатором, в которых человек не оставил контакт. Видит только администратор; через ${data.days} ${plural(data.days, 'день', 'дня', 'дней')} переписка стирается автоматически — остаётся только шаг, на котором ушли (для сводки).`;
  if (!data.dialogs.length) return fill(box, h('p', { class: 'muted' }, 'Брошенных диалогов нет.'));
  fill(
    box,
    data.dialogs.map((d) => {
      const f = d.found;
      const facts = [
        f.name ? ['Имя', f.name] : null,
        f.company ? ['Компания', f.company] : null,
        f.services?.length ? ['Услуги', f.services.map((v) => answerText('service', v)).join(', ')] : null,
        f.budget ? ['Бюджет', answerText('budget', f.budget)] : null,
        f.start ? ['Старт', answerText('start', f.start)] : null,
        f.summary ? ['Суть', f.summary] : null,
      ].filter(Boolean);
      return h(
        'article',
        { class: 'panel ab-item' },
        h(
          'div',
          { class: 'ab-head' },
          h('strong', {}, fmtDateTime(d.lastAt)),
          h('span', { class: 'muted' }, `${CHANNELS[d.channel] ?? d.channel} · ушёл ${STEP[d.step] ?? 'на одном из вопросов'} · ${d.dialog.filter((m) => m.from === 'user').length} ${plural(d.dialog.filter((m) => m.from === 'user').length, 'ответ', 'ответа', 'ответов')}`),
          d.test ? h('span', { class: 'tag' }, 'тест') : null,
        ),
        facts.length ? h('dl', { class: 'answers' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null,
        d.page ? h('p', { class: 'muted ab-page' }, d.page) : null,
        h('details', {}, h('summary', {}, 'Переписка'), h('div', { class: 'lead-dialog' }, d.dialog.map((m) => h('p', { class: `ld-${m.from === 'user' ? 'user' : 'bot'}` }, m.text)))),
      );
    }),
  );
}
