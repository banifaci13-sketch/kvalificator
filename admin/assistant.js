// ИИ-ассистент: кнопка в боковой панели и окно чата рядом с ней. Окно живёт поверх страниц и не
// закрывается при переходах между разделами. Поручения («поставь задачу…», «что у меня завтра»)
// выполняются сразу; вопросы — с опорой на регламенты агентства и, при необходимости, поиск в интернете.

import { h, api, toast, navigate, ctx, icon, rerender, confirmDialog } from './admin.js';
import { refreshBell } from './home.js';
import { fill } from './docs.js';

const PAGES = {
  docs: 'Документы', doc: 'Документы', templates: 'Шаблоны', plans: 'Медиапланы', plan: 'Медиаплан', benchmarks: 'Нормативы',
  tasks: 'Задачи', mytasks: 'Мои задачи', clients: 'Клиенты', client: 'Карточка клиента', calendar: 'Календарь',
  leads: 'Квалификатор', board: 'Воронка лидов', stats: 'Сводка по лидам', staff: 'Сотрудники', kb: 'Регламенты',
};
const QUICK = [
  ['Что у меня сегодня?', 'что у меня сегодня'],
  ['Мои задачи', 'мои задачи'],
  ['Просроченные', 'что у меня просрочено'],
  ['Что ты умеешь?', 'что ты умеешь'],
];

let state = null; // { info, el, list, input, busy }

const assistantName = () => ctx.me?.prefs?.assistantName || 'Ассистент';

/** Кнопка в боковой панели — в пустом месте между разделами и настройками. */
export function assistantEntry() {
  return h(
    'button',
    { type: 'button', class: 'assist-entry', title: `${assistantName()}: поручите или спросите`, 'aria-label': `Открыть ассистента «${assistantName()}»`, onclick: toggleAssistant },
    h('span', { class: 'assist-avatar', 'aria-hidden': 'true' }, assistantName()[0].toUpperCase()),
    h('span', { class: 'assist-text' }, h('b', {}, assistantName()), h('span', {}, 'Поручите задачу или спросите')),
  );
}

export function toggleAssistant() {
  if (state?.el.isConnected) return closeAssistant();
  openAssistant();
}

function closeAssistant() {
  state?.el.remove();
  document.documentElement.classList.remove('assist-open');
  state = null;
}

/** Текущая открытая задача — чтобы «помоги с этой задачей» понимало, о чём речь. */
let taskContext = null;
export function setAssistantTask(task) {
  taskContext = task ? { id: task.id, title: task.title, client: task.client_name ?? null, description: task.description ?? null } : null;
  state?.renderContext?.();
}

async function openAssistant(prefill = '') {
  const list = h('div', { class: 'assist-list', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'assist-input', rows: 1, maxlength: 4000, placeholder: 'Например: поставь задачу КП для Таллера на пятницу', 'aria-label': 'Сообщение ассистенту' });
  const send = h('button', { type: 'submit', class: 'assist-send', title: 'Отправить', 'aria-label': 'Отправить' }, '↑');
  const ctxChip = h('div', { class: 'assist-context' });
  const status = h('span', { class: 'assist-status' });
  const el = h(
    'aside',
    { class: 'assist-panel', role: 'dialog', 'aria-label': `Ассистент ${assistantName()}` },
    h(
      'header',
      { class: 'assist-head' },
      h('span', { class: 'assist-avatar', 'aria-hidden': 'true' }, assistantName()[0].toUpperCase()),
      h('div', { class: 'assist-title' }, h('b', {}, assistantName()), status),
      h('a', { class: 'icon-btn', href: '#/kb', title: 'Регламенты, которые знает ассистент', 'aria-label': 'Регламенты' }, icon('kb')),
      h('button', {
        type: 'button', class: 'icon-btn', title: 'Очистить диалог', 'aria-label': 'Очистить диалог',
        onclick: async () => {
          if (!(await confirmDialog('Очистить историю диалога?'))) return;
          await api('/admin/api/assistant/history', { method: 'DELETE' }).catch(() => {});
          fill(list, greeting());
        },
      }, icon('trash')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: closeAssistant }, '×'),
    ),
    list,
    h(
      'form',
      {
        class: 'assist-form',
        onsubmit: (e) => {
          e.preventDefault();
          ask(input.value);
        },
      },
      ctxChip,
      h('div', { class: 'assist-compose' }, input, send),
    ),
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask(input.value);
    }
    if (e.key === 'Escape') closeAssistant();
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  });
  document.body.append(el);
  document.documentElement.classList.add('assist-open');
  state = { el, list, input, busy: false, info: null };
  state.renderContext = () => {
    const page = PAGES[location.hash.replace(/^#\/?/, '').split('?')[0]] ?? null;
    fill(ctxChip, taskContext ? h('span', {}, 'Контекст: задача «', h('b', {}, taskContext.title), '»') : page ? h('span', {}, `Вы в разделе «${page}»`) : null);
  };
  state.renderContext();
  window.addEventListener('hashchange', state.renderContext);

  fill(list, h('p', { class: 'muted small' }, 'Загружаю…'));
  try {
    state.info = await api('/admin/api/assistant');
  } catch (err) {
    fill(list, h('p', { class: 'error' }, err.message));
    return;
  }
  status.textContent = state.info.ai ? (state.info.search ? 'ИИ и поиск в интернете' : 'ИИ без поиска в интернете') : 'Поручения без ИИ';
  fill(list, state.info.history.length ? state.info.history.map(bubble) : greeting());
  scrollDown();
  input.value = prefill;
  input.focus();
}

function greeting() {
  const info = state?.info;
  return h(
    'div',
    { class: 'assist-hello' },
    h('p', {}, h('b', {}, `Я — ${assistantName()}.`), ' Ставлю задачи и встречи обычной фразой, напоминаю, что на сегодня, помогаю с задачами по регламентам агентства', info?.search ? ' и ищу в интернете.' : '.'),
    info && !info.ai ? h('p', { class: 'muted small' }, 'Свободный разговор заработает, когда администратор подключит YandexGPT («Сотрудники» → «Подключения»). Поручения работают уже сейчас.') : null,
    info && !info.kb ? h('p', { class: 'muted small' }, 'Регламентов пока нет — добавьте описания процессов в разделе «Регламенты», и я буду на них опираться.') : null,
    h('div', { class: 'assist-quick' }, QUICK.map(([label, text]) => h('button', { type: 'button', class: 'btn btn-s', onclick: () => ask(text) }, label))),
  );
}

const scrollDown = () => state && (state.list.scrollTop = state.list.scrollHeight);

/** Текст ответа: абзацы, списки, **жирный**, ссылки на источники [n]. */
function richText(text, sources = []) {
  const box = h('div', { class: 'assist-text-body' });
  const inline = (line) => {
    const out = [];
    const re = /\*\*([^*]+)\*\*|\[(\d+)\]|(https?:\/\/[^\s)]+)/g;
    let last = 0;
    for (const m of line.matchAll(re)) {
      out.push(line.slice(last, m.index));
      if (m[1]) out.push(h('b', {}, m[1]));
      else if (m[2]) {
        const src = sources[Number(m[2]) - 1];
        out.push(src ? h('a', { class: 'cite', href: src.url, target: '_blank', rel: 'noopener', title: src.title }, `[${m[2]}]`) : m[0]);
      } else out.push(h('a', { href: m[3], target: '_blank', rel: 'noopener' }, m[3]));
      last = m.index + m[0].length;
    }
    out.push(line.slice(last));
    return out;
  };
  for (const para of String(text).split(/\n{2,}/)) {
    const lines = para.split('\n');
    const isList = lines.length > 1 && lines.slice(1).every((l) => /^\s*(?:[•\-*]|\d+[.)])\s+/.test(l));
    if (lines.every((l) => /^\s*(?:[•\-*]|\d+[.)])\s+/.test(l)) || isList) {
      const head = /^\s*(?:[•\-*]|\d+[.)])\s+/.test(lines[0]) ? null : lines.shift();
      if (head) box.append(h('p', {}, inline(head)));
      box.append(h('ul', {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*(?:[•\-*]|\d+[.)])\s+/, ''))))));
    } else box.append(h('p', {}, lines.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)))));
  }
  return box;
}

function bubble(m) {
  if (m.role === 'user') return h('div', { class: 'msg msg-user' }, h('div', { class: 'msg-body' }, m.text));
  const actions = (m.actions ?? []).map((a) =>
    h(
      'div',
      { class: 'msg-action' },
      icon({ meeting: 'calendar', plan: 'plans', doc: 'docs', lead: 'leads', client: 'person', link: 'home' }[a.type] ?? 'tasks'),
      h('a', { href: a.href, onclick: () => setTimeout(() => window.innerWidth < 960 && closeAssistant(), 0) }, a.title),
      a.created && a.type === 'task' ? toolButtons(a) : null,
    ),
  );
  return h(
    'div',
    { class: `msg msg-bot${m.error ? ' msg-error' : ''}` },
    richText(m.text, m.sources ?? []),
    actions.length ? h('div', { class: 'msg-actions' }, actions) : null,
    m.options?.length ? h('div', { class: 'msg-options' }, m.options.map((o) => h('button', { type: 'button', class: 'btn btn-s', onclick: () => ask(o.command, o.label) }, o.label))) : null,
    m.sources?.length
      ? h('ol', { class: 'msg-sources' }, m.sources.map((s) => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title), h('span', { class: 'muted' }, ` · ${hostOf(s.url)}`))))
      : null,
    m.kb?.length ? h('p', { class: 'msg-kb' }, 'По регламентам: ', m.kb.join(', ')) : null,
  );
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Задача, поставленная ассистентом, сразу предлагает инструмент — как в карточке задачи. */
function toolButtons(a) {
  const box = h('span', { class: 'msg-tools' });
  import('./tasks.js').then(({ suggestTools, createFromTask }) => {
    const tools = suggestTools({ title: a.title });
    if (!tools.length) return;
    api(`/admin/api/tasks/${a.id}`)
      .then(({ task }) => fill(box, tools.map((t) => h('button', { type: 'button', class: 'btn btn-s btn-primary', onclick: () => createFromTask(t, task) }, t.kind === 'meeting' ? 'Назначить встречу' : `Создать ${t.name === 'КП' ? 'КП' : t.what}`))))
      .catch(() => {});
  });
  return box;
}

async function ask(text, shown = text) {
  const message = String(text ?? '').trim();
  if (!message || !state || state.busy) return;
  state.busy = true;
  state.input.value = '';
  state.input.style.height = 'auto';
  state.list.querySelector('.assist-hello')?.remove();
  state.list.append(bubble({ role: 'user', text: shown }));
  const typing = h('div', { class: 'msg msg-bot msg-typing', 'aria-label': 'Ассистент думает' }, h('span'), h('span'), h('span'));
  state.list.append(typing);
  scrollDown();
  const page = PAGES[location.hash.replace(/^#\/?/, '').split('?')[0]];
  try {
    const res = await api('/admin/api/assistant', { method: 'POST', body: { message, context: { ...(page ? { page } : {}), ...(taskContext ? { task: taskContext } : {}) } } });
    typing.remove();
    state?.list.append(bubble({ role: 'assistant', text: res.reply, ...res }));
    // поставленные или изменённые задачи — обновить доску под окном
    if (res.prefs) {
      ctx.me.prefs = res.prefs;
      window.sorokaTheme?.apply(res.prefs);
    }
    if (res.refreshBell || res.actions?.length) refreshBell();
    if (!res.navigate && res.actions?.length && /^#\/(home|tasks|mytasks|calendar|clients|client|plans|docs|leads)?(\?|$)/.test(location.hash)) rerender();
    if (res.navigate) navigate(res.navigate.replace(/^#\//, '').split('?')[0], new URLSearchParams(res.navigate.split('?')[1] ?? ''));
  } catch (err) {
    typing.remove();
    state?.list.append(bubble({ role: 'assistant', text: err.message, error: true }));
    if (err.status === 429) toast('Слишком много сообщений подряд — подождите минуту');
  } finally {
    if (state) {
      state.busy = false;
      state.input.focus();
    }
    scrollDown();
  }
}
