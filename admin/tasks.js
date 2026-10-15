// Раздел «Задачи» по логике YouGile: проекты (клиенты и «Общие задачи») → доски → колонки.
// Ещё «Мои задачи» со всех проектов, клиенты агентства и карточка клиента.
// Задача открывается в боковой панели; поля сохраняются сразу при изменении.

import { h, api, app, shell, toast, navigate, fmtDateTime, plural, ctx, icon, userAvatar, confirmDialog, rowActions, countdown, taskDeadline, collapsibleFilters } from './admin.js';
import { fill, formDialog } from './docs.js';
import { clientMeetings } from './calendar.js';
import { setAssistantTask } from './assistant.js';
import { filesBox } from './files.js';
import { clientMoney, rub } from './money.js';

let team = null;
async function loadTeam() {
  team ??= await api('/admin/api/team');
  return team;
}

const TZ = 'Europe/Moscow';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const fmtDue = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
// Сейчас по Москве: ГГГГ-ММ-ДД ЧЧ:ММ — так же сравнивает сервер
const nowMsk = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
export function dueState(t) {
  if (!t.due || t.status === 'done') return '';
  const d = today();
  if (`${t.due} ${t.due_time ?? '23:59'}` < nowMsk()) return 'overdue';
  return t.due === d ? 'today' : '';
}
/** Подпись срока, как в YouGile: «7 окт. к 13:00», «сегодня к 18:00», «просрочено, 7 окт.». */
export function dueText(t) {
  const state = dueState(t);
  const time = t.due_time ? ` к ${t.due_time}` : '';
  if (state === 'overdue') return `просрочено, ${t.due === today() ? 'сегодня' : fmtDue(t.due)}${time}`;
  if (state === 'today') return `сегодня${time}`;
  return `${fmtDue(t.due)}${time}`;
}

// Проект: id клиента или 'none' — «Общие задачи»
const projectKey = (clientId) => (clientId == null ? 'none' : String(clientId));
const loadBoards = (key) => api(`/admin/api/projects/${key}/boards`);

let projectsCache = null;
async function loadProjects() {
  projectsCache = (await api('/admin/api/projects')).projects;
  return projectsCache;
}

/** Последний открытый проект — чтобы раздел открывался там, где остановились. */
const LAST = 'soroka-project';
function lastProject() {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}
function rememberProject(key) {
  try {
    localStorage.setItem(LAST, key);
  } catch {
    /* без хранилища раздел откроется на первом проекте */
  }
}

/** Выбор колонки: доски проекта — группы, колонки — пункты. */
function columnOptions(select, boards, current) {
  fill(
    select,
    boards.map((b) =>
      h('optgroup', { label: b.name }, b.columns.map((c) => h('option', { value: c.id, selected: c.id === current }, c.is_done ? `${c.name} ✓` : c.name))),
    ),
  );
}

// ---------- инструменты для задачи: связь задач с медиапланами, документами и встречами ----------

const cyr = (word) => new RegExp(`(^|[^а-яёa-z])${word}([^а-яёa-z]|$)`, 'i');
// По названию и описанию задачи подсказываем, каким разделом её решать
const TOOLS = [
  { id: 'mediaplan', kind: 'mediaplan', name: 'Медиаплан', what: 'медиаплан', hint: 'Бюджет, клики, заявки и продажи по площадкам; Excel и слайд в КП', match: [/медиаплан/i, cyr('мп'), /прогноз/i, /бюджет на/i, /расход план/i] },
  { id: 'kp', kind: 'document', template: 'kp', name: 'КП', what: 'коммерческое предложение', hint: 'Коммерческое предложение по шаблону агентства', match: [cyr('кп'), /коммерческ/i, /предложени/i, /смет/i] },
  { id: 'strategy', kind: 'document', template: 'strategy', name: 'Стратегия', what: 'стратегию', hint: 'Презентация стратегии продвижения', match: [/стратеги/i, /концепци/i, /план продвижения/i] },
  { id: 'report', kind: 'document', template: 'report', name: 'Отчёт', what: 'отчёт', hint: 'Ежемесячный отчёт клиенту', match: [/отч[её]т/i, /итоги месяца/i] },
  { id: 'meeting', kind: 'meeting', name: 'Встреча', what: 'встречу', hint: 'Время, участники, ссылка Zoom или Телемост, напоминания', match: [/встреч/i, /созвон/i, /звонок/i, /позвонить/i, cyr('бриф'), /презентовать/i, /защит/i, /обсуд/i] },
];
const LINK_ICON = { mediaplan: 'plans', document: 'docs', meeting: 'calendar' };
const LINK_HREF = { mediaplan: (id) => `#/plan?id=${id}`, document: (id) => `#/doc?id=${id}`, meeting: (id) => `#/calendar?meeting=${id}` };
const DOC_TITLES = { kp: 'Коммерческое предложение', strategy: 'Стратегия продвижения', report: 'Отчёт' };

export const suggestTools = (task) => TOOLS.filter((t) => t.match.some((re) => re.test(`${task.title ?? ''} ${task.description ?? ''}`)));

/** Создать из задачи медиаплан, документ или встречу — сразу с клиентом проекта — и привязать к задаче. */
export async function createFromTask(tool, task, onLinked) {
  const client = task.client_name ?? '';
  const link = async (refId) => {
    await api(`/admin/api/tasks/${task.id}/links`, { method: 'POST', body: { kind: tool.kind, refId } });
    onLinked?.();
  };
  try {
    if (tool.kind === 'mediaplan') {
      const { emptyPlan } = await import('/admin/lib/mediaplan-calc.js');
      const { mediaplan } = await api('/admin/api/mediaplans', { method: 'POST', body: { title: client ? `Медиаплан — ${client}` : task.title, client, spec: emptyPlan() } });
      await link(mediaplan.id);
      toast('Медиаплан создан и привязан к задаче');
      navigate('plan', new URLSearchParams({ id: String(mediaplan.id) }));
    } else if (tool.kind === 'document') {
      let leadId;
      if (task.client_id) leadId = (await api(`/admin/api/clients/${task.client_id}`).catch(() => null))?.client?.lead_id ?? undefined;
      const title = client ? `${DOC_TITLES[tool.template]} — ${client}` : task.title;
      const { document } = await api('/admin/api/documents', { method: 'POST', body: { templateId: tool.template, title, leadId, values: client ? { client } : {} } });
      await link(document.id);
      toast('Документ создан и привязан к задаче');
      navigate('doc', new URLSearchParams({ id: String(document.id) }));
    } else if (tool.kind === 'meeting') {
      const { openMeeting } = await import('./calendar.js');
      openMeeting(null, { defaults: { title: task.title, client_id: task.client_id, date: task.due ?? undefined, time: task.due_time ?? undefined }, onCreated: (m) => link(m.id).then(() => toast('Встреча привязана к задаче')) });
    }
  } catch (err) {
    toast(err.message);
  }
}

/** Блок в карточке задачи: подходящий инструмент, остальные инструменты и всё, что уже сделано по задаче. */
function toolsSection(task, refresh) {
  const box = h('section', { class: 'task-tools' });
  const suggested = suggestTools(task);
  const others = TOOLS.filter((t) => !suggested.includes(t));
  const forClient = task.client_name ? ` для «${task.client_name}»` : '';
  const unlink = async (l) => {
    try {
      task.links = (await api(`/admin/api/tasks/${task.id}/links/${l.id}`, { method: 'DELETE' })).links;
      draw();
    } catch (err) {
      toast(err.message);
    }
  };
  function draw() {
    fill(
      box,
      h('h3', {}, 'Инструменты для задачи'),
      suggested.map((t) =>
        h(
          'div',
          { class: 'tool-suggest' },
          h('span', { class: 'tool-icon' }, icon(LINK_ICON[t.kind])),
          h('span', { class: 'tool-text' }, h('b', {}, `Похоже, нужен ${t.name.toLowerCase() === 'кп' ? 'КП' : t.what}`), h('span', { class: 'muted small' }, t.hint)),
          h('button', { type: 'button', class: 'btn btn-primary btn-s', onclick: () => createFromTask(t, task, refresh) }, t.kind === 'meeting' ? `Назначить встречу${forClient}` : `Создать ${t.name === 'КП' ? 'КП' : t.what}${forClient}`),
        ),
      ),
      h(
        'div',
        { class: 'tool-more' },
        h('span', { class: 'muted small' }, suggested.length ? 'Ещё:' : 'Создать по задаче:'),
        others.map((t) => h('button', { type: 'button', class: 'btn btn-s', title: t.hint, onclick: () => createFromTask(t, task, refresh) }, icon(LINK_ICON[t.kind]), t.name)),
      ),
      task.links?.length
        ? h(
            'ul',
            { class: 'task-links' },
            task.links.map((l) =>
              h(
                'li',
                {},
                h('span', { class: 'tool-icon' }, icon(LINK_ICON[l.kind])),
                h('a', { href: LINK_HREF[l.kind](l.ref_id) }, l.title),
                l.starts_at ? h('span', { class: 'muted small' }, fmtDateTime(l.starts_at)) : null,
                h('button', { type: 'button', class: 'icon-btn', title: 'Отвязать от задачи', 'aria-label': `Отвязать «${l.title}»`, onclick: () => unlink(l) }, '×'),
              ),
            ),
          )
        : null,
    );
  }
  draw();
  return box;
}

/** Полоска на странице медиаплана, документа или встречи: по какой задаче это сделано, и отметить её выполненной. */
export function linkedTasksBar(kind, refId) {
  const bar = h('div', { class: 'linked-tasks', hidden: true });
  (async () => {
    let tasks;
    try {
      tasks = (await api(`/admin/api/linked-tasks?kind=${kind}&ref=${refId}`)).tasks;
    } catch {
      return;
    }
    if (!tasks.length) return;
    const draw = () =>
      fill(
        bar,
        tasks.map((t) =>
          h(
            'div',
            { class: `linked-task${t.status === 'done' ? ' is-done' : ''}` },
            icon('tasks'),
            h('span', {}, 'Задача: ', h('button', { type: 'button', class: 'linkish', onclick: () => openTask(t.id, { onChange: reload }) }, t.title), t.client_name ? h('span', { class: 'muted' }, ` · ${t.client_name}`) : null),
            t.status === 'done'
              ? h('span', { class: 'saved' }, '✓ выполнена')
              : h('button', {
                  type: 'button', class: 'btn btn-s',
                  onclick: async () => {
                    try {
                      await api(`/admin/api/tasks/${t.id}`, { method: 'PATCH', body: { done: true } });
                      t.status = 'done';
                      toast('Задача выполнена');
                      draw();
                    } catch (err) {
                      toast(err.message);
                    }
                  },
                }, 'Отметить задачу выполненной'),
          ),
        ),
      );
    const reload = async () => {
      tasks = (await api(`/admin/api/linked-tasks?kind=${kind}&ref=${refId}`).catch(() => ({ tasks }))).tasks;
      draw();
    };
    draw();
    bar.hidden = false;
  })();
  return bar;
}

// ---------- панель задачи ----------

let panel = null;
function closeTask() {
  if (panel) setAssistantTask(null);
  panel?.els.forEach((el) => el.remove());
  document.removeEventListener('keydown', panel?.onKey);
  const after = panel?.onClose;
  panel = null;
  after?.();
}
window.addEventListener('hashchange', () => panel && closeTask());

/** Открывает задачу (id) или форму новой (defaults: client_id, column_id, assignee_id). onChange — перерисовать то, что под панелью. */
export async function openTask(id, { defaults = {}, onChange = () => {} } = {}) {
  closeTask();
  const { team: people } = await loadTeam();
  const projects = projectsCache ?? (await loadProjects().catch(() => []));
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
    : { title: '', description: '', status: 'todo', priority: 0, assignee_id: null, client_id: null, column_id: null, due: null, comments: [], ...defaults };
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
      done.checked = task.status === 'done';
      renderFeed();
    } catch (err) {
      toast(err.message);
    }
  }

  const title = h('textarea', { class: 'textarea task-title', id: 't-title', rows: 2, maxlength: 300, placeholder: 'Что нужно сделать', onchange: (e) => patch({ title: e.target.value }) }, task.title);
  const column = h('select', { class: 'select', id: 't-column', onchange: (e) => patch({ columnId: Number(e.target.value) }) });
  async function fillColumns(key, current) {
    try {
      const { boards } = await loadBoards(key);
      columnOptions(column, boards, current ?? boards[0]?.columns[0]?.id);
    } catch (err) {
      toast(err.message);
    }
  }
  const project = h(
    'select',
    {
      class: 'select', id: 't-project',
      onchange: async (e) => {
        const key = e.target.value;
        if (task.id) {
          await patch({ clientId: key === 'none' ? null : Number(key) });
          fillColumns(key, task.column_id);
        } else fillColumns(key);
      },
    },
    projects.map((p) => h('option', { value: String(p.id), selected: String(p.id) === projectKey(task.client_id) }, p.name)),
  );
  fillColumns(projectKey(task.client_id), task.column_id);
  const assignee = h(
    'select',
    { class: 'select', id: 't-assignee', onchange: (e) => patch({ assigneeId: e.target.value ? Number(e.target.value) : null }) },
    h('option', { value: '' }, 'Не назначен'),
    people.map((u) => h('option', { value: u.id, selected: u.id === task.assignee_id }, u.id === ctx.me.id ? `${u.name} (я)` : u.name)),
  );
  const due = h('input', {
    class: 'input', id: 't-due', type: 'date', value: task.due ?? '',
    onchange: async (e) => {
      await patch({ due: e.target.value || null });
      dueTime.value = task.due_time ?? '';
    },
  });
  const dueTime = h('input', {
    class: 'input', id: 't-due-time', type: 'time', value: task.due_time ?? '', 'aria-label': 'Время срока, по Москве',
    onchange: async (e) => {
      if (!task.id) return;
      if (!due.value && e.target.value) due.value = today();
      await patch({ due: due.value || null, dueTime: e.target.value || null });
    },
  });
  const importance = h(
    'select',
    { class: 'select', id: 't-priority', onchange: (e) => patch({ priority: Number(e.target.value) }) },
    Object.entries(PRIORITY).map(([v, l]) => h('option', { value: v, selected: Number(v) === Number(task.priority) }, v === '0' ? 'Не задана' : l)),
  );
  const repeat = h(
    'select',
    {
      class: 'select', id: 't-repeat',
      onchange: async (e) => {
        if (e.target.value && !due.value) due.value = today();
        if (task.id) await patch({ repeat: e.target.value || null, ...(e.target.value && !task.due ? { due: due.value } : {}) });
      },
    },
    h('option', { value: '' }, 'Не повторять'),
    Object.entries(team?.repeats ?? {}).map(([v, l]) => h('option', { value: v, selected: v === task.repeat }, l)),
  );
  const done = h('input', {
    type: 'checkbox', id: 't-done', checked: task.status === 'done',
    onchange: async (e) => {
      await patch({ done: e.target.checked });
      if (task.repeat_spawned) {
        toast(`Повторяющаяся задача: следующая уже на доске, срок — ${fmtDue(task.due ?? today())}`);
        delete task.repeat_spawned;
      }
    },
  });
  const description = h('textarea', { class: 'textarea', id: 't-desc', rows: 5, maxlength: 10000, placeholder: 'Подробности, ссылки, критерии готовности', onchange: (e) => patch({ description: e.target.value || null }) }, task.description ?? '');

  const fields = h(
    'div',
    { class: 'work' },
    h('div', { class: 'field full' }, h('label', { for: 't-title' }, 'Задача'), title),
    h('div', { class: 'field' }, h('label', { for: 't-project' }, 'Проект'), project),
    h('div', { class: 'field' }, h('label', { for: 't-column' }, 'Доска и колонка'), column),
    h('div', { class: 'field' }, h('label', { for: 't-assignee' }, 'Исполнитель'), assignee),
    h('div', { class: 'field' }, h('label', { for: 't-due' }, 'Срок и время (МСК)'), h('div', { class: 'due-pair' }, due, dueTime), task.due && task.status !== 'done' ? h('span', { class: 'hint' }, 'До срока: ', countdown(taskDeadline(task))) : null),
    h('div', { class: 'field' }, h('label', { for: 't-priority' }, 'Важность'), importance),
    h('div', { class: 'field' }, h('label', { for: 't-repeat' }, 'Повтор'), repeat, h('span', { class: 'hint' }, 'Выполнили — появится следующая с новым сроком.')),
    task.id ? h('div', { class: 'field task-flags' }, h('label', { class: 'check' }, done, 'Выполнена')) : null,
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
                title: title.value, description: description.value || null, priority: Number(importance.value),
                assigneeId: assignee.value ? Number(assignee.value) : null, due: due.value || (dueTime.value || repeat.value ? today() : null), dueTime: dueTime.value || null,
                repeat: repeat.value || null,
                ...(column.value ? { columnId: Number(column.value) } : { clientId: project.value === 'none' ? null : Number(project.value) }),
              },
            });
            changed = true;
            // задача из встречи («по итогам») сразу связывается с ней
            if (defaults.link) await api(`/admin/api/tasks/${res.task.id}/links`, { method: 'POST', body: defaults.link }).catch(() => {});
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
      if (!(await confirmDialog('Удалить задачу вместе с комментариями?'))) return;
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
  setAssistantTask(task);
  fill(
    body,
    fields,
    checklistSection(task, () => (changed = true)),
    filesSection(task, () => (changed = true)),
    toolsSection(task, () => {
      changed = true;
      // перерисовать карточку задачи со свежими связями
      if (panel) openTask(task.id, { onChange });
    }),
    h('div', { class: 'work-actions' }, saved, h('span', { class: 'spacer' }), task.client_id ? h('a', { class: 'btn btn-s', href: `#/client?id=${task.client_id}` }, 'Карточка клиента') : null, remove),
    h('p', { class: 'muted small' }, `Создал ${task.created_by ?? '—'}, ${fmtDateTime(task.created_at)}`),
    h('section', {}, h('h3', {}, 'Обсуждение и история'), commentForm, feed),
  );
  renderFeed();
}

// ---------- вложения ----------

const filesSection = (task, onChanged) =>
  filesBox({
    files: task.files ?? [],
    attach: async (ids) => (await api(`/admin/api/tasks/${task.id}/files`, { method: 'POST', body: { fileIds: ids } })).files,
    detach: async (f) => (await api(`/admin/api/tasks/${task.id}/files/${f.id}`, { method: 'DELETE' })).files,
    onChanged,
    hint: 'Бриф, макеты, доступы, отчёты — перетащите файлы сюда или вставьте скриншот (Ctrl+V).',
  });

// ---------- чек-лист задачи ----------

function checklistSection(task, onChanged) {
  let items = task.checklist ?? [];
  const box = h('section', { class: 'checklist' });
  const input = h('input', { class: 'input', maxlength: 300, placeholder: 'Новый пункт и Enter', 'aria-label': 'Новый пункт чек-листа' });
  const save = async (url, method, body) => {
    try {
      items = (await api(url, { method, body })).checklist;
      onChanged();
      draw();
    } catch (err) {
      toast(err.message);
    }
  };
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    e.preventDefault();
    const text = input.value.trim();
    input.value = '';
    await save(`/admin/api/tasks/${task.id}/checklist`, 'POST', { items: [text] });
    box.querySelector('.checklist-add input')?.focus();
  });
  const fromKb = h('button', {
    type: 'button', class: 'btn btn-s',
    onclick: async () => {
      let docs = [];
      try {
        docs = (await api('/admin/api/kb')).docs;
      } catch (err) {
        return toast(err.message);
      }
      if (!docs.length) return toast('Регламентов пока нет — их добавляет администратор в разделе «Регламенты»');
      const pick = h('select', { class: 'select', id: 'cl-doc' }, docs.map((d) => h('option', { value: d.id }, d.title)));
      formDialog({
        title: 'Чек-лист из регламента',
        submitLabel: 'Добавить пункты',
        body: [h('p', { class: 'muted' }, 'Пункты списков из регламента добавятся в чек-лист этой задачи.'), h('div', { class: 'field' }, h('label', { for: 'cl-doc' }, 'Регламент'), pick)],
        onSubmit: async () => {
          items = (await api(`/admin/api/tasks/${task.id}/checklist`, { method: 'POST', body: { docId: Number(pick.value) } })).checklist;
          onChanged();
          draw();
          toast('Чек-лист добавлен');
        },
      });
    },
  }, 'Из регламента');
  function draw() {
    const done = items.filter((c) => c.done).length;
    const pct = items.length ? Math.round((done / items.length) * 100) : 0;
    fill(
      box,
      h('div', { class: 'checklist-head' }, h('h3', {}, 'Чек-лист'), items.length ? h('span', { class: 'muted small num' }, `${done} из ${items.length}`) : null, h('span', { class: 'spacer' }), fromKb),
      items.length ? h('div', { class: 'checklist-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { style: `width:${pct}%` })) : null,
      h(
        'ul',
        { class: 'checklist-items' },
        items.map((c) =>
          h(
            'li',
            { class: c.done ? 'is-done' : '' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.done, onchange: (e) => save(`/admin/api/checklist/${c.id}`, 'PATCH', { done: e.target.checked }) }), h('span', { class: 'checklist-text' }, c.text)),
            c.done && c.done_by ? h('span', { class: 'muted small' }, c.done_by) : null,
            h('button', { type: 'button', class: 'icon-btn checklist-del', 'aria-label': `Удалить пункт «${c.text}»`, title: 'Удалить пункт', onclick: () => save(`/admin/api/checklist/${c.id}`, 'DELETE') }, icon('trash')),
          ),
        ),
      ),
      h('div', { class: 'checklist-add' }, input),
    );
  }
  draw();
  return box;
}

// ---------- карточка задачи на доске ----------

/** Круглая галочка «выполнено», как в YouGile: отмечается прямо на карточке. */
export function doneToggle(t, onToggled) {
  const isDone = t.status === 'done';
  return h(
    'span',
    {
      class: 'done-toggle', role: 'checkbox', tabindex: '0', 'aria-checked': String(isDone), 'aria-label': isDone ? 'Вернуть в работу' : 'Отметить выполненной',
      title: isDone ? 'Вернуть в работу' : 'Выполнена',
      onclick: async (e) => {
        e.stopPropagation();
        try {
          const res = await api(`/admin/api/tasks/${t.id}`, { method: 'PATCH', body: { done: !isDone } });
          if (res.task?.repeat_spawned) toast('Повторяющаяся задача: следующая уже на доске');
          onToggled();
        } catch (err) {
          toast(err.message);
        }
      },
      onkeydown: (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.click();
        }
      },
    },
  );
}

// ---------- стикеры на карточке: срок, ответственный, важность ----------

export const PRIORITY = { 0: '', 1: 'Низкая', 2: 'Средняя', 3: 'Высокая', 4: 'Критичная' };
const addDays = (n) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Маленькое всплывающее окно у стикера; закрывается щелчком мимо или Esc. */
let openPop = null;
function popover(anchor, build) {
  openPop?.();
  const box = h('div', { class: 'popover', role: 'dialog' });
  const close = () => {
    box.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
    if (openPop === close) openPop = null;
  };
  const outside = (e) => !box.contains(e.target) && !anchor.contains(e.target) && close();
  const esc = (e) => e.key === 'Escape' && (e.stopPropagation(), close(), anchor.focus());
  box.append(...[build(close)].flat().filter(Boolean));
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth;
  box.style.cssText = `top:${Math.min(r.bottom + 6, innerHeight - box.offsetHeight - 8)}px;left:${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', esc, true);
  openPop = close;
  box.querySelector('button, input')?.focus();
}

function stickers(t, onChange) {
  const save = async (body, close) => {
    close();
    try {
      await api(`/admin/api/tasks/${t.id}`, { method: 'PATCH', body });
      onChange();
    } catch (err) {
      toast(err.message);
    }
  };
  const sticker = (cls, label, content, build) => {
    const btn = h('button', {
      type: 'button', class: `sticker ${cls}`, title: label, 'aria-label': label,
      onclick: (e) => {
        e.stopPropagation();
        popover(btn, build);
      },
    }, content);
    btn.addEventListener('keydown', (e) => e.stopPropagation());
    return btn;
  };
  const option = (label, active, onclick, extra = null) => h('button', { type: 'button', class: 'pop-item', 'aria-pressed': String(active), onclick }, extra, label);

  const state = dueState(t);
  const due = sticker(`s-due ${state}${t.due ? '' : ' empty'}`, t.due ? `Срок: ${dueText(t)}` : 'Добавить срок', [icon('due'), t.due ? dueText(t) : null], (close) => {
    const date = h('input', { class: 'input', type: 'date', value: t.due ?? '', 'aria-label': 'Дата' });
    const time = h('input', { class: 'input', type: 'time', value: t.due_time ?? '', 'aria-label': 'Время, по Москве' });
    const chip = (label, onclick) => h('button', { type: 'button', class: 'btn btn-s', onclick }, label);
    return [
      h('div', { class: 'pop-title' }, 'Срок'),
      h('div', { class: 'pop-due' }, date, time),
      h('div', { class: 'pop-quick' }, [['Сегодня', 0], ['Завтра', 1], ['Через неделю', 7]].map(([l, n]) => chip(l, () => (date.value = addDays(n))))),
      h('div', { class: 'pop-quick' }, ['10:00', '13:00', '18:00'].map((v) => chip(v, () => ((time.value = v), date.value || (date.value = today())))), chip('Без времени', () => (time.value = ''))),
      h(
        'div',
        { class: 'pop-actions' },
        h('button', {
          type: 'button', class: 'btn btn-primary btn-s',
          onclick: () => save({ due: date.value || (time.value ? today() : null), dueTime: time.value || null }, close),
        }, 'Сохранить'),
        t.due ? h('button', { type: 'button', class: 'linkish', onclick: () => save({ due: null }, close) }, 'Убрать срок') : null,
      ),
      h('p', { class: 'pop-hint' }, 'Время — по Москве. Без времени срок — до конца дня.'),
    ];
  });

  const level = Number(t.priority) || 0;
  const prio = sticker(`s-prio p${level}${level ? '' : ' empty'}`, level ? `Важность: ${PRIORITY[level]}` : 'Добавить важность', [icon('priority'), level ? PRIORITY[level] : null], (close) => [
    h('div', { class: 'pop-title' }, 'Важность'),
    ...[1, 2, 3, 4].map((n) => option(PRIORITY[n], n === level, () => save({ priority: n }, close), h('i', { class: `prio-dot p${n}` }))),
    level ? option('Убрать важность', false, () => save({ priority: 0 }, close)) : null,
  ]);

  const who = sticker(
    `s-who${t.assignee_name ? '' : ' empty'}`,
    t.assignee_name ? `Ответственный: ${t.assignee_name}` : 'Назначить ответственного',
    t.assignee_name ? userAvatar({ id: t.assignee_id, name: t.assignee_name }) : icon('person'),
    (close) => [
      h('div', { class: 'pop-title' }, 'Ответственный'),
      ...(team?.team ?? []).map((u) => option(u.id === ctx.me.id ? `${u.name} (я)` : u.name, u.id === t.assignee_id, () => save({ assigneeId: u.id }, close), userAvatar(u))),
      t.assignee_id ? option('Снять ответственного', false, () => save({ assigneeId: null }, close)) : null,
    ],
  );
  return h(
    'div',
    { class: 'stickers' },
    due,
    prio,
    t.comments ? h('span', { class: 'chip', title: 'Комментарии' }, `💬 ${t.comments}`) : null,
    t.links ? h('span', { class: 'chip chip-link', title: 'Медиапланы, документы и встречи по задаче' }, icon('docs'), t.links) : null,
    t.due && t.status !== 'done' && Date.parse(taskDeadline(t)) - Date.now() < 24 * 3600e3 ? countdown(taskDeadline(t)) : null,
    t.files ? h('span', { class: 'chip', title: `Файлов: ${t.files}` }, '📎 ', t.files) : null,
    t.check_total ? h('span', { class: `chip chip-check${t.check_done === t.check_total ? ' all' : ''}`, title: `Чек-лист: выполнено ${t.check_done} из ${t.check_total}` }, '☑ ', `${t.check_done}/${t.check_total}`) : null,
    t.repeat ? h('span', { class: 'chip chip-repeat', title: `Повтор: ${(team?.repeats?.[t.repeat] ?? '').toLowerCase()}` }, '↻') : null,
    h('span', { class: 'spacer' }),
    who,
  );
}

function card(t, { onOpen, onChange, showProject = false }) {
  const el = h(
    'article',
    {
      class: `card task-card${t.status === 'done' ? ' is-done' : ''}`, draggable: 'true', tabindex: '0', dataset: { id: String(t.id) },
      onclick: () => onOpen(t.id),
      onkeydown: (e) => e.key === 'Enter' && e.target === el && onOpen(t.id),
      ondragstart: (e) => {
        e.dataTransfer.setData('text/plain', String(t.id));
        el.classList.add('dragging');
      },
      ondragend: () => el.classList.remove('dragging'),
    },
    h(
      'div',
      { class: 'task-top' },
      doneToggle(t, onChange),
      h('span', { class: 'task-name' }, t.title),
      // удалить — автор задачи или администратор (сервер проверяет сам)
      ctx.me.role === 'admin' || t.created_by_id === ctx.me.id
        ? h('button', {
            type: 'button', class: 'task-delete', title: 'Удалить задачу', 'aria-label': `Удалить задачу «${t.title}»`,
            onclick: async (e) => {
              e.stopPropagation();
              if (!(await confirmDialog(`Удалить задачу «${t.title}» вместе с комментариями?`))) return;
              try {
                await api(`/admin/api/tasks/${t.id}`, { method: 'DELETE' });
                toast('Задача удалена');
                onChange();
              } catch (err) {
                toast(err.message);
              }
            },
            onkeydown: (e) => e.stopPropagation(),
          }, icon('trash'))
        : null,
    ),
    showProject ? h('span', { class: 'task-client' }, t.client_name ?? 'Общие задачи', ' · ', t.board_name) : null,
    stickers(t, onChange),
  );
  return el;
}

// ---------- проекты (как в YouGile): список слева, доски-вкладки, свои колонки ----------

const DUE_FILTERS = { '': 'Любой срок', overdue: 'Просрочено', today: 'Сегодня', week: 'На неделе', none: 'Без срока' };
function dueMatch(t, f) {
  if (!f) return true;
  if (f === 'none') return !t.due;
  if (!t.due || t.status === 'done') return false;
  const d = today();
  if (f === 'overdue') return t.due < d;
  if (f === 'today') return t.due === d;
  const week = new Date(`${d}T12:00:00Z`);
  week.setUTCDate(week.getUTCDate() + 7);
  return t.due <= week.toISOString().slice(0, 10);
}

function menu(label, items, cls = '') {
  const det = h('details', { class: `menu ${cls}` });
  const close = () => det.removeAttribute('open');
  det.append(
    h('summary', { class: 'icon-btn', 'aria-label': label, title: label }, '⋮'),
    h('div', { class: 'menu-list', role: 'menu' }, items.filter(Boolean).map((it) => (it instanceof Node ? it : h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', onclick: () => (close(), it.onclick()) }, it.label)))),
  );
  det.addEventListener('click', (e) => e.stopPropagation());
  return det;
}

function nameDialog({ title, label, value = '', submitLabel, onSubmit, extra = [] }) {
  const input = h('input', { class: 'input', id: 'nd-name', required: true, maxlength: 100, value });
  formDialog({ title, submitLabel, body: [h('div', { class: 'field' }, h('label', { for: 'nd-name' }, label), input), ...extra], onSubmit: () => onSubmit(input.value.trim()) });
  input.select();
}

export async function renderProjects(params) {
  await loadTeam().catch(() => {});
  const projects = await loadProjects().catch(() => null);
  if (!projects) return;
  let key = params.get('project') ?? lastProject();
  if (!projects.some((p) => String(p.id) === key)) key = String(projects[0].id);
  rememberProject(key);
  const current = projects.find((p) => String(p.id) === key);

  const f = { mine: params.get('mine') === '1', assignee: params.get('assignee') ?? '', due: params.get('due') ?? '', prio: params.get('prio') ?? '', q: params.get('q') ?? '' };
  const go = (patch) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    navigate('tasks', p);
  };

  // список проектов слева
  const filterInput = h('input', { class: 'input', type: 'search', placeholder: 'Найти проект', 'aria-label': 'Найти проект' });
  const item = (p) =>
    h(
      'a',
      { class: `pm-project${p.internal ? ' internal' : ''}`, href: `#/tasks?project=${p.id}`, 'aria-current': String(p.id) === key ? 'page' : null, dataset: { name: p.name.toLowerCase() } },
      h('span', { class: 'pm-name' }, p.name),
      p.overdue ? h('span', { class: 'pm-overdue', title: `Просрочено: ${p.overdue}` }) : null,
      h('span', { class: 'pm-count num', title: 'Открытые задачи' }, p.open || ''),
    );
  const clientsList = h('nav', { class: 'pm-list', 'aria-label': 'Проекты' }, projects.filter((p) => !p.internal).map(item));
  filterInput.addEventListener('input', () => {
    const v = filterInput.value.trim().toLowerCase();
    for (const a of clientsList.children) a.hidden = Boolean(v) && !a.dataset.name.includes(v);
  });
  const side = h(
    'aside',
    { class: 'pm-side' },
    h('div', { class: 'pm-side-head' }, h('h2', {}, 'Проекты'), h('button', { type: 'button', class: 'icon-btn', title: 'Новый проект', 'aria-label': 'Новый проект', onclick: newProject }, '+')),
    filterInput,
    clientsList,
    h('div', { class: 'pm-list pm-pinned' }, projects.filter((p) => p.internal).map(item)),
  );

  const tabs = h('div', { class: 'pm-tabs', role: 'tablist', 'aria-label': 'Доски проекта' });
  const filters = h('div', { class: 'filters pm-filters collapsible' });
  const board = h('div', { class: 'board task-board' }, h('p', { class: 'muted' }, 'Загружаю…'));
  const people = h('div', { class: 'pm-people' });
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Новая задача');
  const head = h(
    'div',
    { class: 'page-head pm-head' },
    h('h1', {}, current.name),
    people,
    h('span', { class: 'spacer' }),
    current.internal ? null : h('a', { class: 'btn', href: `#/client?id=${current.id}` }, 'Карточка клиента'),
    newBtn,
  );
  fill(app, shell('tasks', h('div', { class: 'pm' }, side, h('section', { class: 'pm-main' }, head, tabs, filters, board))));

  let boards = [];
  let active = null;
  async function load() {
    try {
      boards = (await loadBoards(key)).boards;
    } catch (err) {
      if (err.status !== 401) fill(board, h('p', { class: 'error' }, err.message));
      return;
    }
    active = boards.find((b) => String(b.id) === params.get('board')) ?? boards[0];
    renderTabs();
    renderFilters();
    await loadTasks();
  }

  function renderTabs() {
    fill(
      tabs,
      boards.map((b, i) =>
        h(
          'div',
          { class: 'pm-tab', 'aria-selected': String(b === active) },
          h('a', { role: 'tab', href: `#/tasks?project=${key}&board=${b.id}`, 'aria-selected': String(b === active) }, b.name),
          b === active
            ? menu('Действия с доской', [
                { label: 'Переименовать', onclick: () => nameDialog({ title: 'Доска', label: 'Название', value: b.name, submitLabel: 'Сохранить', onSubmit: async (name) => { await api(`/admin/api/boards/${b.id}`, { method: 'PATCH', body: { name } }); load(); } }) },
                i > 0 ? { label: 'Сдвинуть левее', onclick: () => moveBoard(b, -1) } : null,
                i < boards.length - 1 ? { label: 'Сдвинуть правее', onclick: () => moveBoard(b, 1) } : null,
                boards.length > 1 ? { label: 'Удалить доску', danger: true, onclick: () => removeBoard(b) } : null,
              ])
            : null,
        ),
      ),
      h('button', {
        type: 'button', class: 'pm-add-board',
        onclick: () => nameDialog({
          title: 'Новая доска', label: 'Название', submitLabel: 'Создать доску',
          extra: [h('p', { class: 'hint' }, 'Например: «Трафик», «Контент», «База знаний по проекту». Колонки можно переименовать и добавить свои.')],
          onSubmit: async (name) => {
            const res = await api('/admin/api/boards', { method: 'POST', body: { name, clientId: key === 'none' ? null : Number(key) } });
            navigate('tasks', new URLSearchParams({ project: key, board: String(res.board.id) }));
          },
        }),
      }, '+ Доска'),
    );
  }

  async function moveBoard(b, move) {
    try {
      await api(`/admin/api/boards/${b.id}`, { method: 'PATCH', body: { move } });
      load();
    } catch (err) {
      toast(err.message);
    }
  }
  async function removeBoard(b) {
    if (!(await confirmDialog(`Удалить доску «${b.name}»?`))) return;
    try {
      await api(`/admin/api/boards/${b.id}`, { method: 'DELETE' });
      navigate('tasks', new URLSearchParams({ project: key }));
    } catch (err) {
      toast(err.message);
    }
  }

  async function renderFilters() {
    const { team: list } = await loadTeam().catch(() => ({ team: [] }));
    const active = [f.mine, f.assignee, f.due && f.due !== Object.keys(DUE_FILTERS)[0], f.prio].filter(Boolean).length;
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Поиск', value: f.q, 'aria-label': 'Поиск', onchange: (e) => go({ q: e.target.value.trim() }) });
    fill(filters, ...collapsibleFilters(search, [
      h(
        'div',
        { class: 'rating-filter', role: 'group', 'aria-label': 'Чьи задачи' },
        h('button', { type: 'button', 'aria-pressed': String(!f.mine), onclick: () => go({ mine: '' }) }, 'Все'),
        h('button', { type: 'button', 'aria-pressed': String(f.mine), onclick: () => go({ mine: '1', assignee: '' }) }, 'Мои'),
      ),
      f.mine
        ? null
        : h(
            'select',
            { class: 'select', 'aria-label': 'Исполнитель', onchange: (e) => go({ assignee: e.target.value }) },
            h('option', { value: '' }, 'Все исполнители'),
            h('option', { value: 'none', selected: f.assignee === 'none' }, 'Не назначены'),
            list.map((u) => h('option', { value: u.id, selected: String(u.id) === f.assignee }, u.name)),
          ),
      h('select', { class: 'select', 'aria-label': 'Срок', onchange: (e) => go({ due: e.target.value }) }, Object.entries(DUE_FILTERS).map(([v, l]) => h('option', { value: v, selected: v === f.due }, l))),
      h(
        'select',
        { class: 'select', 'aria-label': 'Важность', onchange: (e) => go({ prio: e.target.value }) },
        [['', 'Любая важность'], ['3', 'Высокая и критичная'], ['4', 'Критичная']].map(([v, l]) => h('option', { value: v, selected: v === f.prio }, l)),
      ),
    ], active));
  }

  newBtn.addEventListener('click', () => openTask(null, { defaults: { client_id: current.internal ? null : current.id, column_id: active?.columns[0]?.id, assignee_id: f.mine ? ctx.me.id : null }, onChange: refresh }));

  async function refresh() {
    await loadProjects().catch(() => {});
    load();
  }
  // ссылка из уведомления или с «Главной» открывает задачу сразу
  if (params.get('task')) openTask(Number(params.get('task')), { onChange: refresh });

  async function loadTasks() {
    const q = new URLSearchParams({ board: String(active.id) });
    if (f.mine) q.set('mine', 'true');
    if (f.assignee) q.set('assignee', f.assignee);
    if (f.q) q.set('q', f.q);
    let tasks;
    try {
      tasks = (await api(`/admin/api/tasks?${q}`)).tasks.filter((t) => dueMatch(t, f.due) && (!f.prio || t.priority >= Number(f.prio)));
    } catch {
      return;
    }
    // кто работает в проекте — аватары в шапке, как в YouGile
    const people_ = [...new Map(tasks.filter((t) => t.assignee_id).map((t) => [t.assignee_id, { id: t.assignee_id, name: t.assignee_name }])).values()];
    fill(people, people_.slice(0, 6).map((u) => userAvatar(u)));

    fill(board);
    active.columns.forEach((c, i) => board.append(column(c, i, tasks.filter((t) => t.column_id === c.id))));
    board.append(h('button', {
      type: 'button', class: 'column column-add',
      onclick: () => {
        let color = 'gray';
        const swatches = colorPicker('gray', (c) => (color = c));
        nameDialog({
          title: 'Новая колонка', label: 'Название', submitLabel: 'Добавить колонку',
          extra: [h('div', { class: 'field' }, h('span', { class: 'label' }, 'Цвет'), swatches)],
          onSubmit: async (name) => {
            await api(`/admin/api/boards/${active.id}/columns`, { method: 'POST', body: { name, color } });
            load();
          },
        });
      },
    }, '+ Колонка'));
  }

  function column(c, index, tasks) {
    const cards = h('div', { class: 'cards' });
    const count = h('span', { class: 'num col-count' }, tasks.length);
    const edit = () => {
      let color = c.color;
      const swatches = colorPicker(c.color, (v) => (color = v));
      const isDone = h('input', { type: 'checkbox', id: 'nd-done', checked: Boolean(c.is_done) });
      nameDialog({
        title: 'Колонка', label: 'Название', value: c.name, submitLabel: 'Сохранить',
        extra: [
          h('div', { class: 'field' }, h('span', { class: 'label' }, 'Цвет'), swatches),
          h('label', { class: 'check' }, isDone, 'Задачи в этой колонке — выполнены'),
          h('p', { class: 'hint' }, 'Так обычно отмечают «Готово»: задачи здесь не считаются открытыми и просроченными.'),
        ],
        onSubmit: async (name) => {
          await api(`/admin/api/columns/${c.id}`, { method: 'PATCH', body: { name, color, isDone: isDone.checked } });
          load();
        },
      });
    };
    const shiftCol = async (move) => {
      try {
        await api(`/admin/api/columns/${c.id}`, { method: 'PATCH', body: { move } });
        load();
      } catch (err) {
        toast(err.message);
      }
    };
    const col = h(
      'section',
      { class: `column col-${c.color}${c.is_done ? ' col-done' : ''}`, 'aria-label': c.name },
      h(
        'header',
        {},
        h('span', { class: 'col-name' }, c.name),
        count,
        menu('Действия с колонкой', [
          { label: 'Изменить', onclick: edit },
          index > 0 ? { label: 'Сдвинуть левее', onclick: () => shiftCol(-1) } : null,
          index < active.columns.length - 1 ? { label: 'Сдвинуть правее', onclick: () => shiftCol(1) } : null,
          active.columns.length > 1 ? {
            label: 'Удалить колонку', danger: true,
            onclick: async () => {
              if (!(await confirmDialog(`Удалить колонку «${c.name}»?`))) return;
              try {
                await api(`/admin/api/columns/${c.id}`, { method: 'DELETE' });
                load();
              } catch (err) {
                toast(err.message);
              }
            },
          } : null,
        ]),
      ),
      quickAdd(c),
      cards,
    );
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
      cards.prepend(el);
      try {
        await api(`/admin/api/tasks/${id}`, { method: 'PATCH', body: { columnId: c.id } });
        toast(`${c.name}: ${el.querySelector('.task-name').textContent}`);
      } catch (err) {
        toast(err.message);
      }
      loadTasks();
    });
    for (const t of tasks) cards.append(card(t, { onOpen: (id) => openTask(id, { onChange: refresh }), onChange: loadTasks }));
    return col;
  }

  function quickAdd(c) {
    const input = h('input', { class: 'input', placeholder: 'Название задачи и Enter', 'aria-label': `Новая задача в колонку «${c.name}»`, maxlength: 300 });
    const form = h(
      'form',
      {
        class: 'quick-add', hidden: true,
        onsubmit: async (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          try {
            await api('/admin/api/tasks', { method: 'POST', body: { title: input.value, columnId: c.id, assigneeId: f.mine ? ctx.me.id : null } });
            await loadTasks();
            const again = board.querySelector(`.column[aria-label="${CSS.escape(c.name)}"] .quick-add`);
            again?.removeAttribute('hidden');
            again?.querySelector('input').focus();
          } catch (err) {
            toast(err.message);
          }
        },
      },
      input,
    );
    input.addEventListener('keydown', (e) => e.key === 'Escape' && ((form.hidden = true), (btn.hidden = false)));
    input.addEventListener('blur', () => !input.value && ((form.hidden = true), (btn.hidden = false)));
    const btn = h('button', { type: 'button', class: 'add-task', onclick: () => ((btn.hidden = true), (form.hidden = false), input.focus()) }, '+ Добавить задачу');
    return h('div', { class: 'col-add' }, btn, form);
  }

  async function newProject() {
    const { team: list } = await loadTeam();
    const name = h('input', { class: 'input', id: 'np-name', required: true, maxlength: 200, placeholder: 'ООО «Северный дом»' });
    const manager = h('select', { class: 'select', id: 'np-manager' }, h('option', { value: '' }, 'Не выбран'), list.map((u) => h('option', { value: u.id, selected: u.id === ctx.me.id }, u.name)));
    formDialog({
      title: 'Новый проект',
      submitLabel: 'Создать проект',
      body: [
        h('p', { class: 'muted' }, 'Проект — это клиент. Контакты и заметки можно добавить позже в карточке клиента.'),
        h('div', { class: 'field' }, h('label', { for: 'np-name' }, 'Клиент'), name),
        h('div', { class: 'field' }, h('label', { for: 'np-manager' }, 'Ответственный'), manager),
      ],
      onSubmit: async () => {
        const { client } = await api('/admin/api/clients', { method: 'POST', body: { name: name.value, managerId: manager.value ? Number(manager.value) : null } });
        navigate('tasks', new URLSearchParams({ project: String(client.id) }));
      },
    });
  }

  load();
}

function colorPicker(current, onPick) {
  const names = team?.colors ?? {};
  const btns = Object.entries(names).map(([k, label]) =>
    h('button', {
      type: 'button', class: `swatch-btn col-${k}`, title: label, 'aria-label': label, 'aria-pressed': String(k === current),
      onclick: () => {
        btns.forEach((b) => b.setAttribute('aria-pressed', String(b === btns.find((x) => x.title === label))));
        onPick(k);
      },
    }),
  );
  return h('div', { class: 'swatches', role: 'group', 'aria-label': 'Цвет колонки' }, btns);
}

// Старые ссылки «доска клиента» ведут в его проект
export function renderTaskBoard(params) {
  const client = params.get('client');
  navigate('tasks', client ? new URLSearchParams({ project: client }) : undefined);
}

// ---------- мои задачи: со всех проектов, списком ----------

export async function renderMyTasks(params) {
  const showDone = params.get('done') === '1';
  const list = h('div', { class: 'my-tasks' }, h('p', { class: 'muted' }, 'Загружаю…'));
  const count = h('span', { class: 'count' });
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openTask(null, { defaults: { assignee_id: ctx.me.id }, onChange: load }) }, 'Новая задача');
  fill(
    app,
    shell('mytasks', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Мои задачи'), count, h('span', { class: 'spacer' }), newBtn),
      h(
        'div',
        { class: 'filters' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showDone, onchange: (e) => navigate('mytasks', e.target.checked ? new URLSearchParams({ done: '1' }) : undefined) }), 'Показывать выполненные за 2 недели'),
      ),
      list,
    ]),
  );
  await loadTeam().catch(() => {});
  await loadProjects().catch(() => {});

  async function load() {
    let tasks;
    try {
      tasks = (await api('/admin/api/tasks?mine=true')).tasks;
    } catch {
      return;
    }
    if (!showDone) tasks = tasks.filter((t) => t.status !== 'done');
    const open = tasks.filter((t) => t.status !== 'done');
    const overdue = open.filter((t) => dueState(t) === 'overdue').length;
    count.textContent = `${open.length} ${plural(open.length, 'открытая', 'открытые', 'открытых')}${overdue ? `, просрочено ${overdue}` : ''}`;
    if (!tasks.length) {
      fill(list, h('div', { class: 'panel empty' }, h('strong', {}, 'Задач на вас нет'), 'Новые задачи, где вы исполнитель, появятся здесь со всех проектов.'));
      return;
    }
    const groups = new Map();
    for (const t of tasks) {
      const k = projectKey(t.client_id);
      if (!groups.has(k)) groups.set(k, { name: t.client_name ?? 'Общие задачи', tasks: [] });
      groups.get(k).tasks.push(t);
    }
    fill(
      list,
      [...groups.entries()].map(([k, g]) =>
        h(
          'section',
          { class: 'panel my-group' },
          h('h2', {}, h('a', { href: `#/tasks?project=${k}` }, g.name), ' ', h('span', { class: 'muted num' }, g.tasks.length)),
          h(
            'ul',
            { class: 'my-list' },
            g.tasks.map((t) => {
              const state = dueState(t);
              return h(
                'li',
                { class: t.status === 'done' ? 'is-done' : '' },
                doneToggle(t, load),
                h('button', { type: 'button', class: 'linkish task-link', onclick: () => openTask(t.id, { onChange: load }) }, t.title),
                h('span', { class: `col-chip col-${t.column_color ?? 'gray'}` }, t.board_name, ' · ', t.column_name),
                t.priority ? h('span', { class: `chip prio p${t.priority}` }, PRIORITY[t.priority]) : h('span'),
                t.due ? h('span', { class: `chip due ${state}` }, dueText(t), t.status !== 'done' && Date.parse(taskDeadline(t)) - Date.now() < 3 * 86400e3 ? [' · ', countdown(taskDeadline(t))] : null) : h('span'),
              );
            }),
          ),
        ),
      ),
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
        h('thead', {}, h('tr', {}, ['Клиент', 'Ответственный', 'Открытых задач', 'Просрочено', 'Долг', 'Контакт'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Действия')))),
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
              h('td', { class: 'num nowrap' }, c.debt ? h('span', { class: 'due overdue' }, rub(c.debt)) : h('span', { class: 'muted' }, '—')),
              h('td', {}, [c.contact, c.phone ?? c.email].filter(Boolean).join(', ') || h('span', { class: 'muted' }, '—')),
              // удалить насовсем — администратор; остальные убирают клиента в архив
              ctx.me.role === 'admin'
                ? rowActions({
                    name: c.name,
                    onDelete: async () => {
                      if (!(await confirmDialog(`Удалить клиента «${c.name}» насовсем? Его доски удалятся, задачи перейдут в «Общие задачи». Если клиент просто не активен — лучше перенести в архив из карточки.`))) return;
                      await api(`/admin/api/clients/${c.id}`, { method: 'DELETE' });
                      toast(`Клиент «${c.name}» удалён`);
                      renderClients(params);
                    },
                  })
                : rowActions({
                    name: c.name,
                    deleteTitle: 'В архив',
                    deleteIcon: 'archive',
                    onDelete: async () => {
                      if (!(await confirmDialog(`Перенести клиента «${c.name}» в архив? Задачи и история сохранятся, вернуть можно из архива.`, { ok: 'В архив', danger: false }))) return;
                      await api(`/admin/api/clients/${c.id}`, { method: 'PUT', body: { archived: true } });
                      toast(`«${c.name}» в архиве`);
                      renderClients(params);
                    },
                  }),
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
  let data, people;
  try {
    [data, { team: people }] = await Promise.all([api(`/admin/api/clients/${id}`), loadTeam()]);
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
        h('a', { class: 'btn', href: `#/tasks?project=${id}` }, 'Задачи проекта'),
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
        h('div', { class: 'client-side' }, h('section', { class: 'panel' }, clientMoney(c)), h('section', { class: 'panel' }, filesBox({
          files: data.files ?? [],
          attach: async (ids) => (await api(`/admin/api/clients/${id}/files`, { method: 'POST', body: { fileIds: ids } })).files,
          detach: async (f) => (await api(`/admin/api/clients/${id}/files/${f.id}`, { method: 'DELETE' })).files,
          title: 'Файлы клиента',
          hint: 'Договор, брифы, доступы, макеты, отчёты — перетащите сюда или нажмите «Прикрепить». Хранятся на нашем сервере.',
        })), h('section', { class: 'panel' }, clientMeetings(id, c.name)), h('section', { class: 'panel' }, tasksBox), h('section', { class: 'panel' }, docsBox)),
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
    // группы — колонки досок проекта; выполненные — отдельно в конце
    const groupMap = new Map();
    for (const t of tasks) {
      const label = t.status === 'done' ? 'Выполнено' : t.board_name && t.board_name !== 'Задачи' ? `${t.board_name} · ${t.column_name}` : t.column_name ?? 'Задачи';
      if (!groupMap.has(label)) groupMap.set(label, []);
      groupMap.get(label).push(t);
    }
    const groups = [...groupMap.entries()].sort(([a], [b]) => (a === 'Выполнено') - (b === 'Выполнено'));
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
                    h('span', { class: 'task-meta' }, t.assignee_name ?? 'не назначен', t.due ? h('span', { class: `due ${state}` }, dueText(t)) : null),
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
