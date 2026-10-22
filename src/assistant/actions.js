// Действия ассистента по разделам кабинета: клиенты, доски, задачи, встречи, медиапланы, документы,
// заявки, регламенты, уведомления, оформление. Каждое — обычная функция над теми же хранилищами,
// что и интерфейс: те же проверки и права, никаких обходных путей. Фразы разбирает phrases.js.

import { bestMatch } from './commands.js';
import { SECTIONS } from './phrases.js';
import { emptyPlan, emptyRow } from '../mediaplan/calc.js';
import { outline } from './kb.js';
import { parseFollowup } from './followup.js';
import { LEAD_STATUSES } from '../admin/reports.js';
import { ratingLetter } from '../core/scoring.js';

const MSK = 3 * 3600e3;
const todayMsk = (now = new Date()) => new Date(now.getTime() + MSK).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const fmtDue = (t) => (t.due ? `${fmtDay(t.due)}${t.due_time ? ` к ${t.due_time}` : ''}` : 'без срока');
const taskHref = (t) => `#/tasks?project=${t.client_id ?? 'none'}&task=${t.id}`;
const taskAction = (t, extra = {}) => ({ type: 'task', id: t.id, title: t.title, href: taskHref(t), ...extra });
const PRIO = { 0: 'без важности', 1: 'низкая', 2: 'средняя', 3: 'высокая', 4: 'критичная' };
const n = (count, one, few, many) => {
  const m10 = count % 10, m100 = count % 100;
  return `${count} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many}`;
};
const company = (l) => l.answers?.company?.raw ?? l.answers?.company ?? null;
const leadLabel = (l) => `№${l.id}${company(l) ? ` «${company(l)}»` : ''}`;
const RU_MONTH = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export function createActions({ crm, calendar, auth, mediaplans, library, leads, reports, notify, kb, news, money, chat, findTask, choose }) {
  const need = (store, what) => {
    if (!store) throw new Error(`${what} недоступны на этом сервере`);
  };

  /** Найти задачу или вернуть готовый ответ (не нашёл / уточни). verb — для вариантов. */
  function withTask(user, query, verb, command, fn) {
    need(crm, 'Задачи');
    const r = findTask(user, query);
    if (r.error) return { reply: r.error, notFound: true };
    if (r.ambiguous) {
      return { reply: `Нашёл несколько похожих — какую ${verb}?`, options: r.ambiguous.map((t) => ({ label: `${t.title}${t.client_name ? ` — ${t.client_name}` : ''}`, command: command(t) })) };
    }
    return fn(r.task);
  }

  function findClientBy(query) {
    const list = crm.listClients();
    const r = bestMatch(query, list, (c) => c.name);
    return r.item ? { client: r.item } : r.candidates.length ? { ambiguous: r.candidates } : {};
  }

  const actions = {
    // ---------- уведомления и оформление ----------
    notifications(user) {
      if (!notify) return { reply: 'Уведомления недоступны.' };
      const items = notify.list(user.id, 10).filter((x) => !x.read_at);
      if (!items.length) return { reply: 'Новых уведомлений нет.' };
      return {
        reply: [`Непрочитанных: ${items.length}.`, ...items.map((x) => `• ${x.text}`)].join('\n'),
        actions: items.filter((x) => x.href).slice(0, 6).map((x) => ({ type: 'link', title: x.text.slice(0, 60), href: x.href })),
        options: [{ label: 'Отметить все прочитанными', command: 'отметь все уведомления прочитанными' }],
      };
    },
    notifications_read(user) {
      notify?.read(user.id);
      return { reply: 'Отметил все уведомления прочитанными.', refreshBell: true };
    },
    theme(user, cmd) {
      const prefs = auth.setPrefs(user.id, { theme: cmd.theme });
      return { reply: { dark: 'Включил тёмную тему.', light: 'Включил светлую тему.', system: 'Тема теперь как в системе.' }[cmd.theme], prefs };
    },
    address(user, cmd) {
      const prefs = auth.setPrefs(user.id, { address: cmd.address });
      return { reply: cmd.address === 'ty' ? 'Хорошо, давай на «ты».' : 'Хорошо, буду обращаться на «вы».', prefs };
    },
    navigate(user, cmd) {
      if (cmd.section === 'staff' || cmd.section === 'integrations') {
        if (user.role !== 'admin') return { reply: 'Этот раздел доступен только администратору.' };
      }
      return { reply: `Открываю «${cmd.label}».`, navigate: `#/${cmd.section}` };
    },

    // ---------- клиенты ----------
    client_create(user, cmd) {
      need(crm, 'Клиенты');
      if (!cmd.name) return { reply: 'Как называется клиент? Например: «добавь клиента Юнистрим».' };
      const same = crm.listClients().find((c) => c.name.toLowerCase().replace(/ё/g, 'е') === cmd.name.toLowerCase().replace(/ё/g, 'е'));
      if (same) return { reply: `Клиент «${same.name}» уже есть.`, actions: [{ type: 'client', id: same.id, title: same.name, href: `#/client?id=${same.id}` }] };
      const c = crm.createClient({ name: cmd.name, site: cmd.site, phone: cmd.phone, email: cmd.email, contact: cmd.contact, managerId: user.id }, user);
      const extra = [cmd.site && `сайт ${cmd.site}`, cmd.contact && `контакт ${cmd.contact}`, cmd.phone && `телефон ${cmd.phone}`, cmd.email && `почта ${cmd.email}`].filter(Boolean);
      return {
        reply: `Добавил клиента «${c.name}»${extra.length ? ` (${extra.join(', ')})` : ''}, менеджер — вы. Проект с доской задач уже готов.`,
        actions: [
          { type: 'client', id: c.id, title: `Карточка «${c.name}»`, href: `#/client?id=${c.id}` },
          { type: 'link', title: 'Задачи проекта', href: `#/tasks?project=${c.id}` },
        ],
        options: [
          { label: 'Поставить задачу', command: `поставь задачу бриф и доступы для ${c.name} на завтра` },
          { label: 'Медиаплан', command: `создай медиаплан для ${c.name}` },
          { label: 'КП', command: `создай КП для ${c.name}` },
        ],
        focus: { type: 'client', id: c.id },
      };
    },
    client_from_lead(user, cmd) {
      need(crm, 'Клиенты');
      const lead = leads?.getLead(cmd.leadId);
      if (!lead) return { reply: `Заявки №${cmd.leadId} нет.` };
      const name = company(lead) || `Клиент по заявке №${lead.id}`;
      const c = crm.createClient({ name, leadId: lead.id, managerId: user.id }, user);
      return { reply: `Завёл клиента «${c.name}» по заявке №${lead.id}.`, actions: [{ type: 'client', id: c.id, title: `Карточка «${c.name}»`, href: `#/client?id=${c.id}` }] };
    },
    client_list(user, cmd) {
      need(crm, 'Клиенты');
      let list = crm.listClients();
      if (cmd.mine) list = list.filter((c) => c.manager_id === user.id);
      if (!list.length) return { reply: cmd.mine ? 'За вами пока нет клиентов.' : 'Клиентов пока нет. Добавьте: «добавь клиента Юнистрим».' };
      return {
        reply: [`${cmd.mine ? 'Ваши клиенты' : 'Клиенты'} (${list.length}):`, ...list.slice(0, 30).map((c) => `• ${c.name}${c.open_tasks ? ` — открытых задач ${c.open_tasks}${c.overdue ? `, просрочено ${c.overdue}` : ''}` : ''}`)].join('\n'),
        actions: [{ type: 'link', title: 'Все клиенты', href: '#/clients' }],
      };
    },
    client_open(user, cmd) {
      return { reply: `Открываю карточку «${cmd.client.name}».`, navigate: `#/client?id=${cmd.client.id}` };
    },
    client_info(user, cmd, { now }) {
      need(crm, 'Клиенты');
      const c = crm.getClient(cmd.client.id);
      const tasks = crm.listTasks({ clientId: c.id, open: true });
      const nowMsk = new Date(now.getTime() + MSK).toISOString().slice(0, 16).replace('T', ' ');
      const late = tasks.filter((t) => t.due && `${t.due} ${t.due_time ?? '23:59'}` < nowMsk);
      const lines = [`«${c.name}»${c.manager_name ? `, менеджер — ${c.manager_name}` : ''}.`];
      lines.push(tasks.length ? `Открытых задач: ${tasks.length}${late.length ? `, просрочено: ${late.length}` : ''}.` : 'Открытых задач нет.');
      for (const t of [...late, ...tasks.filter((t) => !late.includes(t))].slice(0, 5)) lines.push(`• ${late.includes(t) ? '🔴 ' : ''}${t.title}, ${fmtDue(t)}${t.assignee_name ? `, ${t.assignee_name}` : ''}`);
      if (calendar) {
        const today = todayMsk(now);
        const next = calendar.list({ from: `${today}T00:00:00+03:00`, to: `${addDays(today, 60)}T00:00:00+03:00` }).filter((m) => !m.cancelled && m.client_id === c.id)[0];
        if (next) lines.push(`Ближайшая встреча: «${next.title}», ${new Date(next.starts_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`);
      }
      const plans = mediaplans ? mediaplans.list().filter((p) => (p.client ?? '').toLowerCase().includes(c.name.toLowerCase())) : [];
      if (plans.length) lines.push(`Медиапланов: ${plans.length}, последний — «${plans[0].title}».`);
      return {
        reply: lines.join('\n'),
        actions: [{ type: 'client', id: c.id, title: `Карточка «${c.name}»`, href: `#/client?id=${c.id}` }, { type: 'link', title: 'Задачи проекта', href: `#/tasks?project=${c.id}` }, ...(plans[0] ? [{ type: 'plan', id: plans[0].id, title: plans[0].title, href: `#/plan?id=${plans[0].id}` }] : [])],
        focus: { type: 'client', id: c.id },
      };
    },
    client_archive(user, cmd) {
      need(crm, 'Клиенты');
      let client = cmd.client;
      if (!client) {
        const r = findClientBy(cmd.query);
        if (r.ambiguous) return { reply: 'Какого клиента в архив?', options: r.ambiguous.map((c) => ({ label: c.name, command: `в архив клиента ${c.name}` })) };
        client = r.client;
      }
      if (!client) return { reply: `Не нашёл клиента «${cmd.query}».` };
      crm.updateClient(client.id, { archived: true });
      return { reply: `Клиент «${client.name}» в архиве. Задачи и история сохранены; вернуть можно в карточке клиента.`, actions: [{ type: 'client', id: client.id, title: client.name, href: `#/client?id=${client.id}` }] };
    },
    board_create(user, cmd) {
      need(crm, 'Задачи');
      if (!cmd.client && !cmd.internal) {
        const r = findClientBy(cmd.query);
        if (!r.client) return { reply: `Не нашёл проект «${cmd.query}». Добавить клиента? «добавь клиента ${cmd.query}».`, notFound: true };
        cmd.client = r.client;
      }
      const b = crm.createBoard({ clientId: cmd.internal ? null : cmd.client.id, name: cmd.name });
      const key = cmd.internal ? 'none' : cmd.client.id;
      return { reply: `Добавил доску «${b.name}» в проект «${cmd.internal ? 'Общие задачи' : cmd.client.name}» с колонками по умолчанию.`, actions: [{ type: 'link', title: `Доска «${b.name}»`, href: `#/tasks?project=${key}&board=${b.id}` }] };
    },

    // ---------- задачи ----------
    task_assign(user, cmd) {
      const to = cmd.me ? user : cmd.assignee;
      return withTask(user, cmd.query, 'передать', (t) => `передай задачу #${t.id} ${cmd.me ? 'мне' : to.name.split(' ')[0]}`, (t) => {
        const upd = crm.updateTask(t.id, { assigneeId: to.id }, user);
        return { reply: `Задача «${upd.title}» теперь на ${to.id === user.id ? 'вас' : to.name}${to.id === user.id ? '' : ' — ему или ей придёт уведомление'}.`, actions: [taskAction(upd)], focus: { type: 'task', id: upd.id } };
      });
    },
    task_priority(user, cmd) {
      if (cmd.priority == null) return { reply: 'Какую важность поставить: низкую, среднюю, высокую или критичную?' };
      return withTask(user, cmd.query, 'изменить', (t) => `сделай задачу #${t.id} ${['без важности', 'низкой', 'средней', 'важной', 'критичной'][cmd.priority]}`, (t) => {
        const upd = crm.updateTask(t.id, { priority: cmd.priority }, user);
        return { reply: `Важность «${upd.title}» — ${PRIO[cmd.priority]}.`, actions: [taskAction(upd)], focus: { type: 'task', id: upd.id } };
      });
    },
    task_comment(user, cmd) {
      return withTask(user, cmd.query, 'прокомментировать', (t) => `комментарий к задаче #${t.id}: ${cmd.text}`, (t) => {
        crm.addComment(t.id, cmd.text, user);
        return { reply: `Оставил комментарий в задаче «${t.title}». Исполнитель и автор получат уведомление; упомянуть коллегу можно через @Имя.`, actions: [taskAction(t)], focus: { type: 'task', id: t.id } };
      });
    },
    task_delete(user, cmd) {
      return withTask(user, cmd.query, 'удалить', (t) => `удали задачу #${t.id}`, (t) => {
        if (!cmd.confirmed) return { reply: `Удалить задачу «${t.title}»${t.client_name ? ` (${t.client_name})` : ''} вместе с комментариями? Это не отменить.`, options: [{ label: 'Да, удалить', command: `удали задачу #${t.id} подтверждаю` }] };
        crm.deleteTask(t.id, user);
        return { reply: `Удалил задачу «${t.title}».` };
      });
    },
    task_reopen(user, cmd) {
      need(crm, 'Задачи');
      const ref = /#(\d+)/.exec(cmd.query);
      let task = null;
      if (ref) task = crm.getTask(Number(ref[1]));
      else {
        const done = crm.listTasks({ mine: user.id }).filter((t) => t.status === 'done');
        const r = bestMatch(cmd.query, done, (t) => `${t.title} ${t.client_name ?? ''}`);
        if (r.candidates.length > 1) return { reply: 'Какую вернуть в работу?', options: r.candidates.map((t) => ({ label: t.title, command: `верни в работу задачу #${t.id}` })) };
        task = r.item;
      }
      if (!task) return { reply: `Не нашёл среди выполненных задачу «${cmd.query}».`, notFound: true };
      const upd = crm.updateTask(task.id, { done: false }, user);
      return { reply: `Вернул «${upd.title}» в работу.`, actions: [taskAction(upd)], focus: { type: 'task', id: upd.id } };
    },
    task_open(user, cmd) {
      return withTask(user, cmd.query, 'открыть', (t) => `открой задачу #${t.id}`, (t) => ({
        reply: `«${t.title}»${t.client_name ? ` — ${t.client_name}` : ''}: срок ${fmtDue(t)}, ${t.assignee_name ? `исполнитель ${t.assignee_name}` : 'без исполнителя'}, колонка «${t.column_name ?? '—'}».`,
        actions: [taskAction(t)],
        navigate: taskHref(t),
        focus: { type: 'task', id: t.id },
      }));
    },
    team_load(user) {
      need(crm, 'Задачи');
      const users = auth.listUsers().filter((u) => !u.disabled);
      const all = crm.listTasks({ open: true });
      const nowMsk = new Date(Date.now() + MSK).toISOString().slice(0, 16).replace('T', ' ');
      const rows = users
        .map((u) => {
          const mine = all.filter((t) => t.assignee_id === u.id);
          return { u, open: mine.length, late: mine.filter((t) => t.due && `${t.due} ${t.due_time ?? '23:59'}` < nowMsk).length };
        })
        .sort((a, b) => b.late - a.late || b.open - a.open);
      return { reply: ['Загрузка команды (открытые задачи):', ...rows.map((r) => `• ${r.u.name} — ${r.open}${r.late ? `, просрочено ${r.late}` : ''}`)].join('\n'), actions: [{ type: 'link', title: 'Главная', href: '#/home' }] };
    },
    person_tasks(user, cmd) {
      need(crm, 'Задачи');
      const tasks = crm.listTasks({ assigneeId: cmd.user.id, open: true });
      if (!tasks.length) return { reply: `У ${cmd.user.name} нет открытых задач.` };
      return {
        reply: [`${cmd.user.name}: открытых задач ${tasks.length}.`, ...tasks.slice(0, 12).map((t) => `• ${t.title}${t.client_name ? ` — ${t.client_name}` : ''}, ${fmtDue(t)}`)].join('\n'),
        actions: tasks.slice(0, 8).map((t) => taskAction(t)),
      };
    },

    // ---------- встречи ----------
    meeting_cancel(user, cmd, { now }) {
      need(calendar, 'Встречи');
      const today = todayMsk(now);
      let list = calendar.list({ from: `${today}T00:00:00+03:00`, to: `${addDays(today, 60)}T00:00:00+03:00`, userId: user.id }).filter((m) => !m.cancelled);
      if (cmd.date) list = list.filter((m) => new Date(Date.parse(m.starts_at) + MSK).toISOString().slice(0, 10) === cmd.date);
      const ref = /#(\d+)/.exec(cmd.query ?? '');
      let m = ref ? list.find((x) => x.id === Number(ref[1])) : null;
      if (!m) {
        if (!cmd.query && list.length === 1) m = list[0];
        else {
          const r = bestMatch(cmd.query || '', list, (x) => `${x.title} ${x.client_name ?? ''}`);
          const cands = r.candidates.length ? r.candidates : !cmd.query ? list.slice(0, 5) : [];
          if (!r.item && cands.length) return { reply: 'Какую встречу отменить?', options: cands.map((x) => ({ label: `${x.title} — ${new Date(x.starts_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`, command: `отмени встречу #${x.id}` })) };
          m = r.item;
        }
      }
      if (!m) return { reply: 'Не нашёл такую встречу в ближайшие два месяца.' };
      calendar.update(m.id, { cancelled: true });
      return { reply: `Отменил встречу «${m.title}». Напоминаний по ней больше не будет.`, actions: [{ type: 'meeting', id: m.id, title: m.title, href: `#/calendar?meeting=${m.id}` }] };
    },

    meeting_followup(user, cmd, { now }) {
      need(calendar, 'Встречи');
      need(crm, 'Задачи');
      const today = todayMsk(now);
      // недавние встречи сотрудника: неделя назад и сегодня
      const recent = calendar.list({ from: `${addDays(today, -7)}T00:00:00+03:00`, to: `${addDays(today, 1)}T00:00:00+03:00`, userId: user.id }).filter((x) => !x.cancelled);
      let mt = null;
      if (cmd.query) {
        const r = bestMatch(cmd.query, recent, (x) => `${x.title} ${x.client_name ?? ''}`);
        if (!r.item && r.candidates.length) return { reply: 'К какой встрече итоги?', options: r.candidates.map((x) => ({ label: x.title, command: `итоги встречи ${x.title}: ${cmd.text}` })) };
        mt = r.item;
      } else mt = recent.filter((x) => Date.parse(x.starts_at.replace(' ', 'T') + 'Z') <= now.getTime()).at(-1) ?? null;
      if (!mt) return { reply: 'Не нашёл недавнюю встречу. Откройте её в календаре и заполните «Итоги встречи».', navigate: '#/calendar' };
      const team = auth.listUsers().filter((u) => !u.disabled);
      const items = parseFollowup(cmd.text, { team, now });
      if (!items.length) return { reply: 'Перечислите договорённости: «Олег — креативы до пятницы; Ира — медиаплан к 20.10».' };
      const when = new Date(`${mt.starts_at.replace(' ', 'T')}Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
      const tasks = items.map((it) => {
        const t = crm.createTask({ title: it.title, description: `По итогам встречи «${mt.title}», ${when}.`, clientId: mt.client_id ?? null, assigneeId: it.assigneeId, due: it.due, dueTime: it.dueTime, priority: it.priority }, user);
        crm.linkTask(t.id, { kind: 'meeting', refId: mt.id }, user);
        return t;
      });
      return {
        reply: [`Итоги встречи «${mt.title}» — поставил задач: ${tasks.length}${mt.client_name ? ` в проекте «${mt.client_name}»` : ''}.`, ...tasks.map((t) => `• ${t.title} — ${t.assignee_name ?? 'без исполнителя'}${t.due ? `, ${fmtDue(t)}` : ''}`)].join('\n'),
        actions: [{ type: 'meeting', id: mt.id, title: mt.title, href: `#/calendar?meeting=${mt.id}` }, ...tasks.slice(0, 5).map((t) => taskAction(t))],
      };
    },

    // ---------- медиапланы ----------
    mediaplan_create(user, cmd) {
      need(mediaplans, 'Медиапланы');
      const months = Math.min(36, Math.max(1, cmd.months || 3));
      const spec = { ...emptyPlan(cmd.kind), months };
      if (cmd.kind === 'ecom') spec.settings = { ...spec.settings, vat: 22, budgetWithVat: true };
      if (cmd.fee != null) spec.settings = { ...spec.settings, agencyFee: cmd.fee };
      if (cmd.vat != null) spec.settings = { ...spec.settings, vat: cmd.vat || null };
      // каналы из фразы; ставки, CTR и конверсия — из нормативов агентства, если канал там есть
      const benchmarks = mediaplans.benchmarks();
      const notes = [];
      const rows = (cmd.channels ?? []).map((c) => {
        const b = c.name ? benchmarkFor(c.name, benchmarks) : null;
        const row = emptyRow(b);
        // «Яндекс Директ — РСЯ» → площадка «Яндекс Директ», тип размещения «РСЯ»: строки одной площадки идут группой
        const [channel, campaign] = String(c.name ?? '').split(' — ');
        row.channel = campaign ? channel : b?.channel ?? c.name;
        if (campaign) row.campaign = campaign;
        if (c.budget != null) row.budget = cmd.budgetTotal ? Math.round(c.budget / months) : c.budget;
        const label = [row.channel, row.campaign].filter(Boolean).join(' — ');
        if (c.name) notes.push(b ? `«${label}» — ставки и конверсия из нормативов` : `«${label}» — в нормативах нет, ставки впишите сами`);
        return row;
      });
      // кампании одной площадки — рядом, в порядке первого упоминания площадки
      const order = [...new Set(rows.map((r) => r.channel))];
      rows.sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel));
      if (rows.length) spec.scenarios = [{ ...spec.scenarios[0], rows }];
      // клиента нет в списке — название как написали, но с заглавной буквы
      const typed = cmd.clientName ? cmd.clientName.charAt(0).toUpperCase() + cmd.clientName.slice(1) : '';
      const client = cmd.client?.name ?? typed;
      const title = cmd.title || `Медиаплан${client ? ` — ${client}` : ''} на ${n(months, 'месяц', 'месяца', 'месяцев')}`;
      const plan = mediaplans.create({ title, client, spec }, user.name);
      const money = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
      const lines = [`Создал медиаплан «${plan.title}»${cmd.kind === 'ecom' ? ' для интернет-магазина (воронка корзина → продажа, бюджет с НДС)' : ''}.`];
      if (rows.length) {
        lines.push(...rows.map((r) => `• ${[r.channel || 'Канал', r.campaign].filter(Boolean).join(' — ')}${r.budget != null ? ` — ${money(r.budget)} в месяц` : ''}`));
        if (cmd.budgetTotal) lines.push(`Бюджет на весь период разделил на ${n(months, 'месяц', 'месяца', 'месяцев')}.`);
        else if (rows.some((r) => r.budget != null)) lines.push('Бюджет считаю в месяц, без НДС — поправьте в плане, если иначе.');
        if (cmd.budgetSplit) lines.push('Общий бюджет разделил поровну между площадками.');
        lines.push(...notes.map((x) => `${x}.`));
      } else lines.push('Каналы добавьте из нормативов — расчёт и Excel соберутся сами.');
      if (cmd.fee != null) lines.push(`Комиссия агентства — ${cmd.fee}%.`);
      const unknown = !cmd.client && typed;
      if (unknown) lines.push(`Клиента «${typed}» в списке клиентов нет — вписал название как текст.`);
      return {
        reply: lines.join('\n'),
        actions: [{ type: 'plan', id: plan.id, title: plan.title, href: `#/plan?id=${plan.id}` }],
        options: unknown ? [{ label: `Завести клиента «${typed}»`, command: `добавь клиента ${typed}` }] : undefined,
        navigate: `#/plan?id=${plan.id}`,
      };
    },
    mediaplan_open(user, cmd) {
      need(mediaplans, 'Медиапланы');
      const list = mediaplans.list();
      if (!list.length) return { reply: 'Медиапланов пока нет. «Создай медиаплан для Таллера на квартал».' };
      const r = cmd.query ? bestMatch(cmd.query, list, (p) => `${p.title} ${p.client ?? ''}`) : { item: list[0], candidates: [] };
      if (!r.item && r.candidates.length) return { reply: 'Какой медиаплан открыть?', options: r.candidates.map((p) => ({ label: p.title, command: `открой медиаплан #${p.id}` })) };
      const ref = /#(\d+)/.exec(cmd.query ?? '');
      const p = ref ? list.find((x) => x.id === Number(ref[1])) : r.item;
      if (!p) return { reply: `Не нашёл медиаплан «${cmd.query}».`, notFound: true };
      return { reply: `Открываю «${p.title}».`, navigate: `#/plan?id=${p.id}`, actions: [{ type: 'plan', id: p.id, title: p.title, href: `#/plan?id=${p.id}` }] };
    },

    // ---------- документы ----------
    document_create(user, cmd, { now }) {
      need(library, 'Документы');
      const client = cmd.client?.name ?? cmd.clientName ?? '';
      const month = cmd.month ?? RU_MONTH[(new Date(now.getTime() + MSK).getUTCMonth() + 11) % 12];
      const values = { client, manager: user.name, date: new Date(now.getTime() + MSK).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }), month };
      const title = `${cmd.templateName}${client ? ` — ${client}` : ''}${cmd.template === 'report' ? ` за ${month}` : ''}`;
      const doc = library.createDocument({ templateId: cmd.template ? `builtin:${cmd.template}` : null, values, title }, user.name);
      const tip = cmd.template?.startsWith('brief')
        ? ' Поля для ответов пустые: заполните их на созвоне с клиентом или скачайте PDF или PowerPoint и отправьте ему.'
        : cmd.template
          ? ' Поля «[заполнить]» — заготовки: цифры туда вписываете вы.'
          : '';
      return {
        reply: `Создал «${doc.title}» по шаблону.${tip}${cmd.brief ? ' Если нужен черновик текста по брифу — откройте «Документы» → «Собрать с ИИ».' : ''}`,
        actions: [{ type: 'doc', id: doc.id, title: doc.title, href: `#/doc?id=${doc.id}` }],
        navigate: `#/doc?id=${doc.id}`,
      };
    },
    document_open(user, cmd) {
      need(library, 'Документы');
      const list = library.listDocuments();
      const ref = /#(\d+)/.exec(cmd.query ?? '');
      const r = ref ? { item: list.find((d) => d.id === Number(ref[1])), candidates: [] } : bestMatch(cmd.query, list, (d) => d.title);
      if (!r.item && r.candidates.length) return { reply: 'Какой документ открыть?', options: r.candidates.map((d) => ({ label: d.title, command: `открой документ #${d.id}` })) };
      if (!r.item) return { reply: `Не нашёл документ «${cmd.query}».`, notFound: true };
      return { reply: `Открываю «${r.item.title}».`, navigate: `#/doc?id=${r.item.id}`, actions: [{ type: 'doc', id: r.item.id, title: r.item.title, href: `#/doc?id=${r.item.id}` }] };
    },

    // ---------- заявки ----------
    lead_open(user, cmd) {
      const lead = leads?.getLead(cmd.id);
      if (!lead) return { reply: `Заявки №${cmd.id} нет.` };
      return { reply: `Открываю заявку ${leadLabel(lead)}: уровень ${ratingLetter(lead.rating)}, статус «${LEAD_STATUSES[lead.status] ?? lead.status}»${lead.assignee ? `, ведёт ${lead.assignee}` : ''}.`, navigate: `#/leads?lead=${lead.id}` };
    },
    lead_status(user, cmd) {
      if (!leads) return { reply: 'Заявки недоступны.' };
      const patch = { status: cmd.status };
      if (cmd.take) patch.assignee = user.name;
      const lead = leads.updateLead(cmd.id, patch, user.name);
      if (!lead) return { reply: `Заявки №${cmd.id} нет.` };
      const extra = cmd.status === 'in_work' && crm && !crm.listClients().some((c) => c.lead_id === lead.id) ? [{ label: 'Завести клиента', command: `заведи клиента по заявке ${lead.id}` }] : [];
      return { reply: `Заявка ${leadLabel(lead)}: статус «${LEAD_STATUSES[lead.status]}»${cmd.take ? ', ответственный — вы' : ''}.`, actions: [{ type: 'lead', id: lead.id, title: `Заявка ${leadLabel(lead)}`, href: `#/leads?lead=${lead.id}` }], options: extra };
    },
    lead_list(user, cmd, { now }) {
      if (!reports) return { reply: 'Заявки недоступны.' };
      const today = todayMsk(now);
      const from = { today, yesterday: addDays(today, -1), week: addDays(today, -6), month: addDays(today, -29), quarter: addDays(today, -89) }[cmd.period] ?? addDays(today, -6);
      const to = cmd.period === 'yesterday' ? from : null;
      let list = reports.allLeads({ from, to }, 200);
      if (cmd.fresh) list = list.filter((l) => l.status === 'new');
      if (cmd.hot) list = list.filter((l) => l.rating >= 4);
      const what = `${cmd.hot ? 'Горячие' : cmd.fresh ? 'Новые' : 'Все'} заявки ${{ today: 'за сегодня', yesterday: 'за вчера', week: 'за неделю', month: 'за месяц', quarter: 'за квартал' }[cmd.period] ?? 'за неделю'}`;
      if (!list.length) return { reply: `${what}: нет.`, actions: [{ type: 'link', title: 'Квалификатор', href: '#/leads' }] };
      list.sort((a, b) => b.rating - a.rating || b.id - a.id);
      return {
        reply: [`${what}: ${list.length}.`, ...list.slice(0, 10).map((l) => `• ${leadLabel(l)} — уровень ${ratingLetter(l.rating)}, «${LEAD_STATUSES[l.status] ?? l.status}»${l.assignee ? `, ${l.assignee}` : ''}`)].join('\n'),
        actions: list.slice(0, 6).map((l) => ({ type: 'lead', id: l.id, title: `Заявка ${leadLabel(l)}`, href: `#/leads?lead=${l.id}` })),
        options: list.some((l) => l.status === 'new') ? [{ label: `Взять №${list.find((l) => l.status === 'new').id}`, command: `возьми заявку ${list.find((l) => l.status === 'new').id}` }] : [],
      };
    },
    lead_stats(user, cmd, { now }) {
      if (!reports) return { reply: 'Заявки недоступны.' };
      const today = todayMsk(now);
      const period = cmd.period ?? 'week';
      const from = { today, yesterday: addDays(today, -1), week: addDays(today, -6), month: addDays(today, -29), quarter: addDays(today, -89) }[period];
      const list = reports.allLeads({ from, to: period === 'yesterday' ? from : null }, 5000);
      const prevFrom = addDays(from, -(Date.parse(`${today}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400e3 - 1);
      const prev = period === 'today' || period === 'yesterday' ? null : reports.allLeads({ from: prevFrom, to: addDays(from, -1) }, 5000).length;
      const by = (f) => Object.entries(list.reduce((acc, l) => ((acc[f(l)] = (acc[f(l)] ?? 0) + 1), acc), {}));
      const label = { today: 'сегодня', yesterday: 'вчера', week: 'за 7 дней', month: 'за 30 дней', quarter: 'за 90 дней' }[period];
      const lines = [`Заявок ${label}: ${list.length}${prev != null ? ` (до этого — ${prev})` : ''}.`];
      if (list.length) {
        lines.push(`Горячих (уровни A–B): ${list.filter((l) => l.rating >= 4).length}.`);
        lines.push(`По статусам: ${by((l) => LEAD_STATUSES[l.status] ?? l.status).map(([k, v]) => `${k} — ${v}`).join(', ')}.`);
      }
      return { reply: lines.join('\n'), actions: [{ type: 'link', title: 'Сводка по заявкам', href: '#/stats' }] };
    },

    // ---------- мессенджер ----------
    chat_send(user, cmd) {
      if (!chat) return { reply: 'Мессенджер недоступен.' };
      if (cmd.user.id === user.id) return { reply: 'Это вы сами 🙂 Кому написать?' };
      const c = chat.direct(user, cmd.user.id);
      chat.send(c.id, user, { text: cmd.text });
      return { reply: `Отправил ${cmd.user.name}: «${cmd.text.length > 120 ? `${cmd.text.slice(0, 120)}…` : cmd.text}».`, actions: [{ type: 'link', title: `Чат с ${cmd.user.name}`, href: `#/chat?id=${c.id}` }] };
    },

    // ---------- деньги ----------
    money_summary(user, cmd, { now } = {}) {
      if (!money) return { reply: 'Учёт оплат недоступен.' };
      const s = money.summary(user, now);
      const rub = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
      const lines = [];
      lines.push(s.overdue.sum ? `Просрочено: ${rub(s.overdue.sum)} (${s.overdue.count}).` : 'Просроченных оплат нет.');
      for (const d of s.debtors.slice(0, 8)) lines.push(`• ${d.client_name} — ${rub(d.sum)}, ${d.days} дн.`);
      lines.push(`Ждём в этом месяце: ${rub(s.expected.sum)}. Получено в этом месяце: ${rub(s.received.sum)}.`);
      return { reply: lines.join('\n'), actions: [{ type: 'link', title: 'Оплаты', href: '#/money' }, ...s.debtors.slice(0, 4).map((d) => ({ type: 'client', id: d.client_id, title: d.client_name, href: `#/client?id=${d.client_id}` }))] };
    },
    money_paid(user, cmd, { now }) {
      if (!money) return { reply: 'Учёт оплат недоступен.' };
      const rub = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
      const open = money.list(user, { clientId: cmd.client.id, now }).filter((p) => p.status !== 'paid');
      let p = cmd.amount ? open.find((x) => Math.round(x.amount) === Math.round(cmd.amount)) : open.length === 1 ? open[0] : null;
      if (!p && !cmd.amount && open.length > 1) return { reply: `У «${cmd.client.name}» несколько неоплаченных счетов — какой оплачен?`, options: open.slice(0, 5).map((x) => ({ label: `${x.label} — ${rub(x.amount)}`, command: `${cmd.client.name} оплатил ${Math.round(x.amount)}` })) };
      if (!p && !cmd.amount) return { reply: `Сколько оплатил «${cmd.client.name}»? Например: «${cmd.client.name} оплатил 80 000».` };
      if (p) {
        money.update(p.id, { paid: true }, user, now);
        return { reply: `Отметил оплату: ${cmd.client.name} — ${rub(p.amount)}, ${p.label.toLowerCase()}.`, actions: [{ type: 'client', id: cmd.client.id, title: cmd.client.name, href: `#/client?id=${cmd.client.id}` }] };
      }
      const added = money.add(cmd.client.id, { kind: 'other', title: 'Оплата', amount: cmd.amount, paid: true }, user, now);
      return { reply: `Счёта на ${rub(cmd.amount)} у «${cmd.client.name}» не было — записал поступление ${rub(added.amount)}.${open.length ? ` Неоплаченных счетов: ${open.length}.` : ''}`, actions: [{ type: 'client', id: cmd.client.id, title: cmd.client.name, href: `#/client?id=${cmd.client.id}` }] };
    },
    money_invoice(user, cmd, { now }) {
      if (!money) return { reply: 'Учёт оплат недоступен.' };
      if (!cmd.client) return { reply: 'Кому выставить счёт? Например: «выставь счёт Таллеру 80 000 до 20.10».', notFound: true };
      if (!cmd.amount) return { reply: `На какую сумму счёт для «${cmd.client.name}»?` };
      const p = money.add(cmd.client.id, { kind: cmd.kind, title: cmd.title, amount: cmd.amount, due: cmd.due }, user, now);
      const rub = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
      return { reply: `Записал счёт: ${cmd.client.name} — ${rub(p.amount)}, ${p.label.toLowerCase()}${p.due ? `, срок ${fmtDay(p.due)}` : ''}. Напомню менеджеру за 3 дня и при просрочке.`, actions: [{ type: 'client', id: cmd.client.id, title: cmd.client.name, href: `#/client?id=${cmd.client.id}` }] };
    },
    money_billing(user, cmd) {
      if (!money) return { reply: 'Учёт оплат недоступен.' };
      money.setBilling(cmd.client.id, { fee: cmd.fee, payDay: cmd.payDay ?? 10 }, user);
      const rub = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
      return { reply: `Ведение «${cmd.client.name}» — ${rub(cmd.fee)} в месяц, оплата до ${cmd.payDay ?? 10} числа. Счёт будет появляться каждый месяц сам, напомню за 3 дня до срока.`, actions: [{ type: 'client', id: cmd.client.id, title: cmd.client.name, href: `#/client?id=${cmd.client.id}` }] };
    },

    // ---------- новости ----------
    news_create(user, cmd) {
      if (!news) return { reply: 'Новости недоступны.' };
      const p = news.create({ body: cmd.body }, user);
      return { reply: 'Опубликовал в «Новостях». Фото, видео или кейс удобнее добавить в самой ленте.', actions: [{ type: 'link', title: 'Запись в новостях', href: `#/news?post=${p.id}` }] };
    },
    news_list(user) {
      if (!news) return { reply: 'Новости недоступны.' };
      const { posts } = news.list(user.id, { limit: 5 });
      if (!posts.length) return { reply: 'В новостях пока пусто. Напишите: «опубликуй в новости: …»', navigate: '#/news' };
      return {
        reply: ['Последнее в новостях:', ...posts.map((p) => `• ${p.pinned ? '📌 ' : ''}${p.author}: ${(p.title || p.body || p.link || 'фото и видео').split('\n')[0].slice(0, 120)}${p.comments ? ` (💬 ${p.comments})` : ''}`)].join('\n'),
        actions: posts.slice(0, 5).map((p) => ({ type: 'link', title: (p.title || p.body || 'Запись').split('\n')[0].slice(0, 60), href: `#/news?post=${p.id}` })),
      };
    },

    // ---------- регламенты ----------
    kb_apply(user, cmd) {
      if (!kb || !crm) return { reply: 'Регламенты недоступны.' };
      const list = kb.list();
      const r = bestMatch(cmd.query, list, (d) => d.title);
      if (!r.item && r.candidates.length) return { reply: 'Какой регламент запустить?', options: r.candidates.map((d) => ({ label: d.title, command: `запусти регламент ${d.title}${cmd.clientQuery ? ` для ${cmd.clientQuery}` : ''}` })) };
      if (!r.item) return { reply: `Регламента «${cmd.query}» нет. Список — в разделе «Регламенты».`, notFound: true };
      if (cmd.clientQuery && !cmd.client && !cmd.internal) return { reply: `Не нашёл проект «${cmd.clientQuery}». Добавить клиента? «добавь клиента ${cmd.clientQuery}».`, notFound: true };
      if (!cmd.clientQuery) return { reply: `В какой проект запустить «${r.item.title}»?`, options: crm.listClients().slice(0, 6).map((c) => ({ label: c.name, command: `запусти регламент ${r.item.title} для ${c.name}` })).concat([{ label: 'Общие задачи', command: `запусти регламент ${r.item.title} в общие` }]) };
      const doc = kb.get(r.item.id);
      const res = crm.tasksFromSteps({ clientId: cmd.client?.id ?? null, steps: outline(doc), source: doc.title, assigneeId: user.id }, user);
      const key = cmd.client?.id ?? 'none';
      return {
        reply: [`Запустил «${doc.title}» в проекте «${cmd.client?.name ?? 'Общие задачи'}»: новая доска и ${res.tasks.length} ${res.tasks.length === 1 ? 'задача' : res.tasks.length < 5 ? 'задачи' : 'задач'}, ответственный — вы.`, ...res.tasks.map((t) => `• ${t.title}`)].join('\n'),
        actions: [{ type: 'link', title: `Доска «${res.board.name}»`, href: `#/tasks?project=${key}&board=${res.board.id}` }],
      };
    },
    kb_open(user, cmd) {
      if (!kb) return { reply: 'Регламенты недоступны.' };
      const list = kb.list();
      if (!list.length) return { reply: 'Регламентов пока нет — их добавляет администратор в разделе «Регламенты».', navigate: '#/kb' };
      const r = bestMatch(cmd.query, list, (d) => d.title);
      if (!r.item && r.candidates.length) return { reply: 'Какой регламент открыть?', options: r.candidates.map((d) => ({ label: d.title, command: `открой регламент ${d.title}` })) };
      if (!r.item) return { reply: `Регламента про «${cmd.query}» нет. Спросите своими словами — поищу ответ в описаниях процессов.`, notFound: true };
      return { reply: `Открываю регламент «${r.item.title}».`, navigate: `#/kb?id=${r.item.id}` };
    },
  };

    /** Справка — из того, что реально умеет ассистент на этом сервере. */
  function help() {
    const g = [];
    g.push('Что я умею (пишите обычной фразой):');
    if (crm) {
      g.push('', 'Задачи', '• «поставь задачу КП для Таллера на пятницу», «поручи Олегу медиаплан до 20.10 срочно»', '• «закрой задачу по лендингу», «я сделал отчёт», «верни в работу отчёт»', '• «перенеси отчёт на понедельник в 12», «срок по баннерам — завтра»', '• «передай задачу баннеры Олегу», «сделай задачу отчёт критичной»', '• «комментарий к задаче баннеры: макеты в папке»', '• «что у меня сегодня», «что горит», «что у Олега», «загрузка команды»');
      g.push('', 'Клиенты и проекты', '• «добавь клиента Юнистрим, сайт unistream.ru»', '• «что по Таллеру», «список клиентов», «в архив клиента Ромашка»', '• «создай доску Трафик в проекте Таллер»');
    }
    if (calendar) g.push('', 'Встречи', '• «встреча с Ромашкой завтра в 15 в Телемосте»', '• «перенеси встречу с Таллером на четверг», «отмени планёрку», «встречи на неделе»', '• «итоги встречи с Таллером: Олег — креативы до пятницы; Ира — медиаплан к 20.10»');
    if (mediaplans || library) g.push('', 'Медиапланы и документы', '• «создай медиаплан для Таллера на квартал», «медиаплан для интернет-магазина»', '• «создай КП для Юнистрима», «сделай отчёт для Таллера за сентябрь», «открой медиаплан Таллер»');
    if (reports) g.push('', 'Заявки', '• «новые заявки», «горячие заявки за неделю», «сколько заявок за месяц»', '• «возьми заявку 123», «заявка 123 — спам», «заведи клиента по заявке 123»');
    if (money) g.push('', 'Деньги', '• «Таллер оплатил 80 000», «выставь счёт Ромашке 50 000 до 20.10 за аудит»', '• «ведение Таллер 80 000 в месяц до 10 числа», «кто должен»');
    if (kb) g.push('', 'Регламенты', '• «запусти регламент запуска рекламы для Таллера» — шаги задачами с чек-листами', '• «открой регламент по КП»');
    if (chat) g.push('', 'Сообщения', '• «напиши Олегу: макеты готовы, глянь»', '• «открой сообщения»');
    g.push('', 'Новости', '• «опубликуй в новости: запустили РСЯ для Таллера», «покажи новости»');
    g.push('', 'Кабинет', '• «открой календарь», «перейди в медиапланы», «что нового», «включи тёмную тему»');
    g.push('', 'Остальное — свободным вопросом: помогу разложить задачу, составить текст и найду ответ в регламентах или в интернете.');
    return g.join('\n');
  }

  return { ...actions, help, sections: SECTIONS };
}

/** Норматив для канала: «Яндекс Директ» найдёт «Яндекс Директ — Поиск», если такой один. */
function benchmarkFor(name, list) {
  const norm = (x) => x.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  const want = norm(name);
  const exact = list.find((b) => norm(b.channel) === want);
  if (exact) return exact;
  const starts = list.filter((b) => norm(b.channel).startsWith(want) || want.startsWith(norm(b.channel)));
  return starts.length === 1 ? starts[0] : null;
}
