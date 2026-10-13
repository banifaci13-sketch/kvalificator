// Раздел «Задачи»: доска задач команды, клиенты агентства, карточка клиента.
// Задача открывается в боковой панели; поля сохраняются сразу при изменении.

import { h, api, app, shell, toast, navigate, fmtDateTime, plural, ctx } from './admin.js';
import { fill } from './docs.js';

let team = null;
async function loadTeam() {
  team ??= await api('/admin/api/team');
  return team;
}

const TZ = 'Europe/Moscow';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const fmtDue = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
function dueState(t) {
  if (!t.due || t.status === 'done') return '';
  const d = today();
  return t.due < d ? 'overdue' : t.due === d ? 'today' : '';
}
const initials = (name) => String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// ---------- панель задачи ----------

let panel = null;
function closeTask() {
  panel?.els.forEach((el) => el.remove());
  document.removeEventListener('keydown', panel?.onKey);
  const after = panel?.onClose;
  panel = null;
  after?.();
}
window.addEventListener('hashchange', () => panel && closeTask());

/** Открывает задачу (id) или форму новой (defaults). onChange — перерисовать то, что под панелью. */
export async function openTask(id, { defaults = {}, onChange = () => {} } = {}) {
  closeTask();
  const { team: people, statuses } = await loadTeam();
  let clients = [];
  try {
    clients = (await api('/admin/api/clients')).clients;
  } catch {
    /* без списка клиентов */
  }
  const body = h('div', { class: 'drawer-body' }, h('p', { class: 'muted' }, 'Загружаю…'));
  const heading = h('h2', { id: 'task-title' }, id ? `Задача #${id}` : 'Новая задача');
  const closeBtn = h('button', { type: 'button', class: 'close', 'aria-label': 'Закрыть', onclick: closeTask }, '×');
  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'task-title' }, h('div', { class: 'drawer-head' }, heading, closeBtn), body);
  const scrim = h('div', { class: 'scrim', onclick: closeTask });
  document.body.append(scrim, drawer);
  let changed = false;
  panel = { els: [scrim, drawer], onKey: (e) => e.key === 'Escape' && closeTask(), onClose: () => changed && onChange() };
  document.addEventListener('keydown', panel.onKey);

  const task = id
    ? (await api(`/admin/api/tasks/${id}`).catch((err) => (fill(body, h('p', { class: 'error' }, err.message)), null)))?.task
    : { title: '', description: '', status: 'todo', priority: 0, assignee_id: null, client_id: null, due: null, comments: [], ...defaults };
  if (!task) return;

  const saved = h('span', { class: 'saved', role: 'status' });
  async function patch(fields) {
    if (!task.id) return;
    try {
      const res = await api(`/admin/api/tasks/${task.id}`, { method: 'PATCH', body: fields });
      Object.assign(task, res.task);
      changed = true;
      saved.textContent = 'Сохранено';
      setTimeout(() => (saved.textContent = ''), 1500);
      renderFeed();
    } catch (err) {
      toast(err.message);
    }
  }

  const title = h('textarea', { class: 'textarea task-title', id: 't-title', rows: 2, maxlength: 300, placeholder: 'Что нужно сделать', onchange: (e) => patch({ title: e.target.value }) }, task.title);
  const status = h('select', { class: 'select', id: 't-status', onchange: (e) => patch({ status: e.target.value }) }, Object.entries(statuses).map(([v, l]) => h('option', { value: v, selected: v === task.status }, l)));
  const assignee = h(
    'select',
    { class: 'select', id: 't-assignee', onchange: (e) => patch({ assigneeId: e.target.value ? Number(e.target.value) : null }) },
    h('option', { value: '' }, 'Не назначен'),
    people.map((u) => h('option', { value: u.id, selected: u.id === task.assignee_id }, u.id === ctx.me.id ? `${u.name} (я)` : u.name)),
  );
  const client = h(
    'select',
    { class: 'select', id: 't-client', onchange: (e) => patch({ clientId: e.target.value ? Number(e.target.value) : null }) },
    h('option', { value: '' }, 'Без клиента'),
    clients.map((c) => h('option', { value: c.id, selected: c.id === task.client_id }, c.name)),
  );
  const due = h('input', { class: 'input', id: 't-due', type: 'date', value: task.due ?? '', onchange: (e) => patch({ due: e.target.value || null }) });
  const urgent = h('input', { type: 'checkbox', id: 't-urgent', checked: Boolean(task.priority), onchange: (e) => patch({ priority: e.target.checked ? 1 : 0 }) });
  const description = h('textarea', { class: 'textarea', id: 't-desc', rows: 5, maxlength: 10000, placeholder: 'Подробности, ссылки, критерии готовности', onchange: (e) => patch({ description: e.target.value || null }) }, task.description ?? '');

  const fields = h(
    'div',
    { class: 'work' },
    h('div', { class: 'field full' }, h('label', { for: 't-title' }, 'Задача'), title),
    h('div', { class: 'field' }, h('label', { for: 't-status' }, 'Статус'), status),
    h('div', { class: 'field' }, h('label', { for: 't-assignee' }, 'Исполнитель'), assignee),
    h('div', { class: 'field' }, h('label', { for: 't-client' }, 'Клиент'), client),
    h('div', { class: 'field' }, h('label', { for: 't-due' }, 'Срок'), due),
    h('div', { class: 'field full' }, h('label', { class: 'check' }, urgent, 'Срочно')),
    h('div', { class: 'field full' }, h('label', { for: 't-desc' }, 'Описание'), description),
  );

  const feed = h('ol', { class: 'timeline task-feed' });
  function renderFeed() {
    fill(
      feed,
      [...(task.comments ?? [])].reverse().map((c) =>
        h('li', { class: c.kind === 'event' ? 'event' : '' }, h('time', {}, fmtDateTime(c.created_at)), h('span', {}, h('b', {}, c.author), c.kind === 'event' ? ` — ${c.text}` : h('span', { class: 'comment-text' }, c.text))),
      ),
    );
  }

  if (!task.id) {
    // новая задача: сначала создать, потом комментарии
    const create = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Создать задачу');
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          create.disabled = true;
          try {
            const res = await api('/admin/api/tasks', {
              method: 'POST',
              body: {
                title: title.value, description: description.value || null, status: status.value, priority: urgent.checked ? 1 : 0,
                assigneeId: assignee.value ? Number(assignee.value) : null, clientId: client.value ? Number(client.value) : null, due: due.value || null,
              },
            });
            changed = true;
            toast('Задача создана');
            openTask(res.task.id, { onChange });
          } catch (err) {
            toast(err.message);
            create.disabled = false;
          }
        },
      },
      fields,
      h('div', { class: 'work-actions' }, create),
    );
    fill(body, form);
    title.focus();
    return;
  }

  const comment = h('textarea', { class: 'textarea', id: 't-comment', rows: 2, maxlength: 5000, placeholder: 'Комментарий для команды' });
  const send = h('button', { type: 'submit', class: 'btn' }, 'Отправить');
  const commentForm = h(
    'form',
    {
      class: 'comment-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!comment.value.trim()) return;
        send.disabled = true;
        try {
          task.comments = (await api(`/admin/api/tasks/${task.id}/comments`, { method: 'POST', body: { text: comment.value } })).comments;
          comment.value = '';
          changed = true;
          renderFeed();
        } catch (err) {
          toast(err.message);
        } finally {
          send.disabled = false;
        }
      },
    },
    h('label', { for: 't-comment', class: 'sr-only' }, 'Комментарий'),
    comment,
    send,
  );
  const remove = h('button', {
    type: 'button', class: 'btn btn-s',
    onclick: async () => {
      if (!confirm('Удалить задачу вместе с комментариями?')) return;
      try {
        await api(`/admin/api/tasks/${task.id}`, { method: 'DELETE' });
        changed = true;
        toast('Задача удалена');
        closeTask();
      } catch (err) {
        toast(err.message);
      }
    },
  }, 'Удалить задачу');

  fill(heading, `Задача #${task.id}`);
  fill(
    body,
    fields,
    h('div', { class: 'work-actions' }, saved, h('span', { class: 'spacer' }), task.client_id ? h('a', { class: 'btn btn-s', href: `#/client?id=${task.client_id}` }, 'Карточка клиента') : null, remove),
    h('p', { class: 'muted small' }, `Создал ${task.created_by ?? '—'}, ${fmtDateTime(task.created_at)}`),
    h('section', {}, h('h3', {}, 'Обсуждение и история'), commentForm, feed),
  );
  renderFeed();
}

// ---------- доска ----------

function card(t, onOpen) {
  const state = dueState(t);
  const el = h(
    'button',
    {
      type: 'button', class: `card task-card${t.priority ? ' urgent' : ''}`, draggable: 'true', dataset: { id: String(t.id) },
      onclick: () => onOpen(t.id),
      ondragstart: (e) => {
        e.dataTransfer.setData('text/plain', String(t.id));
        el.classList.add('dragging');
      },
      ondragend: () => el.classList.remove('dragging'),
    },
    t.priority ? h('span', { class: 'urgent-chip' }, 'Срочно') : null,
    h('span', { class: 'task-name' }, t.title),
    t.client_name ? h('span', { class: 'task-client' }, t.client_name) : null,
    h(
      'span',
      { class: 'row' },
      t.assignee_name ? h('span', { class: 'avatar', title: t.assignee_name, 'aria-label': `Исполнитель: ${t.assignee_name}` }, initials(t.assignee_name)) : h('span', { class: 'muted' }, 'не назначен'),
      h('span', { class: 'card-meta' }, t.comments ? h('span', { title: 'Комментарии' }, `💬 ${t.comments}`) : null, t.due ? h('span', { class: `due ${state}` }, state === 'overdue' ? `просрочено, ${fmtDue(t.due)}` : state === 'today' ? 'сегодня' : fmtDue(t.due)) : null),
    ),
  );
  return el;
}

export async function renderTasks(params) {
  const { team: people, statuses } = await loadTeam().catch(() => ({ team: [], statuses: {} }));
  const mine = params.get('mine') === '1';
  const f = { assignee: params.get('assignee') ?? '', client: params.get('client') ?? '', q: params.get('q') ?? '' };
  const board = h('div', { class: 'board task-board' });
  const go = (patch) => {
    const p = new URLSearchParams({ ...(mine ? { mine: '1' } : {}), ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) });
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    navigate('tasks', p);
  };
  const clientSel = h('select', { class: 'select', 'aria-label': 'Клиент', onchange: (e) => go({ client: e.target.value }) }, h('option', { value: '' }, 'Все клиенты'));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск по задачам', value: f.q, 'aria-label': 'Поиск', onchange: (e) => go({ q: e.target.value.trim() }) });
  const filters = h(
    'div',
    { class: 'filters' },
    h(
      'div',
      { class: 'rating-filter', role: 'group', 'aria-label': 'Чьи задачи' },
      h('button', { type: 'button', 'aria-pressed': String(!mine), onclick: () => go({ mine: '' }) }, 'Все'),
      h('button', { type: 'button', 'aria-pressed': String(mine), onclick: () => go({ mine: '1', assignee: '' }) }, 'Мои'),
    ),
    mine
      ? null
      : h(
          'select',
          { class: 'select', 'aria-label': 'Исполнитель', onchange: (e) => go({ assignee: e.target.value }) },
          h('option', { value: '' }, 'Все исполнители'),
          h('option', { value: 'none', selected: f.assignee === 'none' }, 'Не назначены'),
          people.map((u) => h('option', { value: u.id, selected: String(u.id) === f.assignee }, u.name)),
        ),
    clientSel,
    search,
  );
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openTask(null, { defaults: newDefaults(), onChange: load }) }, 'Новая задача');
  const counter = h('span', { class: 'count' });
  fill(app, shell('tasks', [h('div', { class: 'page-head' }, h('h1', {}, 'Задачи'), counter, h('span', { class: 'spacer' }), newBtn), filters, board]));

  function newDefaults() {
    return { client_id: f.client ? Number(f.client) : null, assignee_id: mine ? ctx.me.id : f.assignee && f.assignee !== 'none' ? Number(f.assignee) : null };
  }

  api('/admin/api/clients')
    .then(({ clients }) => clientSel.append(...clients.map((c) => h('option', { value: c.id, selected: String(c.id) === f.client }, c.name))))
    .catch(() => {});

  async function load() {
    const q = new URLSearchParams();
    if (mine) q.set('mine', 'true');
    if (f.assignee) q.set('assignee', f.assignee);
    if (f.client) q.set('client', f.client);
    if (f.q) q.set('q', f.q);
    let tasks;
    try {
      tasks = (await api(`/admin/api/tasks?${q}`)).tasks;
    } catch {
      return;
    }
    const open = tasks.filter((t) => t.status !== 'done');
    const overdue = open.filter((t) => dueState(t) === 'overdue').length;
    counter.textContent = `${open.length} ${plural(open.length, 'открытая', 'открытые', 'открытых')}${overdue ? `, просрочено ${overdue}` : ''}`;
    const columns = {};
    fill(board);
    for (const [status, label] of Object.entries(statuses)) {
      const cards = h('div', { class: 'cards' });
      const count = h('span', { class: 'num' });
      const col = h('section', { class: 'column', 'aria-label': label }, h('header', {}, label, count), status === 'todo' ? quickAdd() : null, cards);
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('drop-target');
      });
      col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drop-target');
        const id = Number(e.dataTransfer.getData('text/plain'));
        const el = board.querySelector(`.task-card[data-id="${id}"]`);
        if (!el || el.parentElement === cards) return;
        const from = el.parentElement;
        cards.prepend(el);
        recount();
        try {
          await api(`/admin/api/tasks/${id}`, { method: 'PATCH', body: { status } });
          toast(`${label}: ${el.querySelector('.task-name').textContent}`);
        } catch (err) {
          from.prepend(el);
          recount();
          toast(err.message);
        }
      });
      columns[status] = { cards, count };
      board.append(col);
    }
    function recount() {
      for (const { cards, count } of Object.values(columns)) count.textContent = cards.children.length;
    }
    for (const t of tasks) columns[t.status]?.cards.append(card(t, (id) => openTask(id, { onChange: load })));
    for (const { cards } of Object.values(columns)) if (!cards.children.length) cards.dataset.empty = '1';
    recount();
  }

  function quickAdd() {
    const input = h('input', { class: 'input', placeholder: 'Добавить задачу и Enter', 'aria-label': 'Новая задача', maxlength: 300 });
    return h(
      'form',
      {
        class: 'quick-add',
        onsubmit: async (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          const d = newDefaults();
          try {
            await api('/admin/api/tasks', { method: 'POST', body: { title: input.value, clientId: d.client_id, assigneeId: d.assignee_id } });
            input.value = '';
            await load();
            board.querySelector('.quick-add input')?.focus();
          } catch (err) {
            toast(err.message);
          }
        },
      },
      input,
    );
  }

  load();
}

// ---------- клиенты ----------

export async function renderClients(params) {
  const archived = params.get('archived') === '1';
  const { team: people } = await loadTeam().catch(() => ({ team: [] }));
  const list = h('div', {}, h('p', { class: 'muted' }, 'Загружаю…'));
  const creator = h('div');
  const count = h('span', { class: 'count num' });
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: openCreator }, 'Новый клиент');
  fill(
    app,
    shell('clients', [
      h('div', { class: 'page-head' }, h('h1', {}, archived ? 'Архив клиентов' : 'Клиенты'), count, h('span', { class: 'spacer' }), h('a', { class: 'btn', href: archived ? '#/clients' : '#/clients?archived=1' }, archived ? 'Действующие' : 'Архив'), archived ? null : newBtn),
      creator,
      list,
    ]),
  );

  function openCreator() {
    newBtn.hidden = true;
    const field = (id, label, attrs = {}) => {
      const input = h('input', { class: 'input', id, maxlength: 200, ...attrs });
      return [input, h('div', { class: 'field' }, h('label', { for: id }, label), input)];
    };
    const [name, nameF] = field('c-name', 'Название', { required: true, placeholder: 'ООО «Северный дом»' });
    const [contact, contactF] = field('c-contact', 'Контактное лицо');
    const [phone, phoneF] = field('c-phone', 'Телефон', { type: 'tel', maxlength: 60 });
    const [email, emailF] = field('c-email', 'E-mail', { type: 'email' });
    const manager = h('select', { class: 'select', id: 'c-manager' }, h('option', { value: '' }, 'Не выбран'), people.map((u) => h('option', { value: u.id, selected: u.id === ctx.me.id }, u.name)));
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Создать клиента');
    fill(
      creator,
      h(
        'form',
        {
          class: 'panel create',
          onsubmit: async (e) => {
            e.preventDefault();
            submit.disabled = true;
            try {
              const { client } = await api('/admin/api/clients', {
                method: 'POST',
                body: { name: name.value, contact: contact.value || null, phone: phone.value || null, email: email.value || null, managerId: manager.value ? Number(manager.value) : null },
              });
              navigate('client', new URLSearchParams({ id: String(client.id) }));
            } catch (err) {
              toast(err.message);
              submit.disabled = false;
            }
          },
        },
        h('h2', {}, 'Новый клиент'),
        h('div', { class: 'create-fields' }, nameF, h('div', { class: 'field' }, h('label', { for: 'c-manager' }, 'Ответственный'), manager), contactF, phoneF, emailF),
        h('div', { class: 'work-actions' }, submit, h('button', { type: 'button', class: 'btn', onclick: () => { fill(creator); newBtn.hidden = false; } }, 'Отмена')),
      ),
    );
    name.focus();
  }

  let clients;
  try {
    clients = (await api(`/admin/api/clients${archived ? '?archived=true' : ''}`)).clients;
  } catch (err) {
    if (err.status !== 401) fill(list, h('p', { class: 'error' }, err.message));
    return;
  }
  count.textContent = `${clients.length} ${plural(clients.length, 'клиент', 'клиента', 'клиентов')}`;
  if (!clients.length) {
    fill(list, h('div', { class: 'panel empty' }, h('strong', {}, archived ? 'Архив пуст' : 'Клиентов пока нет'), archived ? '' : 'Заведите клиента вручную или из заявки квалификатора — кнопкой «Сделать клиентом» в карточке лида.'));
    return;
  }
  fill(
    list,
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'leads docs' },
        h('thead', {}, h('tr', {}, ['Клиент', 'Ответственный', 'Открытых задач', 'Просрочено', 'Контакт'].map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          {},
          clients.map((c) => {
            const href = `#/client?id=${c.id}`;
            return h(
              'tr',
              { onclick: () => (location.hash = href) },
              h('td', {}, h('a', { class: 'row-link company', href }, c.name), c.lead_id ? h('span', { class: 'task' }, `Из заявки #${c.lead_id}`) : null),
              h('td', {}, c.manager_name ?? h('span', { class: 'muted' }, '—')),
              h('td', { class: 'num' }, c.open_tasks || h('span', { class: 'muted' }, '—')),
              h('td', { class: 'num' }, c.overdue ? h('span', { class: 'due overdue' }, c.overdue) : h('span', { class: 'muted' }, '—')),
              h('td', {}, [c.contact, c.phone ?? c.email].filter(Boolean).join(', ') || h('span', { class: 'muted' }, '—')),
            );
          }),
        ),
      ),
    ),
  );
}

export async function renderClient(params) {
  const id = Number(params.get('id'));
  if (!id) return navigate('clients');
  fill(app, shell('client', h('p', { class: 'muted' }, 'Загружаю…')));
  let data, people, statuses;
  try {
    [data, { team: people, statuses }] = await Promise.all([api(`/admin/api/clients/${id}`), loadTeam()]);
  } catch (err) {
    if (err.status !== 401) fill(app, shell('client', [h('p', { class: 'error' }, err.message), h('a', { href: '#/clients' }, 'Все клиенты')]));
    return;
  }
  const c = data.client;
  const saved = h('span', { class: 'save-state', role: 'status' });
  async function save(patch) {
    try {
      Object.assign(c, (await api(`/admin/api/clients/${id}`, { method: 'PUT', body: patch })).client);
      saved.textContent = 'Сохранено';
      setTimeout(() => (saved.textContent = ''), 1500);
    } catch (err) {
      toast(err.message);
    }
  }
  const input = (key, label, attrs = {}) =>
    h('div', { class: 'field' }, h('label', { for: `cl-${key}` }, label), h('input', { class: 'input', id: `cl-${key}`, value: c[key] ?? '', maxlength: 300, ...attrs, onchange: (e) => save({ [key]: e.target.value.trim() || null }) }));
  const name = h('input', { class: 'doc-title', value: c.name, maxlength: 200, 'aria-label': 'Название клиента', onchange: (e) => e.target.value.trim() && save({ name: e.target.value.trim() }) });
  const manager = h(
    'select',
    { class: 'select', id: 'cl-manager', onchange: (e) => save({ managerId: e.target.value ? Number(e.target.value) : null }) },
    h('option', { value: '' }, 'Не выбран'),
    people.map((u) => h('option', { value: u.id, selected: u.id === c.manager_id }, u.name)),
  );
  const tasksBox = h('div');
  const docsBox = h('div');

  fill(
    app,
    shell('client', [
      h(
        'div',
        { class: 'doc-head' },
        h('a', { class: 'back', href: '#/clients' }, 'Клиенты'),
        name,
        saved,
        h('span', { class: 'spacer' }),
        h('a', { class: 'btn', href: `#/tasks?client=${id}` }, 'Задачи на доске'),
        h('button', { type: 'button', class: 'btn', onclick: async () => { await save({ archived: !c.archived }); toast(c.archived ? 'Клиент в архиве' : 'Клиент снова в работе'); renderClient(params); } }, c.archived ? 'Вернуть из архива' : 'В архив'),
      ),
      h(
        'div',
        { class: 'client-layout' },
        h(
          'section',
          { class: 'panel', 'aria-label': 'О клиенте' },
          h('h2', {}, 'О клиенте'),
          h('div', { class: 'field' }, h('label', { for: 'cl-manager' }, 'Ответственный'), manager),
          input('contact', 'Контактное лицо'),
          input('phone', 'Телефон', { type: 'tel' }),
          input('email', 'E-mail', { type: 'email' }),
          input('site', 'Сайт', { type: 'url', placeholder: 'https://' }),
          h('div', { class: 'field' }, h('label', { for: 'cl-notes' }, 'Заметки'), h('textarea', { class: 'textarea', id: 'cl-notes', rows: 6, maxlength: 5000, placeholder: 'Договорённости, доступы где лежат, особенности согласования', onchange: (e) => save({ notes: e.target.value || null }) }, c.notes ?? '')),
          c.lead_id ? h('p', {}, h('a', { href: `#/leads?lead=${c.lead_id}` }, `Заявка #${c.lead_id} из квалификатора`)) : null,
        ),
        h('div', { class: 'client-side' }, h('section', { class: 'panel' }, tasksBox), h('section', { class: 'panel' }, docsBox)),
      ),
    ]),
  );

  async function loadTasks() {
    let tasks = data.tasks;
    if (!tasks) {
      try {
        tasks = (await api(`/admin/api/clients/${id}`)).tasks;
      } catch {
        return;
      }
    }
    data.tasks = null;
    const input = h('input', { class: 'input', placeholder: 'Новая задача по клиенту и Enter', 'aria-label': 'Новая задача', maxlength: 300 });
    const groups = Object.entries(statuses)
      .map(([s, label]) => [label, tasks.filter((t) => t.status === s)])
      .filter(([, list]) => list.length);
    fill(
      tasksBox,
      h('h2', {}, 'Задачи'),
      h(
        'form',
        {
          class: 'quick-add',
          onsubmit: async (e) => {
            e.preventDefault();
            if (!input.value.trim()) return;
            try {
              await api('/admin/api/tasks', { method: 'POST', body: { title: input.value, clientId: id } });
              loadTasks();
            } catch (err) {
              toast(err.message);
            }
          },
        },
        input,
      ),
      groups.length
        ? groups.map(([label, list]) =>
            h(
              'div',
              { class: 'task-group' },
              h('h3', {}, label, ' ', h('span', { class: 'muted num' }, list.length)),
              h(
                'ul',
                { class: 'task-list' },
                list.map((t) => {
                  const state = dueState(t);
                  return h(
                    'li',
                    {},
                    h('button', { type: 'button', class: 'linkish task-link', onclick: () => openTask(t.id, { onChange: loadTasks }) }, t.title),
                    h('span', { class: 'task-meta' }, t.assignee_name ?? 'не назначен', t.due ? h('span', { class: `due ${state}` }, fmtDue(t.due)) : null),
                  );
                }),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'Задач по клиенту пока нет.'),
    );
  }

  async function loadDocs() {
    if (!c.lead_id) {
      fill(docsBox, h('h2', {}, 'Документы'), h('p', { class: 'muted' }, 'Документы привязываются к заявке. Создайте КП из карточки лида — оно появится здесь.'));
      return;
    }
    try {
      const { documents } = await api(`/admin/api/leads/${c.lead_id}/documents`);
      fill(
        docsBox,
        h('h2', {}, 'Документы'),
        documents.length
          ? h('ul', { class: 'export-list' }, documents.map((d) => h('li', {}, h('a', { href: `#/doc?id=${d.id}` }, d.title), h('span', { class: 'num muted' }, fmtDateTime(d.updated_at)))))
          : h('p', { class: 'muted' }, 'Документов пока нет.'),
      );
    } catch {
      fill(docsBox);
    }
  }

  loadTasks();
  loadDocs();
}

// ---------- клиент из карточки лида ----------

export function leadClient(lead) {
  const box = h('section', {}, h('h3', {}, 'Клиент'));
  (async () => {
    try {
      const { clients } = await api('/admin/api/clients');
      const archivedList = (await api('/admin/api/clients?archived=true')).clients;
      const existing = [...clients, ...archivedList].find((c) => c.lead_id === lead.id);
      if (existing) {
        box.append(h('p', {}, h('a', { href: `#/client?id=${existing.id}` }, existing.name), existing.archived ? ' (в архиве)' : ''));
        return;
      }
      const btn = h('button', {
        type: 'button', class: 'btn',
        onclick: async () => {
          btn.disabled = true;
          try {
            const { client } = await api('/admin/api/clients', { method: 'POST', body: { fromLead: lead.id } });
            toast('Клиент заведён');
            navigate('client', new URLSearchParams({ id: String(client.id) }));
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
          }
        },
      }, 'Сделать клиентом');
      box.append(h('div', { class: 'lead-doc' }, btn), h('p', { class: 'hint' }, 'Название, контакт и телефон перенесутся из заявки; вы — ответственный.'));
    } catch {
      box.remove();
    }
  })();
  return box;
}
