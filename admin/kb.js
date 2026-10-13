// «Регламенты» — описания процессов агентства. Их читают сотрудники, а ассистент опирается на них,
// когда помогает с задачами. Добавляет и правит администратор: текстом или файлом .md / .txt.

import { h, api, app, shell, toast, navigate, ctx, fmtDateTime, confirmDialog } from './admin.js';
import { fill, formDialog } from './docs.js';

/** Простая разметка: «# заголовок», списки «- » и «1.», **жирный**, абзацы. */
function render(body) {
  const box = h('div', { class: 'kb-body' });
  const inline = (s) => s.split(/(\*\*[^*]+\*\*)/g).map((p) => (/^\*\*[^*]+\*\*$/.test(p) ? h('b', {}, p.slice(2, -2)) : p));
  for (const block of String(body).split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    if (!lines[0]) continue;
    const head = /^(#{1,4})\s+(.+)/.exec(lines[0]);
    if (head) {
      box.append(h(head[1].length <= 1 ? 'h2' : 'h3', {}, head[2]));
      lines.shift();
      if (!lines.length) continue;
    }
    if (lines.every((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l))) {
      const ordered = /^\s*\d/.test(lines[0]);
      box.append(h(ordered ? 'ol' : 'ul', {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))))));
    } else box.append(h('p', {}, lines.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)))));
  }
  return box;
}

export async function renderKb(params) {
  const isAdmin = ctx.me.role === 'admin';
  const id = params.get('id');
  const editing = params.get('edit') === '1' || params.get('new') === '1';
  const listBox = h('nav', { class: 'kb-list', 'aria-label': 'Регламенты' }, h('p', { class: 'muted small' }, 'Загружаю…'));
  const main = h('section', { class: 'kb-main' });
  fill(
    app,
    shell('kb', [
      h(
        'div',
        { class: 'page-head' },
        h('h1', {}, 'Регламенты'),
        h('span', { class: 'spacer' }),
        isAdmin ? h('a', { class: 'btn btn-primary', href: '#/kb?new=1' }, 'Добавить регламент') : null,
      ),
      h('p', { class: 'lead-text' }, 'Как в агентстве готовят КП, запускают рекламу, сдают отчёты. Ассистент опирается на эти описания, когда помогает с задачами.'),
      h('div', { class: 'kb' }, h('aside', { class: 'panel kb-side' }, listBox), main),
    ]),
  );

  let docs;
  try {
    docs = (await api('/admin/api/kb')).docs;
  } catch (err) {
    if (err.status !== 401) fill(listBox, h('p', { class: 'error' }, err.message));
    return;
  }
  fill(
    listBox,
    docs.length
      ? docs.map((d) => h('a', { class: 'kb-item', href: `#/kb?id=${d.id}`, 'aria-current': String(d.id) === id ? 'page' : null }, h('span', {}, d.title), h('span', { class: 'muted small' }, fmtDateTime(d.updated_at))))
      : h('p', { class: 'muted small' }, 'Пока пусто.'),
  );

  if (editing && isAdmin) return editor(id ? (await api(`/admin/api/kb/${id}`)).doc : null);
  if (!id) {
    fill(
      main,
      h(
        'div',
        { class: 'panel empty' },
        h('strong', {}, docs.length ? 'Выберите регламент слева' : 'Регламентов пока нет'),
        isAdmin ? 'Добавьте описание процесса текстом или загрузите файл .md или .txt — ассистент начнёт на него опираться.' : 'Их добавляет администратор.',
      ),
    );
    return;
  }
  let doc;
  try {
    doc = (await api(`/admin/api/kb/${id}`)).doc;
  } catch (err) {
    fill(main, h('p', { class: 'error' }, err.message));
    return;
  }
  fill(
    main,
    h(
      'article',
      { class: 'panel kb-doc' },
      h(
        'div',
        { class: 'kb-doc-head' },
        h('h1', {}, doc.title),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn btn-s btn-primary', onclick: () => applyDialog(doc) }, 'Запустить в проекте'),
        isAdmin ? h('a', { class: 'btn btn-s', href: `#/kb?id=${doc.id}&edit=1` }, 'Изменить') : null,
      ),
      h('p', { class: 'muted small' }, `Обновил ${doc.updated_by ?? '—'}, ${fmtDateTime(doc.updated_at)}`),
      render(doc.body),
    ),
  );

  function editor(cur) {
    const title = h('input', { class: 'input', id: 'kb-title', maxlength: 200, required: true, value: cur?.title ?? '', placeholder: 'Подготовка коммерческого предложения' });
    const body = h('textarea', { class: 'textarea kb-textarea', id: 'kb-body', required: true, placeholder: '# Шаг 1. Бриф\nЧто уточнить у клиента…\n\n# Шаг 2. Расчёт\n- медиаплан по нормативам\n- согласование с руководителем' }, cur?.body ?? '');
    const file = h('input', {
      type: 'file', accept: '.md,.txt,text/plain,text/markdown', hidden: true,
      onchange: async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        if (f.size > 100_000) return toast('Файл больше 100 КБ — разделите на несколько регламентов');
        body.value = await f.text();
        if (!title.value) title.value = f.name.replace(/\.(md|txt)$/i, '');
      },
    });
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Сохранить');
    fill(
      main,
      h(
        'form',
        {
          class: 'panel kb-edit',
          onsubmit: async (e) => {
            e.preventDefault();
            save.disabled = true;
            try {
              const res = await api(cur ? `/admin/api/kb/${cur.id}` : '/admin/api/kb', { method: cur ? 'PUT' : 'POST', body: { title: title.value, body: body.value } });
              toast('Регламент сохранён');
              navigate('kb', new URLSearchParams({ id: String(res.doc.id) }));
            } catch (err) {
              toast(err.message);
              save.disabled = false;
            }
          },
        },
        h('h2', {}, cur ? 'Изменить регламент' : 'Новый регламент'),
        h('div', { class: 'field' }, h('label', { for: 'kb-title' }, 'Название'), title),
        h('div', { class: 'field' }, h('label', { for: 'kb-body' }, 'Описание процесса'), body, h('span', { class: 'hint' }, 'Разделы — строкой «# Название раздела», списки — «- пункт». Чем конкретнее шаги, сроки и ответственные, тем точнее помогает ассистент.')),
        h(
          'div',
          { class: 'work-actions' },
          save,
          h('button', { type: 'button', class: 'btn', onclick: () => file.click() }, 'Загрузить из файла'),
          file,
          h('span', { class: 'spacer' }),
          cur
            ? h('button', {
                type: 'button', class: 'btn btn-s',
                onclick: async () => {
                  if (!(await confirmDialog(`Удалить регламент «${cur.title}»?`))) return;
                  await api(`/admin/api/kb/${cur.id}`, { method: 'DELETE' }).catch((err) => toast(err.message));
                  navigate('kb');
                },
              }, 'Удалить')
            : null,
          h('a', { class: 'btn btn-s', href: cur ? `#/kb?id=${cur.id}` : '#/kb' }, 'Отмена'),
        ),
      ),
    );
    title.focus();
  }
}

/** Регламент → задачи проекта: шаг — задача, пункты шага — её чек-лист. */
async function applyDialog(doc) {
  let outline;
  let projects;
  let team;
  try {
    [outline, projects, team] = await Promise.all([api(`/admin/api/kb/${doc.id}/outline`), api('/admin/api/projects').then((d) => d.projects), api('/admin/api/team').then((d) => d.team)]);
  } catch (err) {
    return toast(err.message);
  }
  if (!outline.steps.length) return toast('В регламенте нет шагов: разделите его заголовками «# Шаг …» и списками «- пункт»');
  const project = h('select', { class: 'select', id: 'ap-project' }, projects.map((p) => h('option', { value: p.internal ? 'none' : p.id }, p.name)));
  const board = h('select', { class: 'select', id: 'ap-board' });
  const who = h('select', { class: 'select', id: 'ap-who' }, h('option', { value: '' }, 'Не назначать'), team.map((u) => h('option', { value: u.id, selected: u.id === ctx.me.id }, u.id === ctx.me.id ? `${u.name} (я)` : u.name)));
  const loadBoards = async () => {
    fill(board, h('option', { value: '' }, `Новая доска «${doc.title.slice(0, 60)}»`));
    try {
      const { boards } = await api(`/admin/api/projects/${project.value}/boards`);
      for (const b of boards) board.append(h('option', { value: b.id }, `Доска «${b.name}»`));
    } catch {}
  };
  project.addEventListener('change', loadBoards);
  loadBoards();
  formDialog({
    title: `Запустить «${doc.title}»`,
    submitLabel: 'Создать задачи',
    body: [
      h('p', { class: 'muted' }, 'Каждый шаг регламента станет задачей, пункты шага — её чек-листом.'),
      h('ol', { class: 'apply-steps' }, outline.steps.map((st) => h('li', {}, h('span', {}, st.title), st.items.length ? h('span', { class: 'muted small' }, ` · ${st.items.length} в чек-листе`) : null))),
      h('div', { class: 'dialog-grid' },
        h('div', { class: 'field' }, h('label', { for: 'ap-project' }, 'Проект'), project),
        h('div', { class: 'field' }, h('label', { for: 'ap-board' }, 'Куда'), board),
        h('div', { class: 'field' }, h('label', { for: 'ap-who' }, 'Исполнитель'), who),
      ),
    ],
    onSubmit: async () => {
      const res = await api(`/admin/api/kb/${doc.id}/apply`, {
        method: 'POST',
        body: { clientId: project.value === 'none' ? null : Number(project.value), boardId: board.value ? Number(board.value) : null, assigneeId: who.value ? Number(who.value) : null },
      });
      toast(`Создано задач: ${res.tasks.length}`);
      navigate('tasks', new URLSearchParams({ project: project.value, board: String(res.board.id) }));
    },
  });
}
