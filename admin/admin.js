// Админка ассистента агентства. Без сборки и зависимостей: модули ES, DOM строится через h(),
// пользовательские данные выводятся только как текст (никакого innerHTML с данными).

import { renderDocs, renderDoc, renderTemplates, leadDocuments, formDialog, fill, pickMedia } from './docs.js';
import { renderPlans, renderPlan, renderBenchmarks } from './mediaplans.js';
import { renderProjects, renderTaskBoard, renderMyTasks, renderClients, renderClient, leadClient } from './tasks.js';
import { renderCalendar, notificationsPanel } from './calendar.js';
import { renderIntegrations } from './integrations.js';
import { renderSystem } from './system.js';
import { renderAbandoned } from './abandoned.js';
import { assistantEntry } from './assistant.js';
import { renderKb } from './kb.js';
import { renderHome, bellButton } from './home.js';
import { renderNews, refreshNewsBadge } from './news.js';
import { renderMoney } from './money.js';
import { renderNotifySettings } from './notify.js';
import { renderChat, refreshChatBadge } from './chat.js';

const app = document.getElementById('app');
const TZ = 'Europe/Moscow';
const CHANNELS = { web: 'Сайт', telegram: 'Telegram', max: 'MAX' };
// уровень квалификации буквой: критерии те же, что у прежнего рейтинга 5…1
const LETTER = { 5: 'A', 4: 'B', 3: 'C', 2: 'D', 1: 'E' };
const letter = (r) => LETTER[r] ?? '—';
const EVENT_TEXT = {
  created: (e) => `Лид создан, уровень ${letter(e.data.rating)}`,
  status: (e, ctx) => `Статус: ${ctx.statuses[e.data.from] ?? e.data.from ?? '—'} → ${ctx.statuses[e.data.to] ?? e.data.to}`,
  assignee: (e) => (e.data.to ? `Ответственный: ${e.data.to}` : 'Ответственный снят'),
  comment: (e) => (e.data.text ? `Комментарий: ${e.data.text}` : 'Комментарий удалён'),
  rating: (e) => `Уровень изменён вручную: ${letter(e.data.from)} → ${letter(e.data.to)}${e.data.reason ? ` (${e.data.reason})` : ''}`,
};
// что значит уровень — подсказка при ручной смене (критерии таблицы «Этапы продаж»)
const LEVELS = [
  [5, 'A — звёздный клиент: мировой или федеральный бренд'],
  [4, 'B — бюджет от 500 000 ₽/мес, несколько каналов или комплекс, зарубежный'],
  [3, 'C — крепкая адекватная компания'],
  [2, 'D — собирает КП, нет ЛПР, «сколько стоит», не проходит по цене'],
  [1, 'E — неадекват, спам, стоп-слова'],
];
const PERIODS = [
  ['7', '7 дней'],
  ['30', '30 дней'],
  ['90', '90 дней'],
  ['all', 'Всё время'],
  ['custom', 'Свой период'],
];

const ctx = { me: null, statuses: {}, scenario: null, links: {} };

// ---------- утилиты ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    // через CSSOM: атрибут style="" запрещён политикой безопасности (CSP без unsafe-inline)
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat(Infinity)) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

class HttpError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/admin/api/login') {
    renderLogin();
    throw new HttpError(401, 'Нужно войти');
  }
  if (!res.ok) throw new HttpError(res.status, data.error || 'Не удалось выполнить запрос', data);
  return data;
}

const utc = (s) => new Date(`${s.replace(' ', 'T')}Z`);
const fmtDateTime = (s) => {
  const d = utc(s);
  const date = d.toLocaleDateString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
};
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const mskToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
function mskDaysAgo(n) {
  const d = new Date(`${mskToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};

// Уведомления внизу экрана: несколько подряд встают стопкой; ошибки — красным и держатся дольше
const TOAST_ERROR = /^(не |нет |ошибка|слишком|недостаточно|нельзя|невозможно|укажите|нужн|файл больше|сначала)|не удалось|не получилось|не найден/i;
function toast(text, { type = TOAST_ERROR.test(String(text)) ? 'error' : 'ok' } = {}) {
  let stack = document.querySelector('.toasts');
  if (!stack) {
    stack = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(stack);
  }
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  const el = h(
    'div',
    { class: `toast toast-${type}` },
    h('span', { class: 'toast-mark', 'aria-hidden': 'true' }, type === 'error' ? '!' : '✓'),
    h('span', { class: 'toast-text' }, text),
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Закрыть', onclick: close }, '×'),
  );
  stack.append(el);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(close, type === 'error' ? 6000 : 3200);
}

/**
 * Подтверждение в стиле кабинета вместо системного confirm(). Возвращает true или false.
 * Кнопка и заголовок берутся из первого слова вопроса («Удалить …?» → «Удалить»).
 */
function confirmDialog(text, { title = null, ok = null, danger = null } = {}) {
  const verb = /^([А-ЯЁ][а-яё]+)/.exec(String(text))?.[1] ?? 'Продолжить';
  const isDanger = danger ?? /^(Удалить|Сбросить|Очистить|Отключить|Отменить)/.test(verb);
  return new Promise((resolve) => {
    let answer = false;
    const yes = h('button', { type: 'button', class: `btn ${isDanger ? 'btn-danger' : 'btn-primary'}`, onclick: () => ((answer = true), dlg.close()) }, ok ?? verb);
    const no = h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Отмена');
    const dlg = h(
      'dialog',
      { class: `dialog confirm-dialog${isDanger ? ' is-danger' : ''}`, 'aria-labelledby': 'cf-title', 'aria-describedby': 'cf-text' },
      h('div', { class: 'confirm-icon', 'aria-hidden': 'true' }, icon(isDanger ? 'trash' : 'system')),
      h('div', { class: 'confirm-body' }, h('h2', { id: 'cf-title' }, title ?? (isDanger ? `${verb}?` : 'Подтвердите действие')), h('p', { id: 'cf-text' }, text)),
      h('div', { class: 'confirm-actions' }, no, yes),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(answer);
    });
    document.body.append(dlg);
    dlg.showModal();
    yes.focus();
  });
}

function stepOf(id) {
  return ctx.scenario.steps.find((s) => s.id === id);
}
function answerText(id, value) {
  if (value == null) return '';
  if (typeof value === 'object') return value.raw ?? JSON.stringify(value);
  return stepOf(id)?.options?.find((o) => o.value === value)?.label ?? String(value);
}

function meter(rating, large = false) {
  return h(
    'span',
    { class: `meter${large ? ' meter-lg' : ''}`, dataset: { r: String(rating) }, title: `Уровень ${letter(rating)} (A — лучший, E — спам)` },
    h('span', { class: 'meter-bars', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= rating ? 'on' : '' }))),
    h('b', {}, letter(rating)),
    h('span', { class: 'sr-only' }, ' — уровень квалификации'),
  );
}

const statusChip = (status) => h('span', { class: 'status', dataset: { s: status } }, status === 'won' ? '✓ ' : '', ctx.statuses[status] ?? status);

// ---------- маршруты ----------

const routes = {
  home: renderHome,
  news: renderNews,
  money: renderMoney,
  'notify-settings': renderNotifySettings,
  chat: renderChat,
  docs: renderDocs,
  doc: renderDoc,
  templates: renderTemplates,
  plans: renderPlans,
  plan: renderPlan,
  benchmarks: renderBenchmarks,
  tasks: renderProjects,
  taskboard: renderTaskBoard,
  mytasks: renderMyTasks,
  clients: renderClients,
  client: renderClient,
  calendar: renderCalendar,
  integrations: renderIntegrations,
  system: renderSystem,
  abandoned: renderAbandoned,
  leads: renderLeads,
  board: renderBoard,
  stats: renderStats,
  test: renderTest,
  staff: renderStaff,
  account: renderAccount,
  appearance: renderAppearance,
  kb: renderKb,
};
// Разделы со своими вкладками: ключ — первая вкладка (на неё ведёт пункт меню)
const SECTION_TABS = {
  leads: [
    ['leads', 'Лиды'],
    ['board', 'Воронка'],
    ['stats', 'Сводка'],
    ['test', 'Тест'],
    ['abandoned', 'Брошенные'],
  ],
  plans: [
    ['plans', 'Медиапланы'],
    ['benchmarks', 'Нормативы'],
  ],
  staff: [
    ['staff', 'Сотрудники'],
    ['integrations', 'Подключения'],
    ['system', 'Состояние'],
  ],
  account: [
    ['account', 'Учётная запись'],
    ['notify-settings', 'Уведомления'],
    ['appearance', 'Внешний вид'],
  ],
  tasks: [
    ['tasks', 'Проекты'],
    ['mytasks', 'Мои задачи'],
    ['clients', 'Клиенты'],
    ['money', 'Оплаты'],
  ],
};
// Страницы внутри раздела без своей вкладки
const PAGE_SECTION = { doc: 'docs', plan: 'plans', client: 'tasks', taskboard: 'tasks' };

function currentRoute() {
  const [name, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { name: routes[name] ? name : 'home', params: new URLSearchParams(query) };
}

function navigate(name, params) {
  const qs = params?.toString();
  location.hash = `#/${name}${qs ? `?${qs}` : ''}`;
}

// Открытие и закрытие карточки лида не перерисовывает страницу под ней
let renderedKey = null;
window.addEventListener('hashchange', () => {
  if (!ctx.me) return;
  const { name, params } = currentRoute();
  const lead = params.get('lead');
  params.delete('lead');
  const key = `${name}?${params}`;
  if (key !== renderedKey) return renderRoute();
  closeDrawer();
  if (lead) openLead(Number(lead));
});

async function boot() {
  try {
    const me = await api('/admin/api/me');
    Object.assign(ctx, { me: me.user, roles: me.roles, statuses: me.statuses, scenario: me.scenario, links: me.links, testChat: me.testChat, avatars: me.avatars ?? {}, aiSummary: Boolean(me.aiSummary) });
    if (me.user.prefs) window.sorokaTheme?.apply(me.user.prefs);
    // без адреса раздела — стартовый раздел из личных настроек
    if (!location.hash.replace(/^#\/?/, '') && me.user.prefs?.start) return navigate(me.user.prefs.start);
    renderRoute();
  } catch (err) {
    if (err.status !== 401) app.replaceChildren(h('p', { class: 'page error' }, err.message));
  }
}

// Значки разделов: простые контуры 24×24, цвет берут от текста
const ICONS = {
  home: 'M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5',
  news: 'M4 5h13v14H6a2 2 0 0 1-2-2zM17 9h3v8a2 2 0 0 1-2 2M8 9h5M8 13h5M8 16h3',
  chat: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1.5 1.5 0 1 0 0-.01',
  clip: 'M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7.2',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  up: 'M12 19V5M6 11l6-6 6 6',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  down: 'M12 5v14M6 13l6 6 6-6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  docs: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  templates: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  plans: 'M3 21h18M6 17v-5M11 17V5M16 17V9M21 17v-3',
  tasks: 'M10 6h10M10 12h10M10 18h10M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17',
  calendar: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4',
  leads: 'M3 4h18l-7 8.5V19l-4 2v-8.5z',
  staff: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  light: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  dark: 'M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5a6.5 6.5 0 0 0 10 10z',
  system: 'M3 4h18v12H3zM8 20h8M12 16v4',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3',
  due: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4',
  priority: 'M5 20v-4M10 20v-8M15 20V8M20 20V4',
  person: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21v-1a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7v1',
  archive: 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  kb: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 5v16M8 7h7M8 11h5',
};
function icon(name) {
  return s('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, s('path', { d: ICONS[name] }));
}
function initials(name = '') {
  return String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}
// ---------- выпадающие списки в стиле кабинета ----------
// Системное окно <select> браузера не стилизуется, поэтому на компьютере открываем своё:
// значение по-прежнему хранит настоящий <select> (формы, обработчики change, доступность),
// а список рисуем сами. На телефонах остаётся системный выбор — он там удобнее.

let closeSelectPop = null;
function openSelectPop(select) {
  closeSelectPop?.();
  const items = [];
  const list = h('div', { class: 'select-pop', role: 'listbox', tabindex: '-1', 'aria-label': select.getAttribute('aria-label') ?? select.labels?.[0]?.textContent ?? 'Выбор' });
  const addOption = (o) => {
    const el = h('div', { class: 'select-opt', role: 'option', 'aria-selected': String(o.selected), 'aria-disabled': o.disabled ? 'true' : null, dataset: { i: String(o.index) } }, h('span', { class: 'select-opt-text' }, o.textContent), o.selected ? h('span', { class: 'select-check', 'aria-hidden': 'true' }, '✓') : null);
    items.push(el);
    list.append(el);
  };
  for (const child of select.children) {
    if (child.tagName === 'OPTGROUP') {
      list.append(h('div', { class: 'select-group' }, child.label));
      for (const o of child.children) if (!o.hidden) addOption(o);
    } else if (!child.hidden) addOption(child);
  }
  let active = Math.max(0, items.findIndex((el) => el.getAttribute('aria-selected') === 'true'));
  const mark = () => items.forEach((el, i) => el.classList.toggle('active', i === active));
  const pick = (el) => {
    if (!el || el.getAttribute('aria-disabled')) return;
    const idx = Number(el.dataset.i);
    close();
    if (select.selectedIndex !== idx) {
      select.selectedIndex = idx;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    select.focus();
  };
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => pick(e.target.closest('.select-opt')));
  list.addEventListener('mousemove', (e) => {
    const el = e.target.closest('.select-opt');
    if (el && !el.getAttribute('aria-disabled')) {
      active = items.indexOf(el);
      mark();
    }
  });
  let typed = '';
  let typedAt = 0;
  const onKey = (e) => {
    const step = (d) => {
      let i = active;
      do i += d;
      while (items[i]?.getAttribute('aria-disabled'));
      if (items[i]) active = i;
      mark();
      items[active]?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Home') ((active = 0), step(0));
    else if (e.key === 'End') ((active = items.length - 1), step(0));
    else if (e.key === 'Enter' || e.key === ' ') pick(items[active]);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      close();
      if (e.key === 'Escape') select.focus();
      if (e.key === 'Tab') return;
    } else if (e.key.length === 1) {
      typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = Date.now();
      const i = items.findIndex((el) => el.textContent.toLowerCase().startsWith(typed));
      if (i >= 0) ((active = i), step(0));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const outside = (e) => !list.contains(e.target) && e.target !== select && close();
  function close() {
    list.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', outside, true);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', reposition, true);
    select.removeAttribute('data-open');
    if (closeSelectPop === close) closeSelectPop = null;
  }
  function reposition(e) {
    if (e && list.contains(e.target)) return;
    const r = select.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return close();
    const below = innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const want = Math.min(list.scrollHeight, 320);
    const up = below < Math.min(want, 200) && above > below;
    const max = Math.max(120, Math.min(320, up ? above : below));
    list.style.cssText = `left:${Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 200) - 8))}px;min-width:${Math.max(r.width, 180)}px;max-height:${max}px;${up ? `bottom:${innerHeight - r.top + 4}px` : `top:${r.bottom + 4}px`}`;
  }
  // внутри модального окна список должен быть в том же слое, иначе он окажется под ним
  (select.closest('dialog[open]') ?? document.body).append(list);
  select.setAttribute('data-open', '');
  reposition();
  mark();
  items[active]?.scrollIntoView({ block: 'nearest' });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', outside, true);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', reposition, true);
  closeSelectPop = close;
}
const fineSelect = (t) => t instanceof HTMLSelectElement && !t.multiple && t.size <= 1 && !t.disabled && !matchMedia('(pointer: coarse)').matches;
document.addEventListener('mousedown', (e) => {
  if (!fineSelect(e.target) || e.button !== 0) return;
  e.preventDefault();
  e.target.focus();
  if (e.target.hasAttribute('data-open')) closeSelectPop?.();
  else openSelectPop(e.target);
});
document.addEventListener('keydown', (e) => {
  if (!fineSelect(e.target) || e.target.hasAttribute('data-open')) return;
  if (e.key === ' ' || e.key === 'Enter' || (e.altKey && e.key === 'ArrowDown') || e.key === 'F4') {
    e.preventDefault();
    openSelectPop(e.target);
  }
});

/**
 * Поле с подсказками (вместо системного <datalist>): список вариантов под полем,
 * фильтруется по введённому тексту; можно выбрать мышью или стрелками и Enter.
 */
function suggestInput(input, getOptions) {
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  let pop = null;
  let active = -1;
  const close = () => {
    pop?.remove();
    pop = null;
    input.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    const q = input.value.trim().toLowerCase().replace(/ё/g, 'е');
    const all = [...new Set(getOptions().filter(Boolean))];
    const list = all.filter((x) => !q || x.toLowerCase().replace(/ё/g, 'е').includes(q)).slice(0, 30);
    if (!list.length || (list.length === 1 && list[0] === input.value)) return close();
    pop?.remove();
    active = -1;
    pop = h('div', { class: 'select-pop suggest-pop', role: 'listbox' }, list.map((x) => h('div', { class: 'select-opt', role: 'option', 'aria-selected': String(x === input.value), dataset: { v: x } }, h('span', { class: 'select-opt-text' }, x))));
    pop.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const el = e.target.closest('.select-opt');
      if (el) choose(el.dataset.v);
    });
    (input.closest('dialog[open]') ?? document.body).append(pop);
    const r = input.getBoundingClientRect();
    pop.style.cssText = `left:${r.left}px;top:${r.bottom + 4}px;min-width:${r.width}px;max-height:${Math.max(140, Math.min(300, innerHeight - r.bottom - 12))}px`;
    input.setAttribute('aria-expanded', 'true');
  };
  const choose = (v) => {
    input.value = v;
    close();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', () => setTimeout(close, 100));
  input.addEventListener('keydown', (e) => {
    if (!pop) return;
    const items = [...pop.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(items[active].dataset.v);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  return input;
}

// ---------- таймер обратного отсчёта (встречи и задачи) ----------

const timers = new Set();
let timerLoop = null;
function spell(ms) {
  const min = Math.floor(ms / 60e3);
  const d = Math.floor(min / 1440);
  const hh = Math.floor((min % 1440) / 60);
  const mm = min % 60;
  if (d >= 2) return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  if (d >= 1) return `${d} дн ${hh} ч`;
  if (hh >= 1) return `${hh} ч ${mm} мин`;
  const ss = Math.floor((ms % 60e3) / 1000);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}
function tickTimer(el) {
  const now = Date.now();
  const left = el._until - now;
  let text;
  let state;
  if (el._kind === 'meeting' && left <= 0 && el._end && now < el._end) {
    text = `идёт · ещё ${spell(el._end - now)}`;
    state = 'live';
  } else if (left > 0) {
    text = `${el._kind === 'meeting' ? 'через' : 'осталось'} ${spell(left)}`;
    state = left < 15 * 60e3 ? 'urgent' : left < 3 * 3600e3 ? 'soon' : '';
  } else {
    text = el._kind === 'meeting' ? 'прошла' : `просрочено на ${spell(-left)}`;
    state = el._kind === 'meeting' ? 'past' : 'late';
  }
  if (el.textContent !== text) el.textContent = text;
  el.dataset.state = state;
}
/**
 * Таймер: «через 2 ч 15 мин», в последний час — посекундно; встреча — «идёт», задача — «просрочено на …».
 * kind: 'task' | 'meeting'; until — ISO-время; end — конец встречи.
 */
function countdown(until, { kind = 'task', end = null } = {}) {
  const el = h('span', { class: 'countdown', role: 'timer' });
  el._until = Date.parse(until);
  el._end = end ? Date.parse(end) : null;
  el._kind = kind;
  tickTimer(el);
  timers.add(el);
  timerLoop ??= setInterval(() => {
    for (const t of timers) (t.isConnected ? tickTimer(t) : timers.delete(t));
    if (!timers.size) {
      clearInterval(timerLoop);
      timerLoop = null;
    }
  }, 1000);
  return el;
}
/** Срок задачи по Москве в ISO: без времени — до конца дня. */
const taskDeadline = (t) => (t.due ? `${t.due}T${t.due_time ?? '23:59'}:00+03:00` : null);

/** Кнопки в строке таблицы: скопировать и удалить. Щелчок по ним не открывает строку. */
function rowActions({ name, onCopy, onDelete, deleteTitle = 'Удалить', deleteIcon = 'trash' }) {
  const btn = (title, iconName, fn, cls = '') =>
    h('button', {
      type: 'button', class: `icon-btn row-btn ${cls}`, title, 'aria-label': `${title}: ${name}`,
      onclick: async (e) => {
        e.stopPropagation();
        const b = e.currentTarget;
        b.disabled = true;
        try {
          await fn();
        } catch (err) {
          toast(err.message);
        } finally {
          b.disabled = false;
        }
      },
    }, icon(iconName));
  return h('td', { class: 'row-btns' }, h('div', {}, onCopy ? btn('Скопировать', 'copy', onCopy) : null, onDelete ? btn(deleteTitle, deleteIcon, onDelete, 'danger') : null));
}

/** Кружок сотрудника: фото профиля, если загружено, иначе инициалы. */
function userAvatar(u, cls = '') {
  const ver = u?.id != null ? ctx.avatars?.[u.id] : null;
  if (!ver) return h('span', { class: `avatar ${cls}`, title: u?.name ?? null }, initials(u?.name));
  const img = h('img', { class: `avatar avatar-img ${cls}`, src: `/admin/api/users/${u.id}/avatar?v=${ver}`, alt: '', title: u.name ?? null, loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: `avatar ${cls}` }, initials(u.name))), { once: true });
  return img;
}

const THEMES = [
  ['light', 'Светлая тема'],
  ['dark', 'Тёмная тема'],
  ['system', 'Как в системе'],
];
/** Личные настройки внешнего вида: применяются сразу, сохраняются в профиле на сервере. */
async function savePrefs(patch) {
  const next = { ...(ctx.me?.prefs ?? window.sorokaTheme?.prefs() ?? {}), ...patch };
  window.sorokaTheme?.apply(next);
  if (ctx.me) ctx.me.prefs = next;
  try {
    const { prefs } = await api('/admin/api/me/prefs', { method: 'PATCH', body: patch });
    if (ctx.me) ctx.me.prefs = prefs;
    return prefs;
  } catch (err) {
    if (err.status !== 401) toast(err.message);
    return null;
  }
}

function themeSwitch() {
  const current = window.sorokaTheme?.get() ?? 'system';
  const buttons = THEMES.map(([id, label]) =>
    h('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(id === current), dataset: { theme: id } }, icon(id)),
  );
  const box = h('div', { class: 'theme-switch', role: 'group', 'aria-label': 'Тема оформления' }, buttons);
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    savePrefs({ theme: btn.dataset.theme });
    for (const b of buttons) b.setAttribute('aria-pressed', String(b === btn));
  });
  return box;
}

function meLink(current) {
  return h(
    'a',
    { class: 'me-link', href: '#/account', title: 'Учётная запись', 'aria-current': current ? 'page' : null },
    userAvatar(ctx.me),
    h('span', { class: 'me-text' }, h('span', { class: 'name' }, ctx.me.name), ctx.me.position ? h('span', { class: 'me-pos' }, ctx.me.position) : null),
  );
}
// После правки своих данных — обновить имя и должность в боковой панели
function refreshMe() {
  const el = document.querySelector('.sidebar .me-link');
  el?.replaceWith(meLink(el.getAttribute('aria-current') === 'page'));
}

// Разделы меню по умолчанию. Свой порядок и спрятанные разделы каждый задаёт шестерёнкой под меню
// (настройка nav: «home,tasks,-templates»; минус — раздел спрятан; новые разделы встают в конец).
const NAV = [
  ['home', 'Главная'],
  ['news', 'Новости'],
  ['chat', 'Сообщения'],
  ['docs', 'Документы'],
  ['templates', 'Шаблоны'],
  ['plans', 'Медиапланы'],
  ['tasks', 'Задачи'],
  ['calendar', 'Календарь'],
  ['leads', 'Квалификатор'],
  ['kb', 'Регламенты'],
  ['staff', 'Сотрудники'],
];
function navItems(pref = ctx.me.prefs?.nav ?? '') {
  const known = new Map(NAV.filter(([id]) => id !== 'staff' || ctx.me.role === 'admin').map(([id, label]) => [id, label]));
  const out = [];
  for (const raw of String(pref).split(',').map((x) => x.trim()).filter(Boolean)) {
    const hidden = raw.startsWith('-');
    const id = hidden ? raw.slice(1) : raw;
    if (!known.has(id) || out.some((it) => it.id === id)) continue;
    out.push({ id, label: known.get(id), hidden });
  }
  for (const [id, label] of known) if (!out.some((it) => it.id === id)) out.push({ id, label, hidden: false });
  return out;
}

function navDialog() {
  let items = navItems();
  const list = h('ul', { class: 'nav-edit' });
  const draw = () =>
    fill(
      list,
      items.map((it, i) =>
        h(
          'li',
          { class: it.hidden ? 'is-hidden' : '' },
          h('span', { class: 'nav-edit-icon' }, icon(it.id)),
          h('span', { class: 'nav-edit-label' }, it.label),
          h('button', { type: 'button', class: 'icon-btn', title: 'Выше', 'aria-label': `${it.label}: выше`, disabled: i === 0, onclick: () => move(i, -1) }, icon('up')),
          h('button', { type: 'button', class: 'icon-btn', title: 'Ниже', 'aria-label': `${it.label}: ниже`, disabled: i === items.length - 1, onclick: () => move(i, 1) }, icon('down')),
          h('label', { class: 'switch', title: it.hidden ? 'Показать в меню' : 'Спрятать из меню' }, h('input', { type: 'checkbox', checked: !it.hidden, 'aria-label': `Показывать «${it.label}»`, onchange: (e) => ((it.hidden = !e.target.checked), draw()) }), h('span', {})),
        ),
      ),
    );
  const move = (i, d) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    items = next;
    draw();
    list.children[i + d]?.querySelector(d < 0 ? 'button[title="Выше"]' : 'button[title="Ниже"]')?.focus();
  };
  draw();
  formDialog({
    title: 'Меню',
    submitLabel: 'Сохранить',
    body: [
      h('p', { class: 'muted' }, 'Порядок разделов и что показывать. Спрятанный раздел остаётся доступен по ссылке; вернуть его можно здесь же.'),
      list,
      h('button', { type: 'button', class: 'linkish small', onclick: () => ((items = navItems('')), draw()) }, 'Вернуть как было'),
    ],
    onSubmit: async () => {
      if (items.every((it) => it.hidden)) throw new Error('Оставьте в меню хотя бы один раздел');
      const def = navItems('');
      const same = items.every((it, i) => it.id === def[i].id && !it.hidden);
      await savePrefs({ nav: same ? '' : items.map((it) => (it.hidden ? `-${it.id}` : it.id)).join(',') });
      renderRoute();
    },
  });
}

function shell(active, content) {
  const section =
    PAGE_SECTION[active] ?? Object.keys(SECTION_TABS).find((k) => SECTION_TABS[k].some(([id]) => id === active)) ?? active;
  // вкладки только для администратора (брошенные диалоги — переписка без согласия)
  const ADMIN_TABS = new Set(['abandoned']);
  const tabs = SECTION_TABS[section] && !PAGE_SECTION[active] ? SECTION_TABS[section].filter(([id]) => ctx.me.role === 'admin' || !ADMIN_TABS.has(id)) : null;
  const nav = navItems().filter((it) => !it.hidden).map((it) => [it.id, it.label]);
  return [
    h(
      'aside',
      // В редакторах документа и медиаплана панель сворачивается до значков — больше места под работу
      { class: `sidebar${active === 'doc' || active === 'plan' ? ' compact' : ''}` },
      h('div', { class: 'side-head' }, h('a', { class: 'brand', href: '#/home' }, logo(), h('span', { class: 'product' }, 'Ассистент')), bellButton()),
      h(
        'nav',
        { class: 'nav', 'aria-label': 'Разделы' },
        nav.map(([id, label]) =>
          h('a', { href: `#/${id}`, title: label, 'aria-current': id === section ? 'page' : null }, icon(id), h('span', { class: 'nav-label' }, label)),
        ),
        h('button', { type: 'button', class: 'nav-gear', title: 'Настроить меню', 'aria-label': 'Настроить меню: порядок и видимость разделов', onclick: navDialog }, icon('gear')),
      ),
      assistantEntry(),
      h(
        'div',
        { class: 'side-foot' },
        themeSwitch(),
        h(
          'div',
          { class: 'me' },
          meLink(active === 'account' || active === 'appearance' || active === 'notify-settings'),
          h('button', { type: 'button', class: 'logout', title: 'Выйти', 'aria-label': 'Выйти', onclick: logout }, icon('logout')),
        ),
      ),
    ),
    h(
      'div',
      { class: 'workspace' },
      tabs
        ? h(
            'nav',
            { class: 'subnav', 'aria-label': nav.find(([id]) => id === section)?.[1] },
            tabs.map(([id, label]) => h('a', { href: `#/${id}`, 'aria-current': id === active ? 'page' : null }, label)),
          )
        : null,
      h('main', { class: `page${['doc', 'plan', 'tasks', 'board'].includes(active) ? ' page-wide' : ''}`, id: 'main' }, content),
    ),
  ];
}

function renderRoute() {
  const { name, params } = currentRoute();
  closeDrawer();
  const lead = params.get('lead');
  params.delete('lead');
  renderedKey = `${name}?${params}`;
  routes[name](params);
  if (lead) openLead(Number(lead));
  // счётчик новых записей у пункта «Новости» (в самой ленте он обнуляется)
  if (name !== 'news') setTimeout(() => refreshNewsBadge(), 0);
  setTimeout(() => refreshChatBadge(), 0);
}

async function logout() {
  await api('/admin/api/logout', { method: 'POST', body: {} }).catch(() => {});
  ctx.me = null;
  renderLogin();
}

// ---------- вход ----------

async function renderLogin() {
  ctx.me = null;
  const methods = await fetch('/admin/api/auth').then((r) => r.json()).catch(() => ({ yandex: false }));
  const error = new URLSearchParams(location.search).get('error');
  const errorEl = h('p', { class: 'error', role: 'alert', hidden: !error }, error ?? '');
  const email = h('input', { class: 'input', id: 'login', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const password = h('input', { class: 'input', id: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Войти');

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          await api('/admin/api/login', { method: 'POST', body: { login: email.value, password: password.value } });
          history.replaceState(null, '', '/admin/' + location.hash);
          await boot();
        } catch (err) {
          errorEl.textContent = err.status === 429 ? 'Слишком много попыток. Подождите 15 минут.' : err.message;
          errorEl.hidden = false;
          submit.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'login' }, 'Логин'), email),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Пароль'), password),
    submit,
  );

  app.replaceChildren(
    h(
      'main',
      { class: 'login' },
      h(
        'div',
        { class: 'login-card' },
        h('div', { class: 'login-mark' }, logo()),
        h('h1', {}, 'Ассистент агентства'),
        h('p', {}, 'Презентации, КП и отчёты в фирменном стиле, заявки с сайта.'),
        errorEl,
        methods.yandex
          ? [
              h('a', { class: 'btn-yandex', href: '/admin/auth/yandex' }, h('span', { class: 'ya', 'aria-hidden': 'true' }, 'Я'), 'Войти с Яндекс ID'),
              h('div', { class: 'or' }, 'или по паролю'),
            ]
          : null,
        form,
      ),
    ),
  );
}

// ---------- фильтры ----------

function readFilters(params) {
  const period = params.get('period') ?? '30';
  const f = {
    period,
    rating: params.get('rating') ?? '',
    status: params.get('status') ?? '',
    channel: params.get('channel') ?? '',
    q: params.get('q') ?? '',
    test: params.get('test') === '1',
    page: Number(params.get('page') || 1),
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
  if (period !== 'custom' && period !== 'all') {
    f.from = mskDaysAgo(Number(period) - 1);
    f.to = mskToday();
  } else if (period === 'all') {
    f.from = '';
    f.to = '';
  }
  return f;
}

function apiQuery(f, { withPage = true } = {}) {
  const q = new URLSearchParams();
  if (f.rating) q.set('rating', f.rating);
  if (f.status) q.set('status', f.status);
  if (f.channel) q.set('channel', f.channel);
  if (f.q) q.set('q', f.q);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.test) q.set('test', '1');
  if (withPage && f.page > 1) q.set('page', String(f.page));
  return q;
}

function routeQuery(f) {
  const q = apiQuery(f);
  q.delete('from');
  q.delete('to');
  if (f.period !== '30') q.set('period', f.period);
  if (f.period === 'custom') {
    if (f.from) q.set('from', f.from);
    if (f.to) q.set('to', f.to);
  }
  return q;
}

/**
 * Фильтры на телефоне: поиск на виду, остальное — под кнопкой «Фильтры» (с числом выбранных),
 * чтобы список не начинался со второго экрана. На компьютере кнопки нет, всё в одну строку.
 */
export function collapsibleFilters(search, rest, active = 0) {
  const more = h('div', { class: 'filters-more' }, rest);
  const toggle = h('button', {
    type: 'button', class: 'btn filters-toggle', 'aria-expanded': 'false',
    onclick: () => {
      const bar = toggle.parentElement;
      const open = !bar.classList.contains('open');
      bar.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    },
  }, 'Фильтры', active ? h('span', { class: 'filters-count' }, String(active)) : null);
  return [search, toggle, more];
}

function filterBar(route, f, { rating = true, status = true, search = true } = {}) {
  const update = (patch) => navigate(route, routeQuery({ ...f, ...patch, page: 1 }));
  let timer;

  const ratings = new Set(f.rating ? f.rating.split(',') : []);
  const ratingButtons = h(
    'div',
    { class: 'rating-filter', role: 'group', 'aria-label': 'Уровень' },
    ['5', '4', '3', '2', '1'].map((r) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(ratings.has(r)),
          title: `Уровень ${letter(r)}`,
          onclick: () => {
            ratings.has(r) ? ratings.delete(r) : ratings.add(r);
            update({ rating: [...ratings].sort().reverse().join(',') });
          },
        },
        letter(r),
      ),
    ),
  );

  const periodSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Период', onchange: (e) => update({ period: e.target.value, from: mskDaysAgo(29), to: mskToday() }) },
    PERIODS.map(([v, label]) => h('option', { value: v, selected: v === f.period }, label)),
  );

  const active = [f.period !== '30', f.rating, f.status, f.channel, f.test].filter(Boolean).length;
  return h(
    'div',
    { class: 'filters collapsible' },
    ...collapsibleFilters(search
      ? h('input', {
          class: 'input', type: 'search', placeholder: 'Компания, контакт, № лида', value: f.q, 'aria-label': 'Поиск',
          oninput: (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => update({ q: e.target.value.trim() }), 400);
          },
        })
      : null, [
    periodSelect,
    f.period === 'custom'
      ? [
          h('input', { class: 'input date', type: 'date', value: f.from, 'aria-label': 'С', onchange: (e) => update({ from: e.target.value }) }),
          h('input', { class: 'input date', type: 'date', value: f.to, 'aria-label': 'По', onchange: (e) => update({ to: e.target.value }) }),
        ]
      : null,
    rating ? ratingButtons : null,
    status
      ? h(
          'select',
          { class: 'select', 'aria-label': 'Статус', onchange: (e) => update({ status: e.target.value }) },
          h('option', { value: '' }, 'Все статусы'),
          Object.entries(ctx.statuses).map(([v, label]) => h('option', { value: v, selected: v === f.status }, label)),
        )
      : null,
    h(
      'select',
      { class: 'select', 'aria-label': 'Канал', onchange: (e) => update({ channel: e.target.value }) },
      h('option', { value: '' }, 'Все каналы'),
      Object.entries(CHANNELS).map(([v, label]) => h('option', { value: v, selected: v === f.channel }, label)),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: f.test, onchange: (e) => update({ test: e.target.checked }) }),
      'Тестовые',
    ),
    ], active),
  );
}

// ---------- лиды ----------

async function renderLeads(params) {
  const f = readFilters(params);
  const tbody = h('tbody');
  const count = h('span', { class: 'count num' });
  const pager = h('div', { class: 'pager' });
  const csv = h('a', { class: 'btn', href: `/admin/api/leads.csv?${apiQuery(f, { withPage: false })}`, download: '' }, 'Выгрузить в Excel');

  app.replaceChildren(
    ...shell('leads', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Лиды'), count, h('span', { class: 'spacer' }), csv),
      filterBar('leads', f),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'leads' },
          h(
            'thead',
            {},
            h('tr', {}, ['№', 'Когда', 'Уровень', 'Компания и задача', 'Услуга', 'Бюджет', 'Канал', 'Статус', 'Ответственный'].map((t) => h('th', { scope: 'col' }, t))),
          ),
          tbody,
        ),
      ),
      pager,
    ]),
  );

  let data;
  try {
    data = await api(`/admin/api/leads?${apiQuery(f)}`);
  } catch (err) {
    if (err.status !== 401) tbody.replaceChildren(h('tr', {}, h('td', { colspan: 9, class: 'empty' }, err.message)));
    return;
  }
  count.textContent = `${data.total} ${plural(data.total, 'лид', 'лида', 'лидов')}`;

  if (!data.leads.length) {
    tbody.replaceChildren(
      h(
        'tr',
        {},
        h(
          'td',
          { colspan: 9, class: 'empty' },
          h('strong', {}, f.q || f.rating || f.status || f.channel ? 'Под фильтр ничего не попало' : 'Лидов за этот период нет'),
          f.test ? 'Пройдите тестовый опрос в разделе «Тест».' : 'Измените период или сбросьте фильтры.',
        ),
      ),
    );
    return;
  }

  tbody.replaceChildren(
    ...data.leads.map((l) => {
      const open = () => openLead(l.id, true);
      return h(
        'tr',
        { class: l.rating >= 4 ? 'hot' : '', onclick: open },
        h('td', { class: 'id num' }, h('a', { class: 'row-link', href: `#/leads?lead=${l.id}`, onclick: (e) => { e.preventDefault(); open(); } }, `#${l.id}`)),
        h('td', { class: 'num nowrap' }, fmtDateTime(l.created_at)),
        h('td', {}, meter(l.rating)),
        h('td', {}, h('span', { class: 'company' }, l.answers.company ?? '—', l.is_test ? ' ' : null, l.is_test ? h('span', { class: 'badge-test' }, 'тест') : null), h('span', { class: 'task' }, l.answers.task ?? '')),
        h('td', { class: 'c-service' }, answerText('service', l.answers.service)),
        h('td', { class: 'num c-budget' }, answerText('budget', l.answers.budget)),
        h('td', { class: 'c-channel' }, CHANNELS[l.channel] ?? l.channel),
        h('td', {}, statusChip(l.status)),
        h('td', {}, l.assignee ?? h('span', { class: 'muted' }, '—')),
      );
    }),
  );

  const pages = Math.ceil(data.total / data.pageSize);
  if (pages > 1) {
    pager.replaceChildren(
      h('button', { class: 'btn', disabled: f.page <= 1, onclick: () => navigate('leads', routeQuery({ ...f, page: f.page - 1 })) }, 'Назад'),
      h('span', { class: 'num' }, `${f.page} из ${pages}`),
      h('button', { class: 'btn', disabled: f.page >= pages, onclick: () => navigate('leads', routeQuery({ ...f, page: f.page + 1 })) }, 'Дальше'),
    );
  }
}

// ---------- воронка (канбан) ----------

async function renderBoard(params) {
  const f = readFilters(params);
  const board = h('div', { class: 'board' });
  app.replaceChildren(
    ...shell('board', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Воронка'), h('span', { class: 'count' }, 'Перетащите карточку, чтобы сменить статус')),
      filterBar('board', f, { status: false }),
      board,
    ]),
  );

  let data;
  try {
    data = await api(`/admin/api/board?${apiQuery(f, { withPage: false })}`);
  } catch {
    return;
  }

  const columns = {};
  for (const [status, label] of Object.entries(ctx.statuses)) {
    const cards = h('div', { class: 'cards' });
    const counter = h('span', { class: 'num' });
    const col = h('section', { class: 'column', 'aria-label': label, dataset: { status } }, h('header', {}, label, counter), cards);
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drop-target');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop-target');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const card = board.querySelector(`[data-id="${id}"]`);
      if (!card || card.parentElement === cards) return;
      const from = card.parentElement;
      cards.prepend(card);
      recount();
      try {
        await api(`/admin/api/leads/${id}`, { method: 'PATCH', body: { status } });
        toast(`Лид #${id}: ${label}`);
      } catch (err) {
        from.prepend(card);
        recount();
        toast(err.message);
      }
    });
    columns[status] = { cards, counter };
    board.append(col);
  }

  function recount() {
    for (const { cards, counter } of Object.values(columns)) counter.textContent = cards.children.length;
  }

  for (const l of data.leads) {
    const card = h(
      'button',
      {
        type: 'button', class: `card${l.rating >= 4 ? ' hot' : ''}`, draggable: 'true', dataset: { id: String(l.id) },
        onclick: () => openLead(l.id, true),
        ondragstart: (e) => {
          e.dataTransfer.setData('text/plain', String(l.id));
          card.classList.add('dragging');
        },
        ondragend: () => card.classList.remove('dragging'),
      },
      h('span', { class: 'row' }, meter(l.rating), h('span', { class: 'num' }, `#${l.id} · ${fmtDateTime(l.created_at)}`)),
      h('span', { class: 'company' }, l.answers.company ?? '—'),
      h('span', { class: 'row' }, answerText('service', l.answers.service), h('span', { class: 'num' }, answerText('budget', l.answers.budget))),
      l.assignee ? h('span', { class: 'row' }, l.assignee) : null,
    );
    (columns[l.status] ?? columns.new).cards.append(card);
  }
  recount();
}

// ---------- карточка лида ----------

let drawerEls = null;
let returnFocus = null;

function closeDrawer() {
  if (!drawerEls) return;
  drawerEls.forEach((el) => el.remove());
  drawerEls = null;
  document.removeEventListener('keydown', onDrawerKey);
  returnFocus?.focus?.();
}

function onDrawerKey(e) {
  if (e.key === 'Escape') dismissLead();
}

function dismissLead() {
  const { name, params } = currentRoute();
  if (params.has('lead')) {
    params.delete('lead');
    navigate(name, params);
  } else {
    closeDrawer();
  }
}

async function openLead(id, pushRoute = false) {
  if (pushRoute) {
    returnFocus = document.activeElement;
    const { name, params } = currentRoute();
    params.set('lead', String(id));
    navigate(name, params);
    return;
  }
  closeDrawer();
  const body = h('div', { class: 'drawer-body' }, h('p', { class: 'muted' }, 'Загружаю…'));
  const title = h('h2', { id: 'drawer-title' }, `Лид #${id}`);
  const closeBtn = h('button', { type: 'button', class: 'close', 'aria-label': 'Закрыть', onclick: dismissLead }, '×');
  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' }, h('div', { class: 'drawer-head' }, title, closeBtn), body);
  const scrim = h('div', { class: 'scrim', onclick: dismissLead });
  document.body.append(scrim, drawer);
  drawerEls = [scrim, drawer];
  document.addEventListener('keydown', onDrawerKey);
  closeBtn.focus();

  try {
    const { lead, events } = await api(`/admin/api/leads/${id}`);
    fillLead(body, title, lead, events);
  } catch (err) {
    body.replaceChildren(h('p', { class: 'error' }, err.message));
  }
}

const POTENTIAL = { high: 'высокий', medium: 'средний', low: 'низкий' };
/** Сводка ИИ по заявке: кто клиент, потенциал, комментарий менеджеру; «Обновить» — составить заново. */
function leadSummary(lead, onUpdate) {
  const s = lead.ai_summary;
  if (!s && !ctx.aiSummary) return null;
  const btn = h('button', {
    type: 'button', class: 'btn btn-s',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Составляю…';
      try {
        onUpdate(await api(`/admin/api/leads/${lead.id}/summary`, { method: 'POST' }));
        toast('Сводка обновлена');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = s ? 'Обновить' : 'Составить сводку';
      }
    },
  }, s ? 'Обновить' : 'Составить сводку');
  return h(
    'section',
    { class: 'ai-summary', 'aria-label': 'Сводка ИИ' },
    h('div', { class: 'ai-summary-head' },
      h('h3', {}, 'Сводка ИИ'),
      s ? h('span', { class: `potential p-${s.potential}` }, `Потенциал: ${POTENTIAL[s.potential] ?? s.potential}`) : null,
      h('span', { class: 'spacer' }),
      ctx.aiSummary ? btn : null),
    s
      ? [
          s.about ? h('p', {}, s.about) : null,
          s.why ? h('p', { class: 'muted' }, s.why) : null,
          s.comment ? h('p', { class: 'ai-comment' }, s.comment) : null,
          h('p', { class: 'hint' }, 'Составлено ИИ по ответам клиента — проверьте перед звонком.'),
        ].filter(Boolean)
      : h('p', { class: 'muted' }, 'Сводки пока нет.'),
  );
}

function fillLead(body, title, lead, events) {
  title.replaceChildren(`Лид #${lead.id}`, ...(lead.is_test ? [' ', h('span', { class: 'badge-test' }, 'тест')] : []));

  const status = h('select', { class: 'select', id: 'f-status' }, Object.entries(ctx.statuses).map(([v, label]) => h('option', { value: v, selected: v === lead.status }, label)));
  const assignee = h('input', { class: 'input', id: 'f-assignee', value: lead.assignee ?? '', placeholder: '@username или имя', maxlength: 100 });
  const comment = h('textarea', { class: 'textarea', id: 'f-comment', maxlength: 5000, placeholder: 'Договорённости, следующий шаг' }, lead.comment ?? '');
  // уровень квалификации можно поменять вручную; причина — в историю
  const level = h('select', { class: 'select', id: 'f-level' }, LEVELS.map(([v, label]) => h('option', { value: String(v), selected: v === lead.rating }, label)));
  const levelReason = h('input', { class: 'input', id: 'f-level-reason', maxlength: 500, placeholder: 'Например: созвонились — бюджет 2 млн, решение принимает сам' });
  const reasonField = h('div', { class: 'field full', hidden: true }, h('label', { for: 'f-level-reason' }, 'Почему меняете уровень'), levelReason);
  level.addEventListener('change', () => { reasonField.hidden = Number(level.value) === lead.rating; });
  const saved = h('span', { class: 'saved', role: 'status' });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Сохранить');
  const takeMine = h('button', { type: 'button', class: 'btn', onclick: () => { assignee.value = ctx.me.name; if (status.value === 'new') status.value = 'in_work'; } }, 'Взять себе');

  const form = h(
    'form',
    {
      class: 'work',
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        saved.textContent = '';
        try {
          const patch = {};
          if (status.value !== lead.status) patch.status = status.value;
          if ((assignee.value.trim() || null) !== lead.assignee) patch.assignee = assignee.value;
          if ((comment.value || null) !== lead.comment) patch.comment = comment.value || null;
          if (Number(level.value) !== lead.rating) {
            patch.rating = Number(level.value);
            patch.rating_reason = levelReason.value.trim() || null;
          }
          if (!Object.keys(patch).length) {
            saved.textContent = 'Изменений нет';
            return;
          }
          const res = await api(`/admin/api/leads/${lead.id}`, { method: 'PATCH', body: patch });
          fillLead(body, title, res.lead, res.events);
          toast('Сохранено');
          if (currentRoute().name !== 'stats') routes[currentRoute().name](currentRoute().params);
        } catch (err) {
          saved.textContent = err.message;
        } finally {
          save.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'f-status' }, 'Статус'), status),
    h('div', { class: 'field' }, h('label', { for: 'f-assignee' }, 'Ответственный'), assignee),
    h('div', { class: 'field full' }, h('label', { for: 'f-level' }, 'Уровень квалификации'), level),
    reasonField,
    h('div', { class: 'field full' }, h('label', { for: 'f-comment' }, 'Комментарий'), comment),
    h('div', { class: 'work-actions' }, save, takeMine, saved),
  );

  // диалог с ИИ: суть задачи и список услуг — первыми, затем ответы по полям сценария
  const EXTRA = { summary: 'Суть задачи', proposal_request: 'Ждёт от нас', famous_brand: 'Известный бренд (оценка ИИ)', budget_rub: 'Бюджет в месяц (назвал клиент)', services: 'Услуги', clarification: 'Уточнение клиента', criteria_text: 'Главное в выборе (своими словами)', price: 'Предварительная стоимость (названа клиенту)' };
  const extra = Object.entries(EXTRA)
    .filter(([k]) => lead.answers[k] != null)
    .map(([k, label]) => [h('dt', {}, label), h('dd', {}, k === 'services' ? lead.answers.services.map((v) => answerText('service', v)).join(', ') : k === 'budget_rub' ? `${Number(lead.answers[k]).toLocaleString('ru-RU')} ₽` : String(lead.answers[k]))]);
  const answers = [
    ...extra,
    ...ctx.scenario.steps
      .filter((st) => st.type !== 'consent' && st.id in lead.answers)
      .map((st) => [h('dt', {}, st.label ?? st.id), h('dd', {}, answerText(st.id, lead.answers[st.id]))]),
  ];
  const dialog = lead.meta?.dialog?.length
    ? h('section', {}, h('h3', {}, 'Диалог с клиентом'), h('div', { class: 'lead-dialog' }, lead.meta.dialog.map((m) => h('p', { class: `ld-${m.from === 'user' ? 'user' : 'bot'}` }, m.text))))
    : null;

  const meta = lead.meta ?? {};
  const source = [
    ['Канал', CHANNELS[lead.channel] ?? lead.channel],
    meta.telegram ? ['Telegram', meta.telegram.username ? `@${meta.telegram.username}` : meta.telegram.name] : null,
    meta.page ? ['Страница', meta.page] : null,
    meta.referrer ? ['Откуда пришёл', meta.referrer] : null,
    meta.utm && Object.keys(meta.utm).length ? ['UTM', Object.entries(meta.utm).map(([k, v]) => `${k}=${v}`).join('\n')] : null,
    ['Создан', fmtDateTime(lead.created_at)],
  ].filter(Boolean);

  // уровень меняли вручную — показываем, кто и почему, и какой была оценка бота
  const manual = [...events].reverse().find((e) => e.type === 'rating');
  const autoRating = events.find((e) => e.type === 'created')?.data?.rating ?? events.find((e) => e.type === 'rating')?.data?.from;

  // пустые блоки (нет тегов, нет диалога) не выводим: replaceChildren превратил бы null в текст
  body.replaceChildren(...[
    h(
      'section',
      { class: 'score', 'aria-label': 'Оценка' },
      meter(lead.rating, true),
      h('div', {},
        manual ? h('p', { class: 'level-manual' }, `Уровень изменён вручную: ${manual.actor}${manual.data.reason ? ` — ${manual.data.reason}` : ''}. Оценка бота — ${letter(autoRating)}, по ответам:`) : null,
        h('ul', {}, lead.reasons.map((r) => h('li', {}, r)))),
    ),
    lead.tags.length ? h('div', {}, lead.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
    leadSummary(lead, (res) => fillLead(body, title, res.lead, res.events)),
    form,
    leadClient(lead),
    leadDocuments(lead),
    h('section', {}, h('h3', {}, 'Ответы'), h('dl', { class: 'answers' }, answers)),
    dialog,
    h('section', {}, h('h3', {}, 'Источник'), h('dl', { class: 'answers' }, source.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    h(
      'section',
      {},
      h('h3', {}, 'История'),
      h(
        'ol',
        { class: 'timeline' },
        [...events].reverse().map((e) => h('li', {}, h('time', {}, fmtDateTime(e.at)), h('span', {}, `${(EVENT_TEXT[e.type] ?? (() => e.type))(e, ctx)} · ${e.actor}`))),
      ),
    ),
  ].filter(Boolean));
}

// ---------- сводка ----------

async function renderStats(params) {
  const f = readFilters(params);
  const content = h('div', {}, h('p', { class: 'muted' }, 'Считаю…'));
  app.replaceChildren(...shell('stats', [h('div', { class: 'page-head' }, h('h1', {}, 'Сводка')), filterBar('stats', f, { rating: false, status: false, search: false }), content]));

  let st;
  try {
    st = await api(`/admin/api/stats?${apiQuery(f, { withPage: false })}`);
  } catch {
    return;
  }

  const total = st.byDay.reduce((n, r) => n + r.n, 0);
  const hot = st.byDay.filter((r) => r.rating >= 4).reduce((n, r) => n + r.n, 0);
  const { started, completed, dropped } = st.funnel;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

  const byRating = [5, 4, 3, 2, 1].map((r) => ({ label: `Уровень ${letter(r)}`, value: st.byDay.filter((x) => x.rating === r).reduce((n, x) => n + x.n, 0), cls: `r${r}` }));
  const byStatus = Object.entries(ctx.statuses).map(([k, label]) => ({ label, value: st.byStatus.find((x) => x.status === k)?.n ?? 0 }));
  const dropOff = st.funnel.dropOff.map((d) => ({ label: stepOf(d.step)?.label ?? d.step ?? 'Не начали', value: d.n }));

  content.replaceChildren(
    h(
      'div',
      { class: 'kpis' },
      kpi(total, plural(total, 'лид за период', 'лида за период', 'лидов за период')),
      kpi(pct(hot, total), `горячих (уровни A–B): ${hot}`),
      kpi(pct(completed, started), `дошли до конца опроса: ${completed} из ${started}`),
      kpi(dropped, `${plural(dropped, 'ушёл', 'ушли', 'ушли')} посреди опроса`),
    ),
    h(
      'div',
      { class: 'charts' },
      h('section', { class: 'panel wide' }, h('h2', {}, 'Лиды по дням'), h('p', { class: 'sub' }, 'Столбец разбит по уровням A–E; наведите на день, чтобы увидеть цифры'), dailyChart(st.byDay, f)),
      h('section', { class: 'panel' }, h('h2', {}, 'Где уходят из опроса'), h('p', { class: 'sub' }, 'Последний вопрос, на котором остановились. Кандидаты на упрощение'), dropOff.length ? hbars(dropOff) : h('p', { class: 'muted' }, 'Пока никто не бросил опрос')),
      h('section', { class: 'panel' }, h('h2', {}, 'Уровни'), h('p', { class: 'sub' }, 'Сколько лидов каждого уровня'), hbars(byRating)),
      h('section', { class: 'panel' }, h('h2', {}, 'Статусы'), h('p', { class: 'sub' }, 'Где сейчас лиды за период'), hbars(byStatus)),
    ),
  );
}

const kpi = (value, label) => h('div', { class: 'kpi' }, h('div', { class: 'value' }, value), h('div', { class: 'label' }, label));

let tooltip;
function showTip(e, title, rows) {
  tooltip ??= document.body.appendChild(h('div', { class: 'tooltip', role: 'tooltip' }));
  tooltip.replaceChildren(h('b', {}, title), ...rows.map(([k, v]) => h('div', { class: 't-row' }, h('span', {}, k), h('span', {}, v))));
  tooltip.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - tooltip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, innerHeight - tooltip.offsetHeight - 8);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
const hideTip = () => tooltip && (tooltip.hidden = true);

/** Столбцы по дням, разбитые по рейтингу. */
function dailyChart(rows, f) {
  // Все дни периода, включая пустые — иначе тренд читается неверно
  const days = [];
  const first = f.from || rows[0]?.day;
  const last = f.to || rows.at(-1)?.day;
  if (first && last) {
    for (let d = new Date(`${first}T12:00:00Z`); d <= new Date(`${last}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
  }
  if (!days.length) return h('p', { class: 'muted' }, 'За период лидов нет');

  const data = days.map((day) => {
    const byR = [1, 2, 3, 4, 5].map((r) => rows.filter((x) => x.day === day && x.rating === r).reduce((n, x) => n + x.n, 0));
    return { day, byR, total: byR.reduce((a, b) => a + b, 0) };
  });
  const max = Math.max(1, ...data.map((d) => d.total));
  const ticks = niceTicks(max);
  const W = 900, H = 240, L = 32, B = 24, T = 8;
  const plotW = W - L, plotH = H - B - T;
  const step = plotW / data.length;
  // Тонкие столбцы: не больше 60% шага и не шире 18px
  const barW = Math.max(3, Math.min(18, step * 0.6));
  const y = (v) => T + plotH - (v / ticks.at(-1)) * plotH;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Лиды по дням, всего ${data.reduce((n, d) => n + d.total, 0)}` });
  svg.append(s('g', { class: 'grid' }, ticks.map((t) => s('line', { x1: L, x2: W, y1: y(t), y2: y(t) }))));
  svg.append(s('g', { class: 'axis' }, ticks.map((t) => s('text', { x: L - 6, y: y(t) + 4, 'text-anchor': 'end' }, t))));
  const labelEvery = Math.ceil(data.length / 10);
  data.forEach((d, i) => {
    const x = L + i * step + (step - barW) / 2;
    const g = s('g', { class: 'col' });
    g.append(s('rect', { class: 'hl', x: L + i * step, y: T, width: step, height: plotH, fill: 'transparent' }));
    let acc = 0;
    d.byR.forEach((n, r) => {
      if (!n) return;
      const top = y(acc + n);
      const hgt = y(acc) - top;
      // 2px зазор между сегментами; скругление только у верхнего сегмента
      const isTop = d.byR.slice(r + 1).every((v) => !v);
      g.append(s('rect', { class: `r${r + 1}`, x, y: top, width: barW, height: Math.max(0, hgt - (acc ? 2 : 0)), rx: isTop ? 3 : 0 }));
      acc += n;
    });
    if (i % labelEvery === 0) svg.append(s('text', { class: 'axis-x', x: x + barW / 2, y: H - 6, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 11, opacity: 0.7 }, fmtDay(d.day)));
    g.addEventListener('mousemove', (e) => showTip(e, fmtDay(d.day), [['Всего', d.total], ...[5, 4, 3, 2, 1].filter((r) => d.byR[r - 1]).map((r) => [`Уровень ${letter(r)}`, d.byR[r - 1]])]));
    g.addEventListener('mouseleave', hideTip);
    svg.append(g);
  });

  const legend = h('div', { class: 'legend', 'aria-hidden': 'true' }, [5, 4, 3, 2, 1].map((r) => h('span', {}, h('i', { class: `r${r}` }), `Уровень ${letter(r)}`)));
  const table = h(
    'details',
    { class: 'table-view' },
    h('summary', {}, 'Показать таблицей'),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'День'), h('th', {}, 'Всего'), [5, 4, 3, 2, 1].map((r) => h('th', {}, `Р${r}`)))),
      h('tbody', {}, data.filter((d) => d.total).map((d) => h('tr', {}, h('td', {}, fmtDay(d.day)), h('td', {}, d.total), [5, 4, 3, 2, 1].map((r) => h('td', {}, d.byR[r - 1]))))),
    ),
  );
  return h('div', { class: 'chart' }, legend, svg, table);
}

/** Горизонтальные столбцы с подписями значений (HTML — подписи не масштабируются вместе с графиком). */
function hbars(items) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h(
    'div',
    { class: 'hbars', role: 'list' },
    items.map((it) => {
      const fill = h('span', { class: `hbar-fill ${it.cls ?? 'bar'}` });
      // ширина задаётся через CSSOM — inline-стили запрещены политикой безопасности
      fill.style.width = it.value ? `max(4px, ${(it.value / max) * 100}%)` : '0';
      return h(
        'div',
        { class: 'hbar', role: 'listitem', title: `${it.label}: ${it.value}` },
        h('span', { class: 'hbar-label' }, it.label),
        h('span', { class: 'hbar-track' }, fill),
        h('span', { class: 'hbar-value num' }, it.value),
      );
    }),
  );
}

function niceTicks(max) {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? mag * 10;
  const stepInt = Math.max(1, Math.round(step));
  const ticks = [];
  for (let t = 0; t <= max + stepInt - 1; t += stepInt) ticks.push(t);
  if (ticks.at(-1) < max) ticks.push(ticks.at(-1) + stepInt);
  return ticks;
}

// ---------- сотрудники (только администратор) ----------

/** Пароль показывается один раз: блок с кнопкой «Скопировать». */
function passwordNotice(login, password, note) {
  const copy = h('button', { type: 'button', class: 'btn', onclick: async () => {
    try {
      await navigator.clipboard.writeText(`Логин: ${login}\nПароль: ${password}\nВход: ${location.origin}/admin/`);
      copy.textContent = 'Скопировано';
    } catch {
      copy.textContent = 'Выделите и скопируйте вручную';
    }
  } }, 'Скопировать логин и пароль');
  return h(
    'div',
    { class: 'secret', role: 'status' },
    h('p', {}, note),
    h('dl', {}, h('dt', {}, 'Логин'), h('dd', { class: 'mono' }, login), h('dt', {}, 'Пароль'), h('dd', { class: 'mono' }, password)),
    h('p', { class: 'muted' }, 'Пароль больше нигде не показывается. Если потеряется — сбросьте и выдайте новый.'),
    copy,
  );
}

/** Карточка сотрудника: имя, логин, должность, телефон. */
function editUser(u, self, onSaved = () => renderStaff()) {
  const field = (id, label, value, attrs = {}) => {
    const input = h('input', { class: 'input', id, value: value ?? '', maxlength: 100, ...attrs });
    return [input, h('div', { class: 'field' }, h('label', { for: id }, label), input)];
  };
  const [name, nameF] = field('u-name', 'Имя и фамилия', u.name, { required: true });
  const [loginI, loginF] = field('u-login', 'Логин для входа', u.login, { required: true, maxlength: 64, autocapitalize: 'none', spellcheck: 'false' });
  const [position, positionF] = field('u-position', 'Должность', u.position, { placeholder: 'Аккаунт-менеджер' });
  const [phone, phoneF] = field('u-phone', 'Телефон', u.phone, { type: 'tel', maxlength: 40 });
  formDialog({
    title: `Сотрудник: ${u.name}`,
    submitLabel: 'Сохранить',
    body: [nameF, loginF, h('p', { class: 'hint' }, 'Логин — латиница или почта. Пароль при смене логина не меняется.'), positionF, phoneF],
    onSubmit: async () => {
      const { user } = await api(`/admin/api/users/${u.id}`, {
        method: 'PATCH',
        body: { name: name.value.trim(), login: loginI.value.trim(), position: position.value.trim() || null, phone: phone.value.trim() || null },
      });
      if (self) {
        Object.assign(ctx.me, { name: user.name, login: user.login, position: user.position });
        refreshMe();
      }
      toast('Данные сотрудника сохранены');
      onSaved();
    },
  });
}

async function renderStaff() {
  if (ctx.me.role !== 'admin') return navigate('docs');
  const notice = h('div');
  const tbody = h('tbody');
  const login = h('input', { class: 'input', id: 'new-login', required: true, maxlength: 64, autocapitalize: 'none', spellcheck: 'false', placeholder: 'anna или anna@soroka-marketing.ru' });
  const name = h('input', { class: 'input', id: 'new-name', maxlength: 100, placeholder: 'Анна Иванова' });
  const role = h('select', { class: 'select', id: 'new-role' }, Object.entries(ctx.roles).map(([v, label]) => h('option', { value: v, selected: v === 'manager' }, label)));
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Создать доступ');

  const form = h(
    'form',
    {
      class: 'panel staff-form',
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          const res = await api('/admin/api/users', { method: 'POST', body: { login: login.value.trim(), name: name.value.trim(), role: role.value } });
          notice.replaceChildren(passwordNotice(res.user.login, res.password, `Доступ для «${res.user.name}» создан.`));
          form.reset();
          load();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('h2', {}, 'Новый сотрудник'),
    h('div', { class: 'staff-fields' },
      h('div', { class: 'field' }, h('label', { for: 'new-login' }, 'Логин'), login),
      h('div', { class: 'field' }, h('label', { for: 'new-name' }, 'Имя'), name),
      h('div', { class: 'field' }, h('label', { for: 'new-role' }, 'Роль'), role),
    ),
    error,
    h('div', { class: 'work-actions' }, submit, h('span', { class: 'muted' }, 'Пароль сгенерируется автоматически')),
  );

  app.replaceChildren(
    ...shell('staff', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Сотрудники')),
      notice,
      form,
      h('div', { class: 'table-wrap' },
        h('table', { class: 'staff' },
          h('thead', {}, h('tr', {}, ['Логин', 'Имя', 'Роль', 'Доступ', 'Добавлен', ''].map((t) => h('th', { scope: 'col' }, t)))),
          tbody,
        ),
      ),
    ]),
  );

  async function load() {
    let data;
    try {
      data = await api('/admin/api/users');
    } catch {
      return;
    }
    tbody.replaceChildren(
      ...data.users.map((u) => {
        const self = u.id === ctx.me.id;
        const act = async (fn) => {
          try {
            await fn();
            load();
          } catch (err) {
            toast(err.message);
          }
        };
        const roleSelect = h('select', {
          class: 'select', 'aria-label': `Роль ${u.login}`, disabled: self,
          onchange: (e) => act(() => api(`/admin/api/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } })),
        }, Object.entries(ctx.roles).map(([v, label]) => h('option', { value: v, selected: v === u.role }, label)));
        return h(
          'tr',
          { class: u.disabled ? 'disabled' : '' },
          h('td', { class: 'mono' }, u.login, self ? h('span', { class: 'muted' }, ' (вы)') : null),
          h('td', {}, h('strong', {}, u.name), u.position ? h('span', { class: 'task' }, u.position) : null, u.phone ? h('span', { class: 'task num' }, u.phone) : null),
          h('td', {}, roleSelect),
          h('td', {}, u.disabled ? h('span', { class: 'status', dataset: { s: 'lost' } }, 'Отключён') : h('span', { class: 'status', dataset: { s: 'won' } }, 'Активен')),
          h('td', { class: 'num nowrap' }, fmtDateTime(u.created_at)),
          h('td', { class: 'row-actions' },
            h('button', { type: 'button', class: 'btn', onclick: () => editUser(u, self) }, 'Изменить'),
            h('button', {
              type: 'button', class: 'btn',
              onclick: async () => {
                if (!(await confirmDialog(`Сбросить пароль ${u.login}? Старый перестанет работать, сотрудник выйдет со всех устройств.`))) return;
                act(async () => {
                  const res = await api(`/admin/api/users/${u.id}/reset-password`, { method: 'POST', body: {} });
                  notice.replaceChildren(passwordNotice(u.login, res.password, `Новый пароль для «${u.name}».`));
                  scrollTo({ top: 0 });
                });
              },
            }, 'Сбросить пароль'),
            self ? null : h('button', {
              type: 'button', class: 'btn',
              onclick: () => act(() => api(`/admin/api/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } })),
            }, u.disabled ? 'Включить' : 'Отключить'),
            u.disabled && !self
              ? h('button', {
                  type: 'button', class: 'btn',
                  onclick: async () => {
                    if (!(await confirmDialog(`Удалить ${u.login} насовсем? Если за сотрудником есть задачи или встречи, удалить не получится — тогда оставьте его отключённым.`))) return;
                    act(async () => {
                      await api(`/admin/api/users/${u.id}`, { method: 'DELETE' });
                      toast('Сотрудник удалён');
                    });
                  },
                }, 'Удалить')
              : null,
          ),
        );
      }),
    );
  }
  load();
}

// ---------- мой пароль ----------

// ---------- внешний вид кабинета ----------

const APPEARANCE = {
  theme: [
    ['light', 'Светлая'],
    ['dark', 'Тёмная'],
    ['system', 'Как в системе'],
  ],
  accent: [
    ['soroka', 'Фирменный бирюзовый'],
    ['blue', 'Синий'],
    ['violet', 'Фиолетовый'],
    ['green', 'Зелёный'],
    ['orange', 'Оранжевый'],
    ['pink', 'Розовый'],
    ['graphite', 'Графит'],
  ],
  background: [
    ['none', 'Без фона'],
    ['mist', 'Дымка'],
    ['aurora', 'Сияние'],
    ['sunset', 'Закат'],
    ['night', 'Ночь'],
    ['paper', 'Точки'],
  ],
  density: [
    ['comfortable', 'Обычная', 'Больше воздуха, крупнее элементы'],
    ['compact', 'Компактная', 'Больше задач и строк на экране'],
  ],
  sidebar: [
    ['full', 'С подписями', 'Значки и названия разделов'],
    ['icons', 'Только значки', 'Узкая панель — больше места под работу'],
  ],
  start: [
    ['home', 'Главная'],
    ['news', 'Новости'],
    ['docs', 'Документы'],
    ['tasks', 'Задачи — проекты'],
    ['mytasks', 'Мои задачи'],
    ['calendar', 'Календарь'],
    ['plans', 'Медиапланы'],
    ['leads', 'Квалификатор'],
  ],
};

function renderAppearance() {
  const prefs = { ...(ctx.me.prefs ?? {}) };
  const saved = h('span', { class: 'save-state', role: 'status' });
  const set = async (patch) => {
    Object.assign(prefs, patch);
    saved.textContent = 'Сохраняю…';
    const ok = await savePrefs(patch);
    saved.textContent = ok ? 'Сохранено' : '';
    draw();
  };
  const body = h('div', { class: 'appearance' });
  const tiles = (key, options, cls = '') =>
    h(
      'div',
      { class: `opt-tiles ${cls}`, role: 'radiogroup', 'aria-label': key },
      options.map(([v, label, hint]) =>
        h(
          'button',
          { type: 'button', class: `opt-tile opt-${key}-${v}`, role: 'radio', 'aria-checked': String(prefs[key] === v), onclick: () => set({ [key]: v }) },
          h('span', { class: `opt-preview pv-${key} pv-${v}`, 'aria-hidden': 'true' }),
          h('span', { class: 'opt-label' }, label),
          hint ? h('span', { class: 'opt-hint' }, hint) : null,
        ),
      ),
    );
  const ownPhoto = () => {
    const m = /^media:(\d+)$/.exec(prefs.background ?? '');
    return h(
      'div',
      { class: 'own-bg' },
      h('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
          const item = await pickMedia();
          if (item) set({ background: `media:${item.id}` });
        },
      }, m ? 'Выбрать другое фото' : 'Своё фото из медиатеки'),
      m ? h('span', { class: 'muted small' }, 'Сейчас фоном — ваше фото') : h('span', { class: 'muted small' }, 'Подойдёт спокойный снимок без мелкого текста: поверх него ляжет полупрозрачная подложка.'),
    );
  };
  function draw() {
    fill(
      body,
      h('section', { class: 'panel' }, h('h2', {}, 'Тема'), tiles('theme', APPEARANCE.theme, 'tiles-3')),
      h('section', { class: 'panel' }, h('h2', {}, 'Цвет акцента'), h('p', { class: 'sub' }, 'Кнопки, выделение, активный раздел. Документы и презентации остаются в фирменных цветах.'), tiles('accent', APPEARANCE.accent, 'tiles-swatch')),
      h('section', { class: 'panel' }, h('h2', {}, 'Фон кабинета'), tiles('background', APPEARANCE.background, 'tiles-bg'), ownPhoto()),
      h('section', { class: 'panel' }, h('h2', {}, 'Плотность'), tiles('density', APPEARANCE.density, 'tiles-2')),
      h('section', { class: 'panel' }, h('h2', {}, 'Боковая панель'), tiles('sidebar', APPEARANCE.sidebar, 'tiles-2')),
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'Ассистент'),
        h('p', { class: 'sub' }, 'Как его зовут и как он к вам обращается.'),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'pf-name' }, 'Имя ассистента'),
          h('input', {
            class: 'input', id: 'pf-name', maxlength: 24, value: prefs.assistantName ?? '', placeholder: 'Ассистент',
            onchange: (e) => {
              const v = e.target.value.trim();
              if (v && !/^[A-Za-zА-Яа-яЁё0-9 .-]{1,24}$/.test(v)) return toast('Имя — до 24 букв и цифр');
              set({ assistantName: v });
            },
          }),
        ),
        tiles('address', [['vy', 'На «вы»'], ['ty', 'На «ты»']], 'tiles-2 tiles-plain'),
        h('label', { class: 'check pf-search' }, h('input', { type: 'checkbox', checked: prefs.webSearch !== 'off', onchange: (e) => set({ webSearch: e.target.checked ? 'on' : 'off' }) }), 'Искать в интернете, когда нужны свежие данные'),
      ),
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'Стартовый раздел'),
        h('p', { class: 'sub' }, 'Что открывается после входа.'),
        h('select', { class: 'select', 'aria-label': 'Стартовый раздел', onchange: (e) => set({ start: e.target.value }) }, APPEARANCE.start.map(([v, l]) => h('option', { value: v, selected: prefs.start === v }, l))),
      ),
    );
  }
  draw();
  app.replaceChildren(
    ...shell('appearance', [
      h(
        'div',
        { class: 'page-head' },
        h('h1', {}, 'Внешний вид'),
        saved,
        h('span', { class: 'spacer' }),
        h('button', {
          type: 'button', class: 'btn',
          onclick: () => set({ theme: 'system', accent: 'soroka', background: 'none', density: 'comfortable', sidebar: 'full', start: 'home', assistantName: '', nav: '', address: 'vy', webSearch: 'on' }),
        }, 'Вернуть как было'),
      ),
      h('p', { class: 'lead-text' }, 'Настройки только ваши: коллеги их не видят. Они сохраняются в профиле и действуют на любом устройстве, где вы вошли.'),
      body,
    ]),
  );
}

/**
 * Фото профиля. Браузер сам разворачивает снимок по EXIF, вырезает квадрат по центру и сжимает
 * до 256×256 JPEG — на сервер уходит около 20 КБ, а не исходные мегабайты с телефона.
 */
async function squareAvatar(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Не получилось открыть файл — нужна картинка JPG, PNG или WebP');
  }
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Не удалось подготовить фото'))), 'image/jpeg', 0.88));
}

function avatarPicker() {
  const box = h('div', { class: 'avatar-picker' });
  const file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic', hidden: true, onchange: (e) => upload(e.target.files?.[0]) });
  const apply = (ver) => {
    if (ver) ctx.avatars[ctx.me.id] = ver;
    else delete ctx.avatars[ctx.me.id];
    ctx.me.avatar = ver;
    refreshMe();
    draw();
  };
  async function upload(f) {
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) return toast('Файл больше 25 МБ');
    try {
      const blob = await squareAvatar(f);
      const res = await fetch('/admin/api/me/avatar', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: blob, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Не удалось загрузить фото');
      apply(data.avatar);
      toast('Фото обновлено');
    } catch (err) {
      toast(err.message);
    } finally {
      file.value = '';
    }
  }
  const draw = () =>
    fill(
      box,
      userAvatar(ctx.me, 'avatar-xl'),
      h(
        'div',
        { class: 'avatar-actions' },
        h('button', { type: 'button', class: 'btn btn-s', onclick: () => file.click() }, ctx.avatars?.[ctx.me.id] ? 'Сменить фото' : 'Загрузить фото'),
        ctx.avatars?.[ctx.me.id]
          ? h('button', {
              type: 'button', class: 'linkish small',
              onclick: async () => {
                try {
                  await api('/admin/api/me/avatar', { method: 'DELETE' });
                  apply(null);
                } catch (err) {
                  toast(err.message);
                }
              },
            }, 'Убрать')
          : null,
        h('span', { class: 'hint' }, 'Квадратом по центру, JPG, PNG или WebP. Видно коллегам в задачах и меню.'),
      ),
      file,
    );
  draw();
  return box;
}

function renderAccount() {
  const nameInput = h('input', { class: 'input', id: 'my-name', value: ctx.me.name, maxlength: 100, required: true });
  const positionInput = h('input', { class: 'input', id: 'my-position', value: ctx.me.position ?? '', maxlength: 100, placeholder: 'Аккаунт-менеджер' });
  const phoneInput = h('input', { class: 'input', id: 'my-phone', type: 'tel', value: ctx.me.phone ?? '', maxlength: 40 });
  const nameMsg = h('p', { role: 'status' });
  const nameForm = h(
    'form',
    {
      class: 'panel account-form',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { user } = await api('/admin/api/me', {
            method: 'PATCH',
            body: { name: nameInput.value.trim(), position: positionInput.value.trim() || null, phone: phoneInput.value.trim() || null },
          });
          Object.assign(ctx.me, { name: user.name, position: user.position, phone: user.phone });
          refreshMe();
          nameMsg.className = 'saved';
          nameMsg.textContent = 'Сохранено';
        } catch (err) {
          nameMsg.className = 'error';
          nameMsg.textContent = err.message;
        }
      },
    },
    h('h2', {}, 'Мои данные'),
    h('p', { class: 'muted' }, 'Видны коллегам в задачах, встречах и документах.'),
    avatarPicker(),
    h('div', { class: 'field' }, h('label', { for: 'my-name' }, 'Имя и фамилия'), nameInput),
    h('div', { class: 'field' }, h('label', { for: 'my-position' }, 'Должность'), positionInput),
    h('div', { class: 'field' }, h('label', { for: 'my-phone' }, 'Телефон'), phoneInput),
    nameMsg,
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Сохранить'),
  );
  const current = h('input', { class: 'input', id: 'cur', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', id: 'next', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const repeat = h('input', { class: 'input', id: 'repeat', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const msg = h('p', { role: 'status' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Сменить пароль');
  const form = h(
    'form',
    {
      class: 'panel account-form',
      onsubmit: async (e) => {
        e.preventDefault();
        msg.className = 'error';
        if (next.value !== repeat.value) return (msg.textContent = 'Новые пароли не совпадают');
        submit.disabled = true;
        try {
          await api('/admin/api/me/password', { method: 'POST', body: { current: current.value, next: next.value } });
          form.reset();
          msg.className = 'saved';
          msg.textContent = 'Пароль изменён. На других устройствах нужно войти заново.';
        } catch (err) {
          msg.textContent = err.status === 429 ? 'Слишком много попыток. Подождите 15 минут.' : err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('h2', {}, 'Мой пароль'),
    h('p', { class: 'muted' }, `Логин: ${ctx.me.login}`),
    h('div', { class: 'field' }, h('label', { for: 'cur' }, 'Текущий пароль'), current),
    h('div', { class: 'field' }, h('label', { for: 'next' }, 'Новый пароль, минимум 10 символов'), next),
    h('div', { class: 'field' }, h('label', { for: 'repeat' }, 'Новый пароль ещё раз'), repeat),
    msg,
    submit,
  );
  app.replaceChildren(...shell('account', [h('div', { class: 'page-head' }, h('h1', {}, 'Учётная запись')), nameForm, notificationsPanel(), form]));
}

// ---------- тестовый режим ----------

function renderTest() {
  app.replaceChildren(
    ...shell('test', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Тестовый режим')),
      h(
        'div',
        { class: 'test-grid' },
        h(
          'section',
          { class: 'panel' },
          h('h2', {}, 'Опрос на сайте'),
          h('p', {}, 'Откроется демо-страница с виджетом. Пройдите опрос как клиент.'),
          h('a', { class: 'btn btn-primary', href: ctx.links.widgetTest, target: '_blank', rel: 'noopener' }, 'Открыть виджет'),
        ),
        h(
          'section',
          { class: 'panel' },
          h('h2', {}, 'Опрос в Telegram'),
          ctx.links.telegramTest
            ? [h('p', {}, 'Бот начнёт тестовый опрос. Можно проверить и «Поделиться номером».'), h('a', { class: 'btn btn-primary', href: ctx.links.telegramTest, target: '_blank', rel: 'noopener' }, 'Открыть бота')]
            : h('p', {}, 'Бот ещё не подключён: нужен TELEGRAM_BOT_TOKEN в настройках сервера.'),
        ),
        h(
          'section',
          { class: 'panel' },
          h('h2', {}, 'Результаты'),
          h('p', {}, 'Тестовые лиды видны в списке с отметкой «тест» и не смешиваются с рабочими.'),
          h('a', { class: 'btn', href: '#/leads?test=1&period=all' }, 'Показать тестовые лиды'),
        ),
      ),
      h(
        'p',
        { class: 'note' },
        ctx.testChat
          ? 'Карточки тестовых лидов приходят в тестовый чат Telegram, а не менеджерам. В CRM они не отправляются.'
          : 'Тестовые лиды не отправляются менеджерам и в CRM. Чтобы видеть их карточки в Telegram, задайте TELEGRAM_TEST_CHAT_ID.',
      ),
    ]),
  );
}

// ---------- логотип ----------
// Оригинальный утверждённый файл (brand/assets/logo → admin/brand/logo.png при npm run brand:sync).
// Если файла нет — текстовая подпись; знак не рисуем.

function logo() {
  const img = h('img', { class: 'brand-logo', src: 'brand/logo.png', alt: 'SOROKA — агентство интернет-маркетинга' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'wordmark' }, 'SOROKA MARKETING')), { once: true });
  return img;
}

export { h, api, app, shell, toast, confirmDialog, suggestInput, countdown, taskDeadline, navigate, fmtDateTime, plural, ctx, icon, userAvatar, initials, rowActions, answerText, renderRoute as rerender };

boot();
