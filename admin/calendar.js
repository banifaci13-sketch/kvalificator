// Раздел «Календарь»: неделя и список встреч, форма встречи в боковой панели,
// ссылки Zoom / Телемост, напоминания в Telegram, подписка на календарь.
// Время везде московское (UTC+3, без перехода на летнее время).

import { h, api, app, shell, toast, navigate, ctx, confirmDialog, countdown } from './admin.js';
import { fill, formDialog } from './docs.js';

const TZ = 'Europe/Moscow';
const MSK = 3 * 3600_000;
const DAY = 24 * 3600_000;
const HOUR_FROM = 8;
const HOUR_TO = 21;
const PX_PER_MIN = 0.8;
const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

let settings = null;
let team = null;
async function loadSettings() {
  [settings, team] = await Promise.all([settings ?? api('/admin/api/calendar/settings'), team ?? api('/admin/api/team').then((r) => r.team)]);
  return settings;
}

// ---------- время ----------

/** Московские дата и время встречи. */
const msk = (iso) => {
  const d = new Date(new Date(iso).getTime() + MSK);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
};
const toIso = (date, time) => new Date(`${date}T${time}:00+03:00`).toISOString();
const todayMsk = () => msk(new Date().toISOString()).date;
function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(date) {
  const d = new Date(`${date}T12:00:00Z`);
  return addDays(date, -((d.getUTCDay() + 6) % 7));
}
/** День недели: 1 — пн … 7 — вс. */
const weekdayOf = (date) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
const WD_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WD_ACC = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
const NTH = ['', 'первый', 'второй', 'третий', 'четвёртый', 'последний'];
const NTH_F = ['', 'первую', 'вторую', 'третью', 'четвёртую', 'последнюю'];
/** Подписи «каждый месяц …» зависят от даты первой встречи. */
function repeatOptionLabel(rule, label, date) {
  const day = Number(date.slice(8, 10));
  if (rule === 'monthly') return `Каждый месяц, ${day}-го числа`;
  if (rule === 'monthly_weekday') {
    const wd = weekdayOf(date);
    const nth = Math.min(Math.ceil(day / 7), 5);
    return `Каждый месяц, в ${[3, 5, 6].includes(wd) ? NTH_F[nth] : NTH[nth]} ${WD_ACC[wd]}`;
  }
  return label;
}
const dayLabel = (date, opts) => new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', ...opts });
const endTime = (m) => msk(new Date(new Date(m.starts_at_iso).getTime() + m.duration * 60_000).toISOString()).time;

function invitation(m) {
  const { date, time } = msk(m.starts_at_iso);
  return [
    `Встреча: ${m.title}`,
    `${dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })}, ${time}–${endTime(m)} (по Москве)`,
    m.format === 'online' && m.link ? `Подключиться: ${m.link}` : null,
    m.format === 'office' && m.place ? `Адрес: ${m.place}` : null,
    m.format === 'call' ? 'Созвонимся по телефону' : null,
    m.agenda ? `\nПовестка:\n${m.agenda}` : null,
  ].filter(Boolean).join('\n');
}

// ---------- страница ----------

export async function renderCalendar(params) {
  const view = params.get('view') ?? (matchMedia('(max-width: 720px)').matches ? 'list' : 'week');
  const mine = params.get('mine') === '1';
  const week = mondayOf(params.get('week') ?? todayMsk());
  const go = (patch) => {
    const p = new URLSearchParams({ view, ...(mine ? { mine: '1' } : {}), week });
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    navigate('calendar', p);
  };
  const body = h('div', {}, h('p', { class: 'muted' }, 'Загружаю…'));
  const notice = h('div');
  const rangeLabel = view === 'week'
    ? `${dayLabel(week, { day: 'numeric', month: 'long' })} — ${dayLabel(addDays(week, 6), { day: 'numeric', month: 'long', year: 'numeric' })}`
    : 'Ближайшие 30 дней';
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openMeeting(null, { onChange: load }) }, 'Новая встреча');
  fill(
    app,
    shell('calendar', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Календарь'), h('span', { class: 'count' }, rangeLabel), h('span', { class: 'spacer' }), newBtn),
      notice,
      h(
        'div',
        { class: 'filters cal-bar' },
        view === 'week'
          ? h(
              'div',
              { class: 'cal-nav' },
              h('button', { type: 'button', class: 'btn', 'aria-label': 'Предыдущая неделя', onclick: () => go({ week: addDays(week, -7) }) }, '‹'),
              h('button', { type: 'button', class: 'btn', onclick: () => go({ week: mondayOf(todayMsk()) }) }, 'Сегодня'),
              h('button', { type: 'button', class: 'btn', 'aria-label': 'Следующая неделя', onclick: () => go({ week: addDays(week, 7) }) }, '›'),
            )
          : null,
        h(
          'div',
          { class: 'rating-filter', role: 'group', 'aria-label': 'Вид' },
          h('button', { type: 'button', 'aria-pressed': String(view === 'week'), onclick: () => go({ view: 'week' }) }, 'Неделя'),
          h('button', { type: 'button', 'aria-pressed': String(view === 'list'), onclick: () => go({ view: 'list' }) }, 'Список'),
        ),
        h(
          'div',
          { class: 'rating-filter', role: 'group', 'aria-label': 'Чьи встречи' },
          h('button', { type: 'button', 'aria-pressed': String(!mine), onclick: () => go({ mine: '' }) }, 'Все'),
          h('button', { type: 'button', 'aria-pressed': String(mine), onclick: () => go({ mine: '1' }) }, 'Мои'),
        ),
      ),
      body,
    ]),
  );

  try {
    await loadSettings();
  } catch {
    return;
  }
  if (!settings.telegram.linked) {
    fill(
      notice,
      h(
        'div',
        { class: 'note cal-notice' },
        h('span', {}, 'Напоминания о встречах приходят в Telegram — подключите его, чтобы не пропускать созвоны.'),
        h('a', { class: 'btn btn-s', href: '#/account' }, 'Подключить'),
      ),
    );
  }

  async function load() {
    const from = view === 'week' ? toIso(week, '00:00') : new Date().toISOString();
    const to = view === 'week' ? toIso(addDays(week, 7), '00:00') : new Date(Date.now() + 30 * DAY).toISOString();
    let meetings;
    try {
      meetings = (await api(`/admin/api/calendar?${new URLSearchParams({ from, to, ...(mine ? { mine: 'true' } : {}) })}`)).meetings;
    } catch (err) {
      if (err.status !== 401) fill(body, h('p', { class: 'error' }, err.message));
      return;
    }
    fill(body, view === 'week' ? weekGrid(week, meetings, load) : agenda(meetings, load));
  }
  await load();

  // ссылки вида #/calendar?new=1&client=5 и #/calendar?meeting=12
  if (params.get('meeting')) openMeeting(Number(params.get('meeting')), { onChange: load });
  else if (params.get('new')) {
    openMeeting(null, {
      onChange: load,
      defaults: { client_id: params.get('client') ? Number(params.get('client')) : null, lead_id: params.get('lead') ? Number(params.get('lead')) : null, title: params.get('title') ?? '' },
    });
  }
}

function weekGrid(week, meetings, reload) {
  const days = [...Array(7)].map((_, i) => addDays(week, i));
  const today = todayMsk();
  const height = (HOUR_TO - HOUR_FROM) * 60 * PX_PER_MIN;
  const hours = [...Array(HOUR_TO - HOUR_FROM)].map((_, i) => HOUR_FROM + i);
  const nowMin = msk(new Date().toISOString()).minutes;

  const columns = days.map((date) => {
    const list = meetings.filter((m) => msk(m.starts_at_iso).date === date).sort((a, b) => a.starts_at_iso.localeCompare(b.starts_at_iso));
    // пересекающиеся встречи — рядом, в несколько дорожек
    const lanes = [];
    const placed = list.map((m) => {
      const start = msk(m.starts_at_iso).minutes;
      const end = start + m.duration;
      let lane = lanes.findIndex((e) => e <= start);
      if (lane < 0) lane = lanes.push(end) - 1;
      else lanes[lane] = end;
      return { m, start, end, lane };
    });
    const total = Math.max(1, lanes.length);
    const col = h(
      'div',
      {
        class: `cal-day${date === today ? ' today' : ''}`,
        style: `height:${height}px`,
        onclick: (e) => {
          if (e.target !== col) return;
          const y = e.offsetY / PX_PER_MIN + HOUR_FROM * 60;
          const slot = Math.max(HOUR_FROM * 60, Math.min((HOUR_TO - 1) * 60, Math.floor(y / 30) * 30));
          const time = `${String(Math.floor(slot / 60)).padStart(2, '0')}:${String(slot % 60).padStart(2, '0')}`;
          openMeeting(null, { onChange: reload, defaults: { date, time } });
        },
      },
      date === today && nowMin >= HOUR_FROM * 60 && nowMin < HOUR_TO * 60 ? h('div', { class: 'cal-now', style: `top:${(nowMin - HOUR_FROM * 60) * PX_PER_MIN}px`, 'aria-hidden': 'true' }) : null,
      placed.map(({ m, start, end, lane }) => {
        // встречи до 8:00 и после 21:00 прижимаются к краю сетки
        const top = Math.max(0, Math.min(height - 22, (start - HOUR_FROM * 60) * PX_PER_MIN));
        const hgt = Math.max(22, Math.min(height - top, (end - start) * PX_PER_MIN));
        return h(
          'button',
          {
            type: 'button',
            class: `cal-event f-${m.format}${m.cancelled ? ' cancelled' : ''}`,
            style: `top:${top}px;height:${hgt}px;left:calc(${(lane / total) * 100}% + 2px);width:calc(${100 / total}% - 4px)`,
            onclick: () => openMeeting(m.id, { onChange: reload }),
            title: `${msk(m.starts_at_iso).time}–${endTime(m)} ${m.title}`,
          },
          h('span', { class: 'ev-time num' }, `${msk(m.starts_at_iso).time}–${endTime(m)}`),
          h('span', { class: 'ev-title' }, m.series_id ? h('span', { class: 'ev-repeat', title: 'Регулярная встреча', 'aria-label': 'Регулярная встреча' }, '↻ ') : null, m.title),
          hgt > 50 && m.client_name ? h('span', { class: 'ev-client' }, m.client_name) : null,
        );
      }),
    );
    return col;
  });

  return h(
    'div',
    { class: 'cal-week' },
    h(
      'div',
      { class: 'cal-head' },
      h('div'),
      days.map((date) => h('div', { class: `cal-dayname${date === today ? ' today' : ''}` }, h('span', {}, dayLabel(date, { weekday: 'short' })), h('b', { class: 'num' }, dayLabel(date, { day: 'numeric' })))),
    ),
    h(
      'div',
      { class: 'cal-body' },
      h('div', { class: 'cal-hours', style: `height:${height}px` }, hours.map((hr) => h('span', { class: 'num', style: `top:${(hr - HOUR_FROM) * 60 * PX_PER_MIN}px` }, `${hr}:00`))),
      columns,
    ),
  );
}

function agenda(meetings, reload) {
  if (!meetings.length) return h('div', { class: 'panel empty' }, h('strong', {}, 'Встреч нет'), 'Нажмите «Новая встреча», чтобы запланировать созвон.');
  const byDay = new Map();
  for (const m of meetings) {
    const d = msk(m.starts_at_iso).date;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(m);
  }
  return h(
    'div',
    { class: 'cal-agenda' },
    [...byDay.entries()].map(([date, list]) =>
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, date === todayMsk() ? 'Сегодня' : date === addDays(todayMsk(), 1) ? 'Завтра' : dayLabel(date, { weekday: 'long', day: 'numeric', month: 'long' })),
        h(
          'ul',
          { class: 'task-list' },
          list.map((m) =>
            h(
              'li',
              { class: m.cancelled ? 'cancelled' : '' },
              h('button', { type: 'button', class: 'linkish task-link', onclick: () => openMeeting(m.id, { onChange: reload }) }, h('span', { class: 'num' }, `${msk(m.starts_at_iso).time}–${endTime(m)}`), ' ', m.series_id ? h('span', { class: 'ev-repeat', title: 'Регулярная встреча' }, '↻ ') : null, m.title),
              h('span', { class: 'task-meta' }, m.client_name ?? '', m.link ? h('a', { href: m.link, target: '_blank', rel: 'noopener' }, 'Подключиться') : null),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------- встреча ----------

let panel = null;
function closePanel() {
  panel?.els.forEach((el) => el.remove());
  document.removeEventListener('keydown', panel?.onKey);
  const after = panel?.changed ? panel.onChange : null;
  panel = null;
  after?.();
}
window.addEventListener('hashchange', () => panel && closePanel());

export async function openMeeting(id, { defaults = {}, onChange = () => {}, onCreated = null } = {}) {
  closePanel();
  await loadSettings();
  let clients = [];
  try {
    clients = (await api('/admin/api/clients')).clients;
  } catch {
    /* без списка клиентов */
  }
  const body = h('div', { class: 'drawer-body' }, h('p', { class: 'muted' }, 'Загружаю…'));
  const heading = h('h2', { id: 'meeting-title' }, id ? 'Встреча' : 'Новая встреча');
  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'meeting-title' }, h('div', { class: 'drawer-head' }, heading, h('button', { type: 'button', class: 'close', 'aria-label': 'Закрыть', onclick: closePanel }, '×')), body);
  const scrim = h('div', { class: 'scrim', onclick: closePanel });
  document.body.append(scrim, drawer);
  panel = { els: [scrim, drawer], onKey: (e) => e.key === 'Escape' && closePanel(), onChange, changed: false };
  document.addEventListener('keydown', panel.onKey);

  let m;
  if (id) {
    try {
      m = (await api(`/admin/api/meetings/${id}`)).meeting;
    } catch (err) {
      fill(body, h('p', { class: 'error' }, err.message));
      return;
    }
  } else {
    const next = new Date(Math.ceil((Date.now() + 30 * 60_000) / (30 * 60_000)) * 30 * 60_000).toISOString();
    const at = defaults.date ? toIso(defaults.date, defaults.time ?? '10:00') : next;
    m = {
      title: defaults.title ?? '', starts_at_iso: at, duration: 60, format: 'online', provider: null, link: '', host_link: null, external_id: null, place: '',
      client_id: defaults.client_id ?? null, lead_id: defaults.lead_id ?? null, guests: '', agenda: '', remind: [1440, 15], cancelled: 0,
      participants: [{ id: ctx.me.id, name: ctx.me.name }],
    };
  }
  const start = msk(m.starts_at_iso);
  const state = { format: m.format, provider: m.provider, hostLink: m.host_link, externalId: m.external_id };

  const title = h('input', { class: 'input', id: 'm-title', required: true, maxlength: 200, value: m.title, placeholder: 'Созвон по стратегии с «Северным домом»' });
  const date = h('input', { class: 'input', id: 'm-date', type: 'date', required: true, value: start.date });
  const time = h('input', { class: 'input', id: 'm-time', type: 'time', step: 900, required: true, value: start.time });
  const duration = h('select', { class: 'select', id: 'm-duration' }, DURATIONS.map((d) => h('option', { value: d, selected: d === m.duration }, d < 60 ? `${d} мин` : `${d / 60} ч`.replace('.5', ',5'))));
  if (!DURATIONS.includes(m.duration)) duration.append(h('option', { value: m.duration, selected: true }, `${m.duration} мин`));
  const link = h('input', { class: 'input', id: 'm-link', type: 'url', maxlength: 1000, value: m.link ?? '', placeholder: 'https://… — или создайте кнопкой выше', oninput: () => { state.provider = link.value ? state.provider ?? 'other' : null; } });
  const place = h('input', { class: 'input', id: 'm-place', maxlength: 300, value: m.place ?? '', placeholder: 'Офис агентства, переговорная' });
  const client = h('select', { class: 'select', id: 'm-client' }, h('option', { value: '' }, 'Без клиента'), clients.map((c) => h('option', { value: c.id, selected: c.id === m.client_id }, c.name)));
  const guests = h('input', { class: 'input', id: 'm-guests', maxlength: 1000, value: m.guests ?? '', placeholder: 'Мария Петрова, maria@client.ru' });
  const agendaEl = h('textarea', { class: 'textarea', id: 'm-agenda', rows: 4, maxlength: 5000, placeholder: 'Что обсуждаем и что нужно подготовить' }, m.agenda ?? '');
  const people = team.map((u) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', value: u.id, checked: m.participants.some((p) => p.id === u.id) }), u.id === ctx.me.id ? `${u.name} (я)` : u.name),
  );
  const reminders = settings.remindOptions.map(([min, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: min, checked: m.remind.includes(min) }), label));

  // ----- повтор -----
  // у встречи из серии правило показывается как есть; меняется — для этой и следующих встреч
  const series = m.series ?? null;
  const rep = {
    rule: series?.rule ?? '',
    days: series?.days ?? null,
    end: series?.until ? 'until' : series?.count ? 'count' : 'never',
    touched: false,
  };
  const repeatSel = h('select', { class: 'select', id: 'm-repeat' }, h('option', { value: '' }, 'Не повторять'), Object.entries(settings.repeats).map(([v, label]) => h('option', { value: v, selected: v === rep.rule }, label)));
  const dayBtns = [1, 2, 3, 4, 5, 6, 7].map((d) =>
    h('button', {
      type: 'button', 'aria-pressed': 'false', 'aria-label': WD_ACC[d],
      onclick: (e) => {
        const cur = rep.days ?? [weekdayOf(date.value)];
        const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort();
        if (!next.length) return;
        rep.days = next;
        repeatChanged();
        e.currentTarget.blur();
      },
    }, WD_SHORT[d]),
  );
  const daysBox = h('div', { class: 'rating-filter weekdays', role: 'group', 'aria-label': 'Дни недели' }, dayBtns);
  const endSel = h('select', { class: 'select', id: 'm-repeat-end' },
    h('option', { value: 'never', selected: rep.end === 'never' }, 'Без даты окончания'),
    h('option', { value: 'until', selected: rep.end === 'until' }, 'До даты'),
    h('option', { value: 'count', selected: rep.end === 'count' }, 'Количество встреч'));
  const untilEl = h('input', { class: 'input', type: 'date', id: 'm-repeat-until', value: series?.until ?? '', 'aria-label': 'Последняя дата' });
  const countEl = h('input', { class: 'input', type: 'number', id: 'm-repeat-count', min: 2, max: 500, value: series?.count ?? 10, 'aria-label': 'Сколько встреч' });
  const repeatHint = h('p', { class: 'hint' });
  const repeatBox = h('div', { class: 'field full repeat-box' },
    h('label', { for: 'm-repeat' }, 'Повтор'),
    h('div', { class: 'repeat-row' }, repeatSel, endSel, untilEl, countEl),
    daysBox,
    repeatHint);
  // для встречи из серии: изменить только эту или эту и следующие
  const scope = { value: 'one' };
  const scopeBtns = [['one', 'Только эту'], ['following', 'Эту и следующие']].map(([v, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(scope.value === v), onclick: () => { scope.value = v; syncScope(); } }, label));
  const scopeBox = series
    ? h('div', { class: 'field full series-scope' },
        h('p', { class: 'hint' }, '↻ Регулярная встреча: ', h('b', {}, series.label), '.'),
        h('span', { class: 'label' }, 'Изменения, отмена и удаление касаются'),
        h('div', { class: 'rating-filter', role: 'group', 'aria-label': 'Какие встречи менять' }, scopeBtns))
    : null;
  function syncScope() {
    scopeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['one', 'following'][i] === scope.value)));
    cancelBtn && (cancelBtn.textContent = m.cancelled ? 'Вернуть' : scope.value === 'following' ? 'Отменить эту и следующие' : 'Отменить встречу');
    deleteBtn && (deleteBtn.textContent = scope.value === 'following' ? 'Удалить эту и следующие' : 'Удалить');
  }
  function repeatChanged() {
    rep.touched = true;
    // правило меняется только для этой и следующих встреч
    if (series && scope.value !== 'following') {
      scope.value = 'following';
      syncScope();
    }
    syncRepeat();
  }
  function syncRepeat() {
    const d = date.value || todayMsk();
    [...repeatSel.options].forEach((o) => { if (o.value) o.textContent = repeatOptionLabel(o.value, settings.repeats[o.value], d); });
    const on = Boolean(repeatSel.value);
    const weekly = ['weekly', 'biweekly'].includes(repeatSel.value);
    daysBox.hidden = !weekly;
    endSel.hidden = !on;
    untilEl.hidden = !on || endSel.value !== 'until';
    countEl.hidden = !on || endSel.value !== 'count';
    const days = rep.days ?? [weekdayOf(d)];
    dayBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(days.includes(i + 1))));
    fill(repeatHint, on && series && rep.touched ? 'Новое правило — с этой встречи; прошлые встречи серии не меняются.' : on && !series ? 'Каждая встреча серии — отдельная в календаре: напоминания, итоги и задачи по итогам — у каждой свои.' : null);
  }
  repeatSel.addEventListener('change', repeatChanged);
  endSel.addEventListener('change', repeatChanged);
  untilEl.addEventListener('change', repeatChanged);
  countEl.addEventListener('change', repeatChanged);
  date.addEventListener('change', () => {
    // день недели берём из даты, пока его не выбрали вручную
    if (!rep.touched && !series) rep.days = null;
    syncRepeat();
  });
  const repeatValue = () => {
    if (!repeatSel.value) return null;
    const weekly = ['weekly', 'biweekly'].includes(repeatSel.value);
    return {
      rule: repeatSel.value,
      ...(weekly ? { days: rep.days ?? [weekdayOf(date.value)] } : {}),
      until: endSel.value === 'until' && untilEl.value ? untilEl.value : null,
      count: endSel.value === 'count' ? Number(countEl.value) || null : null,
    };
  };

  // ----- формат и видеосвязь -----
  const providerInfo = h('p', { class: 'hint' });
  const videoBtns = ['zoom', 'telemost'].map((p) =>
    h(
      'button',
      {
        type: 'button', class: 'btn btn-s', disabled: !settings.video[p],
        title: settings.video[p] ? '' : `${settings.providers[p]} не подключён на сервере`,
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (!title.value.trim()) return toast('Сначала укажите тему встречи');
          btn.disabled = true;
          btn.textContent = 'Создаю…';
          try {
            const res = await api('/admin/api/video', { method: 'POST', body: { provider: p, title: title.value.trim(), startsAt: toIso(date.value, time.value), duration: Number(duration.value), agenda: agendaEl.value || null, recurring: Boolean(repeatSel.value) } });
            link.value = res.link;
            Object.assign(state, { provider: p, hostLink: res.hostLink, externalId: res.externalId });
            renderProvider();
            toast(`Ссылка ${settings.providers[p]} создана — сохраните встречу`);
          } catch (err) {
            toast(err.message);
          } finally {
            btn.disabled = false;
            btn.textContent = `Создать ${settings.providers[p]}`;
          }
        },
      },
      `Создать ${settings.providers[p]}`,
    ),
  );
  function renderProvider() {
    fill(
      providerInfo,
      state.provider && state.provider !== 'other' && link.value ? `Встреча в ${settings.providers[state.provider]}. ` : null,
      state.hostLink ? h('a', { href: state.hostLink, target: '_blank', rel: 'noopener' }, 'Войти как организатор') : null,
      state.hostLink ? ' — эту ссылку клиенту не отправляйте.' : null,
      !settings.video.zoom && !settings.video.telemost
        ? ['Zoom и Телемост ещё не подключены — пока вставьте ссылку вручную. ', ctx.me.role === 'admin' ? h('a', { href: '#/integrations' }, 'Как подключить') : 'Подключает администратор в разделе «Подключения».']
        : null,
    );
  }
  const onlineBox = h('div', { class: 'field full' }, h('label', { for: 'm-link' }, 'Ссылка на встречу'), h('div', { class: 'video-btns' }, videoBtns), link, providerInfo);
  const officeBox = h('div', { class: 'field full' }, h('label', { for: 'm-place' }, 'Где'), place);
  const formatBtns = Object.entries(settings.formats).map(([f, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(state.format === f), onclick: () => { state.format = f; syncFormat(); } }, label),
  );
  function syncFormat() {
    formatBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(settings.formats)[i] === state.format)));
    onlineBox.hidden = state.format !== 'online';
    officeBox.hidden = state.format !== 'office';
  }

  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, id ? 'Сохранить' : 'Запланировать');
  const collect = () => ({
    title: title.value.trim(),
    startsAt: toIso(date.value, time.value),
    duration: Number(duration.value),
    format: state.format,
    provider: state.format === 'online' && link.value ? state.provider ?? 'other' : null,
    link: state.format === 'online' ? link.value.trim() || null : null,
    hostLink: state.format === 'online' ? state.hostLink : null,
    externalId: state.format === 'online' ? state.externalId : null,
    place: state.format === 'office' ? place.value.trim() || null : null,
    clientId: client.value ? Number(client.value) : null,
    ...(m.lead_id && !id ? { leadId: m.lead_id } : {}),
    guests: guests.value.trim() || null,
    agenda: agendaEl.value.trim() || null,
    remind: reminders.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value)),
    participants: people.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value)),
    // правило повтора: у новой встречи — если выбрано; у существующей — только если его меняли
    ...(!id ? (repeatSel.value ? { repeat: repeatValue() } : {}) : rep.touched ? { repeat: repeatValue() } : {}),
    ...(series ? { scope: scope.value } : {}),
  });

  const following = () => series && scope.value === 'following' && !m.cancelled;
  const cancelBtn = id
    ? h('button', {
        type: 'button', class: 'btn btn-s',
        onclick: async () => {
          if (following() && !(await confirmDialog('Отменить эту и все следующие встречи серии? Эта останется в истории отменённой, следующие исчезнут из календаря.'))) return;
          try {
            await api(`/admin/api/meetings/${id}`, { method: 'PUT', body: { cancelled: !m.cancelled, ...(following() ? { scope: 'following' } : {}) } });
            panel.changed = true;
            toast(m.cancelled ? 'Встреча восстановлена' : following() ? 'Серия отменена с этой встречи' : 'Встреча отменена');
            closePanel();
          } catch (err) {
            toast(err.message);
          }
        },
      }, m.cancelled ? 'Вернуть' : 'Отменить встречу')
    : null;
  const deleteBtn = id
    ? h('button', {
        type: 'button', class: 'btn btn-s',
        onclick: async () => {
          const all = series && scope.value === 'following';
          if (!(await confirmDialog(all ? 'Удалить эту и все следующие встречи серии? Прошлые встречи останутся.' : 'Удалить встречу из календаря? Лучше отменить — тогда она останется в истории.'))) return;
          try {
            await api(`/admin/api/meetings/${id}${all ? '?scope=following' : ''}`, { method: 'DELETE' });
            panel.changed = true;
            closePanel();
          } catch (err) {
            toast(err.message);
          }
        },
      }, 'Удалить')
    : null;

  const form = h(
    'form',
    {
      class: 'work meeting-form',
      onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true;
        error.hidden = true;
        try {
          const res = await api(id ? `/admin/api/meetings/${id}` : '/admin/api/meetings', { method: id ? 'PUT' : 'POST', body: collect() });
          panel.changed = true;
          toast(id ? (series && scope.value === 'following' ? 'Сохранено для этой и следующих встреч' : 'Встреча сохранена') : res.meeting.series ? 'Регулярная встреча запланирована' : 'Встреча запланирована');
          if (!id) {
            await onCreated?.(res.meeting);
            return openMeeting(res.meeting.id, { onChange });
          }
          closePanel();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          save.disabled = false;
        }
      },
    },
    m.cancelled ? h('p', { class: 'stale full' }, 'Встреча отменена. Участники не получат напоминаний.') : null,
    h('div', { class: 'field full' }, h('label', { for: 'm-title' }, 'Тема'), title),
    h('div', { class: 'field' }, h('label', { for: 'm-client' }, 'Клиент'), client),
    h('div', { class: 'field' }, h('label', { for: 'm-guests' }, 'Гости со стороны клиента'), guests),
    h('div', { class: 'field' }, h('label', { for: 'm-date' }, 'Дата'), date),
    h('div', { class: 'field meeting-time' }, h('div', {}, h('label', { for: 'm-time' }, 'Начало, МСК'), time), h('div', {}, h('label', { for: 'm-duration' }, 'Длится'), duration)),
    repeatBox,
    scopeBox,
    id && !m.cancelled ? h('p', { class: 'hint full meeting-countdown' }, 'До начала: ', countdown(m.starts_at_iso, { kind: 'meeting', end: new Date(Date.parse(m.starts_at_iso) + (m.duration ?? 60) * 60e3).toISOString() })) : null,
    h('div', { class: 'field full' }, h('span', { class: 'label' }, 'Формат'), h('div', { class: 'rating-filter', role: 'group', 'aria-label': 'Формат' }, formatBtns)),
    onlineBox,
    officeBox,
    h('fieldset', { class: 'group full' }, h('legend', {}, 'Участники из команды'), h('div', { class: 'check-grid' }, people)),
    h('div', { class: 'field full' }, h('label', { for: 'm-agenda' }, 'Повестка'), agendaEl),
    h(
      'fieldset',
      { class: 'group full' },
      h('legend', {}, 'Напомнить в Telegram'),
      h('div', { class: 'check-grid' }, reminders),
      settings.telegram.linked ? null : h('p', { class: 'hint' }, 'У вас Telegram не подключён — ', h('a', { href: '#/account' }, 'подключить'), '.'),
    ),
    error,
    h(
      'div',
      { class: 'work-actions' },
      save,
      id
        ? h('button', {
            type: 'button', class: 'btn',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(invitation({ ...m, ...collect(), starts_at_iso: collect().startsAt }));
                toast('Приглашение скопировано — отправьте клиенту');
              } catch {
                toast('Не удалось скопировать — выделите текст вручную');
              }
            },
          }, 'Скопировать приглашение')
        : null,
      // итоги встречи (постмит) — блок ниже: резюме и задачи исполнителям
      id ? h('button', { type: 'button', class: 'btn', onclick: () => drawer.querySelector('.followup')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 'Итоги встречи') : null,
      h('span', { class: 'spacer' }),
      cancelBtn,
      deleteBtn,
    ),
  );
  fill(heading, id ? (m.cancelled ? 'Отменённая встреча' : 'Встреча') : 'Новая встреча');
  // по какой задаче встреча — ссылка и «выполнено» прямо отсюда
  const linked = id ? (await import('./tasks.js')).linkedTasksBar('meeting', id) : null;
  fill(body, linked, form, id ? h('p', { class: 'muted small' }, `Запланировал ${m.created_by ?? '—'}`) : null, id ? followupSection(m, () => (panel.changed = true)) : null);
  syncFormat();
  renderProvider();
  syncRepeat();
  syncScope();
  title.focus();
}

// ---------- итоги встречи (постмит) ----------

/**
 * Резюме встречи и задачи по итогам: каждая — своему исполнителю, в проект клиента встречи,
 * со связью на встречу. Список можно вставить текстом — «Олег — креативы до пятницы».
 */
function followupSection(m, onChanged) {
  const box = h('section', { class: 'followup' });
  const rows = [];
  let team = [];
  const list = h('div', { class: 'followup-items' });
  const summary = h('textarea', { class: 'textarea', id: 'fu-summary', rows: 4, maxlength: 10000, placeholder: 'О чём договорились, решения, что ждём от клиента' }, m.summary ?? '');
  const send = h('input', { type: 'checkbox', checked: true });
  const submit = h('button', { type: 'button', class: 'btn btn-primary', onclick: save }, 'Сохранить и разослать');

  function addRow(it = {}) {
    const title = h('input', { class: 'input', maxlength: 300, value: it.title ?? '', placeholder: 'Что сделать', 'aria-label': 'Задача' });
    const who = h('select', { class: 'select', 'aria-label': 'Исполнитель' }, h('option', { value: '' }, 'Исполнитель'), team.map((u) => h('option', { value: u.id, selected: u.id === it.assigneeId }, u.id === ctx.me.id ? `${u.name} (я)` : u.name)));
    const due = h('input', { class: 'input', type: 'date', value: it.due ?? '', 'aria-label': 'Срок' });
    const prio = h('select', { class: 'select', 'aria-label': 'Важность' }, [[0, 'Важность'], [1, 'Низкая'], [2, 'Средняя'], [3, 'Высокая'], [4, 'Критичная']].map(([v, l]) => h('option', { value: v, selected: v === (it.priority ?? 0) }, l)));
    const row = { title, who, due, prio, dueTime: it.dueTime ?? null };
    const el = h('div', { class: 'followup-row' }, title, who, due, prio, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Убрать строку', title: 'Убрать', onclick: () => (rows.splice(rows.indexOf(row), 1), el.remove()) }, '×'));
    row.el = el;
    rows.push(row);
    list.append(el);
    if (!it.title) title.focus();
  }

  function pasteList() {
    const text = h('textarea', { class: 'textarea', id: 'fu-paste', rows: 8, placeholder: '- Олег — креативы для РСЯ до пятницы\n- Ира: медиаплан на ноябрь к 20.10 срочно\n- отправить клиенту отчёт' });
    formDialog({
      title: 'Задачи списком',
      submitLabel: 'Разобрать',
      body: [h('p', { class: 'muted' }, 'Каждая строка — задача. Имя сотрудника и срок ассистент найдёт в тексте сам.'), h('div', { class: 'field' }, h('label', { for: 'fu-paste' }, 'Договорённости'), text)],
      onSubmit: async () => {
        const { items } = await api(`/admin/api/meetings/${m.id}/followup/parse`, { method: 'POST', body: { text: text.value } });
        // пустые строки в начале не нужны
        for (const r of [...rows]) if (!r.title.value.trim()) (rows.splice(rows.indexOf(r), 1), r.el.remove());
        for (const it of items) addRow(it);
      },
    });
  }

  async function save() {
    const items = rows
      .filter((r) => r.title.value.trim())
      .map((r) => ({ title: r.title.value.trim(), assigneeId: r.who.value ? Number(r.who.value) : null, due: r.due.value || null, dueTime: r.due.value ? r.dueTime : null, priority: Number(r.prio.value) }));
    if (!items.length && summary.value.trim() === (m.summary ?? '')) return toast('Добавьте резюме или задачи по итогам');
    submit.disabled = true;
    try {
      const res = await api(`/admin/api/meetings/${m.id}/followup`, { method: 'POST', body: { summary: summary.value, items, send: send.checked } });
      Object.assign(m, res.meeting);
      onChanged();
      for (const r of [...rows]) r.el.remove();
      rows.length = 0;
      addRow();
      toast(items.length ? `Итоги сохранены, задач поставлено: ${items.length}${send.checked ? ' — участникам ушло уведомление' : ''}` : 'Итоги сохранены');
      // свежие задачи — в блоке связанных задач над формой
      const bar = document.querySelector('.drawer .linked-tasks');
      if (bar) bar.replaceWith((await import('./tasks.js')).linkedTasksBar('meeting', m.id));
      else box.closest('.drawer-body')?.prepend((await import('./tasks.js')).linkedTasksBar('meeting', m.id));
      meta.textContent = `Записал ${m.summary_by ?? ctx.me.name}`;
    } catch (err) {
      toast(err.message);
    } finally {
      submit.disabled = false;
    }
  }

  const meta = h('span', { class: 'muted small' }, m.summary_by ? `Записал ${m.summary_by}` : '');
  const future = Date.parse(m.starts_at_iso) > Date.now();
  box.append(
    h('div', { class: 'checklist-head' }, h('h3', {}, 'Итоги встречи'), meta),
    future ? h('p', { class: 'hint' }, 'Встреча ещё впереди — заполните после неё: резюме и задачи уйдут исполнителям на их доски.') : null,
    h('div', { class: 'field' }, h('label', { for: 'fu-summary' }, 'Резюме'), summary),
    h('div', { class: 'followup-head' }, h('span', { class: 'label' }, 'Задачи по итогам'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'linkish small', onclick: pasteList }, 'Вставить списком')),
    list,
    h('button', { type: 'button', class: 'btn btn-s followup-add', onclick: () => addRow() }, '+ Задача'),
    h('p', { class: 'hint' }, m.client_name ? `Задачи встанут в проект «${m.client_name}» и привяжутся к встрече.` : 'У встречи нет клиента — задачи встанут в «Общие задачи». Выберите клиента выше, чтобы они попали в его проект.'),
    h('div', { class: 'work-actions' }, submit, h('label', { class: 'check small' }, send, 'Уведомить участников и исполнителей')),
  );
  api('/admin/api/team')
    .then((d) => {
      team = d.team ?? [];
      addRow();
    })
    .catch(() => addRow());
  return box;
}

// ---------- учётная запись: Telegram и подписка ----------

export function notificationsPanel() {
  const box = h('section', { class: 'panel account-form' }, h('h2', {}, 'Напоминания и календарь'), h('p', { class: 'muted' }, 'Загружаю…'));
  (async () => {
    try {
      settings = null;
      await loadSettings();
    } catch {
      box.remove();
      return;
    }
    const tg = settings.telegram;
    const icsBox = h('div');
    const showIcs = (url) =>
      fill(
        icsBox,
        h('div', { class: 'field' }, h('label', { for: 'ics-url' }, 'Ссылка для подписки'), h('input', { class: 'input mono', id: 'ics-url', readonly: true, value: url, onclick: (e) => e.target.select() })),
        h(
          'div',
          { class: 'work-actions' },
          h('button', { type: 'button', class: 'btn btn-s', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована'); } catch { toast('Выделите и скопируйте вручную'); } } }, 'Скопировать'),
          h('button', {
            type: 'button', class: 'btn btn-s',
            onclick: async () => {
              if (!(await confirmDialog('Создать новую ссылку? Старая перестанет работать во всех календарях, где вы подписались.'))) return;
              showIcs((await api('/admin/api/me/calendar-token', { method: 'POST', body: { regenerate: true } })).url);
            },
          }, 'Новая ссылка'),
        ),
        h('p', { class: 'hint' }, 'Яндекс Календарь: «Подписаться на календарь» → «По ссылке». Google: «Другие календари» → «Добавить по URL». Ссылка личная — не пересылайте её.'),
      );
    if (settings.ics) showIcs(settings.ics);
    else {
      fill(icsBox, h('button', { type: 'button', class: 'btn', onclick: async () => showIcs((await api('/admin/api/me/calendar-token', { method: 'POST', body: {} })).url) }, 'Получить ссылку для подписки'));
    }
    fill(
      box,
      h('h2', {}, 'Напоминания и календарь'),
      h('h3', {}, 'Telegram'),
      tg.linked
        ? h(
            'div',
            { class: 'work-actions' },
            h('span', { class: 'saved' }, 'Подключён: сюда приходят напоминания о встречах и план на день в 9:00.'),
            h('button', { type: 'button', class: 'btn btn-s', onclick: async () => { await api('/admin/api/me/telegram', { method: 'DELETE' }); toast('Telegram отключён'); fill(box); box.replaceWith(notificationsPanel()); } }, 'Отключить'),
          )
        : tg.enabled && tg.bot
          ? [
              h('p', { class: 'muted' }, 'Откроется бот — нажмите в нём «Запустить». После этого обновите страницу.'),
              h('button', {
                type: 'button', class: 'btn btn-primary',
                onclick: async () => {
                  try {
                    const { url } = await api('/admin/api/me/telegram-link', { method: 'POST', body: {} });
                    window.open(url, '_blank', 'noopener');
                  } catch (err) {
                    toast(err.message);
                  }
                },
              }, 'Подключить Telegram'),
            ]
          : h('p', { class: 'muted' }, 'Telegram-бот на сервере не запущен — попросите администратора задать TELEGRAM_BOT_TOKEN.'),
      h('h3', {}, 'Встречи в вашем календаре'),
      icsBox,
    );
  })();
  return box;
}

// ---------- встречи клиента ----------

export function clientMeetings(clientId, clientName) {
  const box = h('div', {}, h('h2', {}, 'Встречи'));
  (async () => {
    try {
      const from = new Date(Date.now() - 2 * 3600_000).toISOString();
      const to = new Date(Date.now() + 90 * DAY).toISOString();
      const { meetings } = await api(`/admin/api/calendar?${new URLSearchParams({ from, to, client: String(clientId) })}`);
      const planned = meetings.filter((x) => !x.cancelled);
      box.append(
        planned.length
          ? h(
              'ul',
              { class: 'task-list' },
              planned.map((x) =>
                h(
                  'li',
                  {},
                  h('button', { type: 'button', class: 'linkish task-link', onclick: () => openMeeting(x.id) }, x.title),
                  h('span', { class: 'task-meta num' }, `${dayLabel(msk(x.starts_at_iso).date, { day: 'numeric', month: 'short' })}, ${msk(x.starts_at_iso).time}`),
                ),
              ),
            )
          : h('p', { class: 'muted' }, 'Ближайших встреч нет.'),
        h('div', { class: 'work-actions' }, h('a', { class: 'btn btn-s', href: `#/calendar?${new URLSearchParams({ new: '1', client: String(clientId), title: `Встреча: ${clientName}` })}` }, 'Назначить встречу')),
      );
    } catch {
      box.remove();
    }
  })();
  return box;
}
