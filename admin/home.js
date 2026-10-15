// «Главная»: сводка дня одним экраном — что горит, какие встречи, новые заявки, уведомления,
// с чем работали недавно и что поручили коллегам. Администратор видит ещё нагрузку команды.

import { h, api, app, shell, toast, navigate, fmtDateTime, plural, ctx, icon, userAvatar, countdown, taskDeadline } from './admin.js';
import { fill } from './docs.js';
import { watchNotifications, permissionBanner } from './notify.js';
import { openTask, doneToggle, dueText, dueState, PRIORITY } from './tasks.js';
import { openMeeting } from './calendar.js';

const TZ = 'Europe/Moscow';
const CHANNELS = { web: 'Сайт', telegram: 'Telegram', max: 'MAX' };
const taskHref = (t) => `#/tasks?project=${t.client_id ?? 'none'}&task=${t.id}`;

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (hour < 5) return 'Доброй ночи';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] ?? '';
const longDate = () => {
  const s = new Date().toLocaleDateString('ru-RU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  return s[0].toUpperCase() + s.slice(1);
};
const timeOf = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));

function card(title, { action = null, cls = '' } = {}, ...body) {
  return h('section', { class: `panel home-card ${cls}` }, h('div', { class: 'home-card-head' }, h('h2', {}, title), h('span', { class: 'spacer' }), action), ...body);
}
const quiet = (text) => h('p', { class: 'home-quiet' }, text);

export async function renderHome() {
  const body = h('div', { class: 'home' }, h('p', { class: 'muted' }, 'Загружаю…'));
  fill(app, shell('home', body));
  async function load() {
    let d;
    try {
      d = await api('/admin/api/home');
    } catch (err) {
      if (err.status !== 401) fill(body, h('p', { class: 'error' }, err.message));
      return;
    }
    fill(body, permissionBanner(), hero(d), stats(d), h('div', { class: 'home-grid' }, h('div', { class: 'home-col' }, hot(d, load), week(d, load), delegated(d), team(d)), h('div', { class: 'home-col' }, moneyCard(d), newsCard(d), meetings(d, load), leads(d), notifications(d), recent(d))));
  }
  await load();
}

function hero(d) {
  const todayMeetings = d.stats.meetings;
  const parts = [];
  if (todayMeetings) parts.push(`${todayMeetings} ${plural(todayMeetings, 'встреча', 'встречи', 'встреч')}`);
  const dueToday = d.tasks.today.length;
  if (dueToday) parts.push(`${dueToday} ${plural(dueToday, 'задача', 'задачи', 'задач')} на сегодня`);
  let line = parts.length ? `Сегодня ${parts.join(' и ')}.` : 'На сегодня ничего срочного — хороший день, чтобы разобрать хвосты.';
  if (d.stats.overdue) line += ` Просрочено: ${d.stats.overdue}.`;
  const quick = (label, onclick, iconName) => h('button', { type: 'button', class: 'btn home-quick', onclick }, icon(iconName), label);
  return h(
    'section',
    { class: 'home-hero' },
    h('div', { class: 'home-hello' }, h('p', { class: 'home-date' }, longDate()), h('h1', {}, `${greeting()}, ${firstName(ctx.me.name)}`), h('p', { class: 'home-line' }, line)),
    h(
      'div',
      { class: 'home-actions' },
      quick('Задача', () => openTask(null, { defaults: { assignee_id: ctx.me.id }, onChange: () => navigate('home') }), 'tasks'),
      quick('Встреча', () => navigate('calendar', new URLSearchParams({ new: '1' })), 'calendar'),
      quick('Документ', () => navigate('docs', new URLSearchParams({ new: '1' })), 'docs'),
      quick('Медиаплан', () => navigate('plans', new URLSearchParams({ new: '1' })), 'plans'),
    ),
  );
}

function stats(d) {
  const tile = (value, label, href, tone = '') => h('a', { class: `home-stat ${tone}`, href }, h('b', { class: 'num' }, value), h('span', {}, label));
  return h(
    'div',
    { class: 'home-stats' },
    tile(d.stats.open, plural(d.stats.open, 'открытая задача', 'открытые задачи', 'открытых задач'), '#/mytasks'),
    tile(d.stats.overdue, 'просрочено', '#/tasks?mine=1&due=overdue', d.stats.overdue ? 'bad' : ''),
    tile(d.stats.meetings, plural(d.stats.meetings, 'встреча сегодня', 'встречи сегодня', 'встреч сегодня'), '#/calendar?mine=1'),
    tile(d.stats.leads, plural(d.stats.leads, 'новая заявка', 'новые заявки', 'новых заявок'), '#/leads?status=new', d.stats.leads ? 'accent' : ''),
    tile(d.stats.doneWeek, 'сделано за 7 дней', '#/mytasks?done=1', d.stats.doneWeek ? 'good' : ''),
  );
}

function taskRow(t, reload) {
  const state = dueState(t);
  return h(
    'li',
    { class: `home-task ${state}` },
    doneToggle(t, reload),
    h(
      'div',
      { class: 'home-task-main' },
      h('button', { type: 'button', class: 'linkish task-link', onclick: () => openTask(t.id, { onChange: reload }) }, t.title),
      h('span', { class: 'muted small' }, t.client_name ?? 'Общие задачи', t.due ? [' · ', countdown(taskDeadline(t))] : null),
    ),
    t.priority >= 3 ? h('span', { class: `chip prio p${t.priority}` }, PRIORITY[t.priority]) : h('span'),
    t.due ? h('span', { class: `chip due ${state}` }, dueText(t)) : h('span', { class: 'chip' }, 'без срока'),
  );
}

function hot(d, reload) {
  return card(
    'Горит',
    { cls: 'home-hot', action: h('a', { class: 'linkish small', href: '#/mytasks' }, 'Все мои задачи') },
    d.hot.length
      ? h('ul', { class: 'home-list' }, d.hot.map((t) => taskRow(t, reload)))
      : quiet('Ничего не горит: просроченных и срочных задач нет.'),
    d.tasks.nodue ? h('p', { class: 'muted small home-foot' }, `Ещё ${d.tasks.nodue} ${plural(d.tasks.nodue, 'задача', 'задачи', 'задач')} без срока — стоит назначить даты.`) : null,
  );
}

function week(d, reload) {
  const hotIds = new Set(d.hot.map((t) => t.id));
  const rest = d.tasks.week.filter((t) => !hotIds.has(t.id));
  if (!rest.length) return null;
  return card('На неделе', {}, h('ul', { class: 'home-list' }, rest.slice(0, 8).map((t) => taskRow(t, reload))));
}

function meetings(d, reload) {
  const today = d.today;
  const byDay = new Map();
  for (const m of d.meetings) {
    const k = dayOf(m.starts_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(m);
  }
  const label = (k) => (k === today ? 'Сегодня' : new Date(`${k}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'short' }));
  const now = Date.now();
  return card(
    'Встречи',
    { action: h('a', { class: 'linkish small', href: '#/calendar?mine=1' }, 'Календарь') },
    d.meetings.length
      ? [...byDay.entries()].map(([k, list]) =>
          h(
            'div',
            { class: 'home-day' },
            h('h3', {}, label(k)),
            h(
              'ul',
              { class: 'home-list' },
              list.map((m) => {
                const start = Date.parse(m.starts_at);
                const live = start - 15 * 60e3 <= now && now < start + (m.duration ?? 60) * 60e3;
                return h(
                  'li',
                  { class: `home-meeting${live ? ' live' : ''}` },
                  h('span', { class: 'home-time num' }, timeOf(m.starts_at)),
                  h(
                    'div',
                    { class: 'home-task-main' },
                    h('button', { type: 'button', class: 'linkish task-link', onclick: () => openMeeting(m.id, { onChange: reload }) }, m.title),
                    h('span', { class: 'muted small' }, m.client_name ? `${m.client_name} · ` : '', countdown(m.starts_at, { kind: 'meeting', end: new Date(start + (m.duration ?? 60) * 60e3).toISOString() })),
                  ),
                  m.link ? h('a', { class: `btn btn-s${live ? ' btn-primary' : ''}`, href: m.link, target: '_blank', rel: 'noopener' }, live ? 'Подключиться' : 'Ссылка') : h('span'),
                );
              }),
            ),
          ),
        )
      : quiet('Встреч на ближайшие дни нет.'),
  );
}

function leads(d) {
  return card(
    'Новые заявки',
    { action: h('a', { class: 'linkish small', href: '#/leads' }, 'Квалификатор') },
    d.leads.length
      ? h(
          'ul',
          { class: 'home-list' },
          d.leads.map((l) =>
            h(
              'li',
              { class: 'home-lead' },
              h('span', { class: 'home-rating', dataset: { r: String(l.rating) }, title: 'Уровень квалификации: A — лучший, E — спам' }, { 5: 'A', 4: 'B', 3: 'C', 2: 'D', 1: 'E' }[l.rating] ?? '—'),
              h('div', { class: 'home-task-main' }, h('a', { class: 'task-link', href: `#/leads?lead=${l.id}` }, l.company || `Заявка №${l.id}`), h('span', { class: 'muted small' }, `${CHANNELS[l.channel] ?? l.channel}, ${fmtDateTime(l.created_at)}`)),
            ),
          ),
        )
      : quiet('Новых заявок за три дня нет — все разобраны.'),
  );
}

function notifications(d) {
  if (!d.notifications.length) return null;
  return card(
    'Уведомления',
    { action: h('button', { type: 'button', class: 'linkish small', onclick: async (e) => { await api('/admin/api/notifications/read', { method: 'POST', body: {} }).catch((err) => toast(err.message)); e.target.closest('.home-card').remove(); refreshBell(); } }, 'Прочитать все') },
    h('ul', { class: 'home-list' }, d.notifications.map((n) => notificationRow(n))),
  );
}

export function notificationRow(n, onOpen = () => {}) {
  return h(
    'li',
    { class: `notif${n.read_at ? '' : ' unread'}` },
    n.actor ? userAvatar({ id: n.actor_id, name: n.actor }) : h('span', { class: 'avatar' }, '•'),
    h(
      'a',
      {
        class: 'notif-text', href: n.href ?? '#/home',
        onclick: () => {
          if (!n.read_at) api('/admin/api/notifications/read', { method: 'POST', body: { id: n.id } }).then(refreshBell, () => {});
          onOpen();
        },
      },
      n.text,
      h('span', { class: 'muted small' }, fmtDateTime(n.created_at)),
    ),
  );
}

function moneyCard(d) {
  const m = d.money;
  if (!m || (!m.overdue.sum && !m.soon.length)) return null;
  const rub = (v) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  return card(
    'Деньги',
    { cls: 'home-money', action: h('a', { class: 'linkish small', href: '#/money' }, 'Все оплаты') },
    m.overdue.sum ? h('p', { class: 'home-money-debt' }, h('b', { class: 'num' }, rub(m.overdue.sum)), ` просрочено · ${m.overdue.count} ${plural(m.overdue.count, 'счёт', 'счёта', 'счетов')}`) : null,
    h(
      'ul',
      { class: 'home-list' },
      m.debtors.map((x) => h('li', { class: 'home-recent' }, h('span', { class: 'home-money-dot bad' }), h('a', { class: 'task-link', href: `#/client?id=${x.client_id}` }, x.client_name), h('span', { class: 'due overdue num small' }, `${rub(x.sum)} · ${x.days} дн.`))),
      m.soon.map((p) => h('li', { class: 'home-recent' }, h('span', { class: 'home-money-dot' }), h('a', { class: 'task-link', href: `#/client?id=${p.client_id}` }, `${p.client_name}: ${p.label}`), h('span', { class: 'muted small num' }, `${rub(p.amount)} · ${new Date(`${p.due}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`))),
    ),
  );
}

function newsCard(d) {
  if (!d.news?.length) return null;
  return card(
    d.newsUnseen ? `Новости · ${d.newsUnseen} ${plural(d.newsUnseen, 'новая', 'новые', 'новых')}` : 'Новости',
    { action: h('a', { class: 'linkish small', href: '#/news' }, 'Вся лента') },
    h(
      'ul',
      { class: 'home-list' },
      d.news.map((p) =>
        h(
          'li',
          { class: 'home-news' },
          p.image ? h('img', { class: 'home-news-img', src: `/admin/api/files/${p.image}`, alt: '', loading: 'lazy' }) : userAvatar({ id: p.author_id, name: p.author }),
          h(
            'div',
            { class: 'home-task-main' },
            h('a', { class: 'task-link', href: `#/news?post=${p.id}` }, `${p.pinned ? '📌 ' : ''}${p.title || p.body.split('\n')[0] || (p.files ? 'Фото и видео' : 'Запись')}`),
            h('span', { class: 'muted small' }, `${p.author}, ${fmtDateTime(p.created_at)}${p.comments ? ` · 💬 ${p.comments}` : ''}`),
          ),
        ),
      ),
    ),
  );
}

function recent(d) {
  if (!d.recent.length) return null;
  return card(
    'Продолжить работу',
    {},
    h(
      'ul',
      { class: 'home-list' },
      d.recent.map((r) =>
        h('li', { class: 'home-recent' }, icon(r.kind === 'doc' ? 'docs' : 'plans'), h('a', { class: 'task-link', href: `#/${r.kind}?id=${r.id}` }, r.title), h('span', { class: 'muted small' }, fmtDateTime(r.updated_at))),
      ),
    ),
  );
}

function delegated(d) {
  if (!d.delegated.length) return null;
  return card(
    'Поручил коллегам',
    {},
    h(
      'ul',
      { class: 'home-list' },
      d.delegated.map((t) =>
        h(
          'li',
          { class: 'home-task' },
          userAvatar({ id: t.assignee_id, name: t.assignee_name }),
          h('div', { class: 'home-task-main' }, h('a', { class: 'task-link', href: taskHref(t) }, t.title), h('span', { class: 'muted small' }, t.assignee_name)),
          h('span'),
          t.due ? h('span', { class: `chip due ${t.overdue ? 'overdue' : ''}` }, dueText({ ...t, status: 'todo' })) : h('span', { class: 'chip' }, 'без срока'),
        ),
      ),
    ),
  );
}

function team(d) {
  if (!d.team?.length) return null;
  const max = Math.max(...d.team.map((u) => u.open), 1);
  return card(
    'Нагрузка команды',
    { action: h('span', { class: 'muted small' }, 'открытые · просрочено · сделано за неделю') },
    h(
      'ul',
      { class: 'home-list' },
      d.team.map((u) =>
        h(
          'li',
          { class: 'home-load' },
          userAvatar(u),
          h('a', { class: 'task-link', href: `#/tasks?assignee=${u.id}` }, u.name),
          h('span', { class: 'home-bar', title: `Открытых задач: ${u.open}` }, h('i', { style: `width:${Math.round((u.open / max) * 100)}%` })),
          h('span', { class: 'num' }, u.open),
          h('span', { class: `num${u.overdue ? ' bad' : ' muted'}` }, u.overdue),
          h('span', { class: 'num good' }, u.done_week),
        ),
      ),
    ),
  );
}

// ---------- колокольчик в боковой панели ----------

const bells = new Set();
function setBellCount(unread) {
      for (const b of bells) {
        if (!b.isConnected) {
          bells.delete(b);
          continue;
        }
        const badge = b.querySelector('.bell-badge');
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.hidden = !unread;
        b.setAttribute('aria-label', unread ? `Уведомления: непрочитанных ${unread}` : 'Уведомления');
      }
}
export function refreshBell() {
  return api('/admin/api/notifications?after=999999999')
    .then(({ unread }) => setBellCount(unread))
    .catch(() => {});
}

export function bellButton() {
  const btn = h('button', { type: 'button', class: 'bell', title: 'Уведомления', 'aria-label': 'Уведомления', 'aria-haspopup': 'dialog' }, icon('bell'), h('span', { class: 'bell-badge num', hidden: true }));
  btn.addEventListener('click', () => openBell(btn));
  bells.add(btn);
  refreshBell();
  // новые уведомления — всплывающим окном, в браузере и звуком (настройки — «Уведомления»)
  watchNotifications(setBellCount);
  return btn;
}

let closeBell = null;
async function openBell(anchor) {
  if (closeBell) return closeBell();
  const list = h('ul', { class: 'home-list bell-list' }, h('li', { class: 'muted small' }, 'Загружаю…'));
  const box = h(
    'div',
    { class: 'popover bell-pop', role: 'dialog', 'aria-label': 'Уведомления' },
    h(
      'div',
      { class: 'home-card-head' },
      h('strong', {}, 'Уведомления'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'linkish small', onclick: async () => { await api('/admin/api/notifications/read', { method: 'POST', body: {} }).catch(() => {}); refreshBell(); load(); } }, 'Прочитать все'),
    ),
    list,
  );
  const close = () => {
    box.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
    closeBell = null;
    anchor.setAttribute('aria-expanded', 'false');
  };
  const outside = (e) => !box.contains(e.target) && !anchor.contains(e.target) && close();
  const esc = (e) => e.key === 'Escape' && (close(), anchor.focus());
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.cssText = `left:${Math.max(8, Math.min(r.left, innerWidth - 368))}px;top:${r.bottom + 6}px`;
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', esc, true);
  closeBell = close;
  async function load() {
    try {
      const { items } = await api('/admin/api/notifications');
      fill(list, items.length ? items.map((n) => notificationRow(n, close)) : h('li', { class: 'home-quiet' }, 'Пока пусто. Здесь появятся поручения, упоминания и приглашения на встречи.'));
    } catch (err) {
      fill(list, h('li', { class: 'error' }, err.message));
    }
  }
  load();
}
