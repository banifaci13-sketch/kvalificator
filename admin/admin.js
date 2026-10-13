// Админка ассистента агентства. Без сборки и зависимостей: модули ES, DOM строится через h(),
// пользовательские данные выводятся только как текст (никакого innerHTML с данными).

import { renderDocs, renderDoc, renderTemplates, leadDocuments, formDialog } from './docs.js';
import { renderPlans, renderPlan, renderBenchmarks } from './mediaplans.js';
import { renderBoards, renderTaskBoard, renderMyTasks, renderClients, renderClient, leadClient } from './tasks.js';
import { renderCalendar, notificationsPanel } from './calendar.js';
import { renderIntegrations } from './integrations.js';

const app = document.getElementById('app');
const TZ = 'Europe/Moscow';
const CHANNELS = { web: 'Сайт', telegram: 'Telegram', max: 'MAX' };
const EVENT_TEXT = {
  created: (e) => `Лид создан, рейтинг ${e.data.rating}`,
  status: (e, ctx) => `Статус: ${ctx.statuses[e.data.from] ?? e.data.from ?? '—'} → ${ctx.statuses[e.data.to] ?? e.data.to}`,
  assignee: (e) => (e.data.to ? `Ответственный: ${e.data.to}` : 'Ответственный снят'),
  comment: (e) => (e.data.text ? `Комментарий: ${e.data.text}` : 'Комментарий удалён'),
};
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

function toast(text) {
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
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
    { class: `meter${large ? ' meter-lg' : ''}`, dataset: { r: String(rating) }, title: `Рейтинг ${rating} из 5` },
    h('span', { class: 'meter-bars', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= rating ? 'on' : '' }))),
    h('b', {}, rating),
    h('span', { class: 'sr-only' }, ' из 5'),
  );
}

const statusChip = (status) => h('span', { class: 'status', dataset: { s: status } }, status === 'won' ? '✓ ' : '', ctx.statuses[status] ?? status);

// ---------- маршруты ----------

const routes = {
  docs: renderDocs,
  doc: renderDoc,
  templates: renderTemplates,
  plans: renderPlans,
  plan: renderPlan,
  benchmarks: renderBenchmarks,
  tasks: renderBoards,
  taskboard: renderTaskBoard,
  mytasks: renderMyTasks,
  clients: renderClients,
  client: renderClient,
  calendar: renderCalendar,
  integrations: renderIntegrations,
  leads: renderLeads,
  board: renderBoard,
  stats: renderStats,
  test: renderTest,
  staff: renderStaff,
  account: renderAccount,
};
// Разделы со своими вкладками: ключ — первая вкладка (на неё ведёт пункт меню)
const SECTION_TABS = {
  leads: [
    ['leads', 'Лиды'],
    ['board', 'Воронка'],
    ['stats', 'Сводка'],
    ['test', 'Тест'],
  ],
  plans: [
    ['plans', 'Медиапланы'],
    ['benchmarks', 'Нормативы'],
  ],
  staff: [
    ['staff', 'Сотрудники'],
    ['integrations', 'Подключения'],
  ],
  tasks: [
    ['tasks', 'Доски'],
    ['mytasks', 'Мои задачи'],
    ['clients', 'Клиенты'],
  ],
};
// Страницы внутри раздела без своей вкладки
const PAGE_SECTION = { doc: 'docs', plan: 'plans', client: 'tasks', taskboard: 'tasks' };

function currentRoute() {
  const [name, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { name: routes[name] ? name : 'docs', params: new URLSearchParams(query) };
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
    Object.assign(ctx, { me: me.user, roles: me.roles, statuses: me.statuses, scenario: me.scenario, links: me.links, testChat: me.testChat });
    renderRoute();
  } catch (err) {
    if (err.status !== 401) app.replaceChildren(h('p', { class: 'page error' }, err.message));
  }
}

// Значки разделов: простые контуры 24×24, цвет берут от текста
const ICONS = {
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
};
function icon(name) {
  return s('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, s('path', { d: ICONS[name] }));
}
function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

const THEMES = [
  ['light', 'Светлая тема'],
  ['dark', 'Тёмная тема'],
  ['system', 'Как в системе'],
];
function themeSwitch() {
  const current = window.sorokaTheme?.get() ?? 'system';
  const buttons = THEMES.map(([id, label]) =>
    h('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(id === current), dataset: { theme: id } }, icon(id)),
  );
  const box = h('div', { class: 'theme-switch', role: 'group', 'aria-label': 'Тема оформления' }, buttons);
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    window.sorokaTheme?.set(btn.dataset.theme);
    for (const b of buttons) b.setAttribute('aria-pressed', String(b === btn));
  });
  return box;
}

function meLink(current) {
  return h(
    'a',
    { class: 'me-link', href: '#/account', title: 'Учётная запись', 'aria-current': current ? 'page' : null },
    h('span', { class: 'avatar' }, initials(ctx.me.name)),
    h('span', { class: 'me-text' }, h('span', { class: 'name' }, ctx.me.name), ctx.me.position ? h('span', { class: 'me-pos' }, ctx.me.position) : null),
  );
}
// После правки своих данных — обновить имя и должность в боковой панели
function refreshMe() {
  const el = document.querySelector('.sidebar .me-link');
  el?.replaceWith(meLink(el.getAttribute('aria-current') === 'page'));
}

function shell(active, content) {
  const section =
    PAGE_SECTION[active] ?? Object.keys(SECTION_TABS).find((k) => SECTION_TABS[k].some(([id]) => id === active)) ?? active;
  const tabs = SECTION_TABS[section] && !PAGE_SECTION[active] ? SECTION_TABS[section] : null;
  const nav = [
    ['docs', 'Документы'],
    ['templates', 'Шаблоны'],
    ['plans', 'Медиапланы'],
    ['tasks', 'Задачи'],
    ['calendar', 'Календарь'],
    ['leads', 'Квалификатор'],
    ctx.me.role === 'admin' ? ['staff', 'Сотрудники'] : null,
  ].filter(Boolean);
  return [
    h(
      'aside',
      // В редакторах документа и медиаплана панель сворачивается до значков — больше места под работу
      { class: `sidebar${active === 'doc' || active === 'plan' ? ' compact' : ''}` },
      h('a', { class: 'brand', href: '#/docs' }, logo(), h('span', { class: 'product' }, 'Ассистент')),
      h(
        'nav',
        { class: 'nav', 'aria-label': 'Разделы' },
        nav.map(([id, label]) =>
          h('a', { href: `#/${id}`, title: label, 'aria-current': id === section ? 'page' : null }, icon(id), h('span', { class: 'nav-label' }, label)),
        ),
      ),
      h(
        'div',
        { class: 'side-foot' },
        themeSwitch(),
        h(
          'div',
          { class: 'me' },
          meLink(active === 'account'),
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
      h('main', { class: `page${active === 'doc' || active === 'plan' ? ' page-wide' : ''}`, id: 'main' }, content),
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

function filterBar(route, f, { rating = true, status = true, search = true } = {}) {
  const update = (patch) => navigate(route, routeQuery({ ...f, ...patch, page: 1 }));
  let timer;

  const ratings = new Set(f.rating ? f.rating.split(',') : []);
  const ratingButtons = h(
    'div',
    { class: 'rating-filter', role: 'group', 'aria-label': 'Рейтинг' },
    ['5', '4', '3', '2', '1'].map((r) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(ratings.has(r)),
          title: `Рейтинг ${r}`,
          onclick: () => {
            ratings.has(r) ? ratings.delete(r) : ratings.add(r);
            update({ rating: [...ratings].sort().reverse().join(',') });
          },
        },
        r,
      ),
    ),
  );

  const periodSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Период', onchange: (e) => update({ period: e.target.value, from: mskDaysAgo(29), to: mskToday() }) },
    PERIODS.map(([v, label]) => h('option', { value: v, selected: v === f.period }, label)),
  );

  return h(
    'div',
    { class: 'filters' },
    search
      ? h('input', {
          class: 'input', type: 'search', placeholder: 'Компания, контакт, № лида', value: f.q, 'aria-label': 'Поиск',
          oninput: (e) => {
            clearTimeout(timer);
            timer = setTimeout(() => update({ q: e.target.value.trim() }), 400);
          },
        })
      : null,
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
            h('tr', {}, ['№', 'Когда', 'Рейтинг', 'Компания и задача', 'Услуга', 'Бюджет', 'Канал', 'Статус', 'Ответственный'].map((t) => h('th', { scope: 'col' }, t))),
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

function fillLead(body, title, lead, events) {
  title.replaceChildren(`Лид #${lead.id}`, ...(lead.is_test ? [' ', h('span', { class: 'badge-test' }, 'тест')] : []));

  const status = h('select', { class: 'select', id: 'f-status' }, Object.entries(ctx.statuses).map(([v, label]) => h('option', { value: v, selected: v === lead.status }, label)));
  const assignee = h('input', { class: 'input', id: 'f-assignee', value: lead.assignee ?? '', placeholder: '@username или имя', maxlength: 100 });
  const comment = h('textarea', { class: 'textarea', id: 'f-comment', maxlength: 5000, placeholder: 'Договорённости, следующий шаг' }, lead.comment ?? '');
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
    h('div', { class: 'field full' }, h('label', { for: 'f-comment' }, 'Комментарий'), comment),
    h('div', { class: 'work-actions' }, save, takeMine, saved),
  );

  const answers = ctx.scenario.steps
    .filter((st) => st.type !== 'consent' && st.id in lead.answers)
    .map((st) => [h('dt', {}, st.label ?? st.id), h('dd', {}, answerText(st.id, lead.answers[st.id]))]);

  const meta = lead.meta ?? {};
  const source = [
    ['Канал', CHANNELS[lead.channel] ?? lead.channel],
    meta.telegram ? ['Telegram', meta.telegram.username ? `@${meta.telegram.username}` : meta.telegram.name] : null,
    meta.page ? ['Страница', meta.page] : null,
    meta.referrer ? ['Откуда пришёл', meta.referrer] : null,
    meta.utm && Object.keys(meta.utm).length ? ['UTM', Object.entries(meta.utm).map(([k, v]) => `${k}=${v}`).join('\n')] : null,
    ['Создан', fmtDateTime(lead.created_at)],
  ].filter(Boolean);

  body.replaceChildren(
    h(
      'section',
      { class: 'score', 'aria-label': 'Оценка' },
      meter(lead.rating, true),
      h('div', {}, h('ul', {}, lead.reasons.map((r) => h('li', {}, r)))),
    ),
    lead.tags.length ? h('div', {}, lead.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
    form,
    leadClient(lead),
    leadDocuments(lead),
    h('section', {}, h('h3', {}, 'Ответы'), h('dl', { class: 'answers' }, answers)),
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
  );
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

  const byRating = [5, 4, 3, 2, 1].map((r) => ({ label: `Рейтинг ${r}`, value: st.byDay.filter((x) => x.rating === r).reduce((n, x) => n + x.n, 0), cls: `r${r}` }));
  const byStatus = Object.entries(ctx.statuses).map(([k, label]) => ({ label, value: st.byStatus.find((x) => x.status === k)?.n ?? 0 }));
  const dropOff = st.funnel.dropOff.map((d) => ({ label: stepOf(d.step)?.label ?? d.step ?? 'Не начали', value: d.n }));

  content.replaceChildren(
    h(
      'div',
      { class: 'kpis' },
      kpi(total, plural(total, 'лид за период', 'лида за период', 'лидов за период')),
      kpi(pct(hot, total), `горячих (рейтинг 4–5): ${hot}`),
      kpi(pct(completed, started), `дошли до конца опроса: ${completed} из ${started}`),
      kpi(dropped, `${plural(dropped, 'ушёл', 'ушли', 'ушли')} посреди опроса`),
    ),
    h(
      'div',
      { class: 'charts' },
      h('section', { class: 'panel wide' }, h('h2', {}, 'Лиды по дням'), h('p', { class: 'sub' }, 'Столбец разбит по рейтингу; наведите на день, чтобы увидеть цифры'), dailyChart(st.byDay, f)),
      h('section', { class: 'panel' }, h('h2', {}, 'Где уходят из опроса'), h('p', { class: 'sub' }, 'Последний вопрос, на котором остановились. Кандидаты на упрощение'), dropOff.length ? hbars(dropOff) : h('p', { class: 'muted' }, 'Пока никто не бросил опрос')),
      h('section', { class: 'panel' }, h('h2', {}, 'Рейтинг'), h('p', { class: 'sub' }, 'Сколько лидов каждого рейтинга'), hbars(byRating)),
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
    g.addEventListener('mousemove', (e) => showTip(e, fmtDay(d.day), [['Всего', d.total], ...[5, 4, 3, 2, 1].filter((r) => d.byR[r - 1]).map((r) => [`Рейтинг ${r}`, d.byR[r - 1]])]));
    g.addEventListener('mouseleave', hideTip);
    svg.append(g);
  });

  const legend = h('div', { class: 'legend', 'aria-hidden': 'true' }, [5, 4, 3, 2, 1].map((r) => h('span', {}, h('i', { class: `r${r}` }), `Рейтинг ${r}`)));
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
              onclick: () => {
                if (!confirm(`Сбросить пароль ${u.login}? Старый перестанет работать, сотрудник выйдет со всех устройств.`)) return;
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
                  onclick: () => {
                    if (!confirm(`Удалить ${u.login} насовсем? Если за сотрудником есть задачи или встречи, удалить не получится — тогда оставьте его отключённым.`)) return;
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

// ---------- подпись бренда ----------
// Оригинальный логотип ещё не утверждён — по брендбуку ставим текстовую подпись, знак не рисуем.

function logo() {
  return h('span', { class: 'wordmark' }, 'SOROKA MARKETING');
}

export { h, api, app, shell, toast, navigate, fmtDateTime, plural, ctx };

boot();
