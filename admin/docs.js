// Раздел «Документы»: список, создание из шаблона, редактор слайдов с превью, проверка и выгрузка; шаблоны.
// Формы редактора строятся по описанию полей с сервера (/admin/api/slide-types).

import { h, api, app, shell, toast, navigate, fmtDateTime, plural, ctx } from './admin.js';

const FORMATS = [
  ['pptx', 'PowerPoint'],
  ['pdf', 'PDF'],
  ['html', 'HTML'],
];
const SAVE_DELAY = 600;

/** replaceChildren, но как h(): массивы раскрываются, null и false пропускаются. */
const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));

let catalog = null;
async function loadCatalog() {
  catalog ??= await api('/admin/api/slide-types');
  return catalog;
}
const typeOf = (type) => catalog.types.find((t) => t.type === type);
const typeLabel = (type) => typeOf(type)?.label ?? type;

/** Пустое значение поля: число без значения — null, а не 0 (ноль — это тоже данные). */
function parseNum(v) {
  const t = String(v).replace(/[\s ]/g, '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Chrome запоминает масштаб подписей SVG при раскладке и не пересчитывает его, когда снаружи фрейма
 * меняется transform: подписи графиков съезжают. Повторная раскладка SVG это исправляет.
 */
function relayoutSvg(frame) {
  try {
    frame.contentDocument?.querySelectorAll('svg').forEach((svg) => {
      svg.style.display = 'none';
      svg.getBoundingClientRect();
      svg.style.display = '';
    });
  } catch {
    /* фрейм ещё не загружен */
  }
}

/** Модальное окно с формой. onSubmit бросает ошибку — она показывается в окне. */
function formDialog({ title, body, submitLabel, onSubmit }) {
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel);
  const dlg = h(
    'dialog',
    { class: 'dialog', 'aria-labelledby': 'dlg-title' },
    h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          error.hidden = true;
          try {
            await onSubmit();
            dlg.close();
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
          } finally {
            submit.disabled = false;
          }
        },
      },
      h('h2', { id: 'dlg-title' }, title),
      body,
      error,
      h('div', { class: 'work-actions' }, submit, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Отмена')),
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function download(exportId) {
  const a = h('a', { href: `/admin/api/exports/${exportId}`, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- список документов ----------

export async function renderDocs(params) {
  const list = h('div', {}, h('p', { class: 'muted' }, 'Загружаю…'));
  const creator = h('div');
  const count = h('span', { class: 'count num' });
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openCreator() }, 'Создать документ');
  fill(app, shell('docs', [h('div', { class: 'page-head' }, h('h1', {}, 'Документы'), count, h('span', { class: 'spacer' }), newBtn), creator, list]));

  let docs, templates;
  try {
    [{ documents: docs }, { templates }] = await Promise.all([api('/admin/api/documents'), api('/admin/api/templates')]);
  } catch (err) {
    if (err.status !== 401) fill(list, h('p', { class: 'error' }, err.message));
    return;
  }
  const tplName = Object.fromEntries(templates.map((t) => [t.id, t.name]));
  count.textContent = `${docs.length} ${plural(docs.length, 'документ', 'документа', 'документов')}`;

  function openCreator(templateId = null) {
    newBtn.hidden = true;
    fill(creator, createPanel(templates, templateId, () => {
      fill(creator, );
      newBtn.hidden = false;
    }));
    creator.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  if (params.get('new') || !docs.length) openCreator(params.get('new'));

  if (!docs.length) {
    fill(list, );
    return;
  }
  fill(list, 
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'leads docs' },
        h('thead', {}, h('tr', {}, ['Название', 'Шаблон', 'Слайдов', 'Выгрузок', 'Изменён'].map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          {},
          docs.map((d) => {
            const href = `#/doc?id=${d.id}`;
            return h(
              'tr',
              { onclick: () => (location.hash = href) },
              h(
                'td',
                {},
                h('a', { class: 'row-link company', href }, d.title),
                d.lead_id ? h('span', { class: 'task' }, `Из заявки #${d.lead_id}`) : null,
              ),
              h('td', {}, d.template ? (tplName[d.template] ?? h('span', { class: 'muted' }, 'удалён')) : h('span', { class: 'muted' }, 'с нуля')),
              h('td', { class: 'num' }, d.slides),
              h('td', { class: 'num' }, d.exports || h('span', { class: 'muted' }, '—')),
              h('td', { class: 'num nowrap' }, fmtDateTime(d.updated_at), h('span', { class: 'task' }, d.updated_by)),
            );
          }),
        ),
      ),
    ),
  );
}

/** Создание документа: выбор шаблона → данные для подстановки → редактор. */
function createPanel(templates, preselect, onCancel) {
  const choices = [{ id: '', name: 'Пустой документ', description: 'Слайды добавите сами.', types: [], variables: [] }, ...templates];
  const fields = h('div', { class: 'create-fields' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Создать и открыть');
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  let chosen = choices.find((c) => c.id === preselect) ?? choices.find((c) => c.id === 'builtin:kp') ?? choices[0];
  let leads = null;

  const radios = choices.map((t) =>
    h(
      'label',
      { class: 'tpl-choice' },
      h('input', { type: 'radio', name: 'tpl', value: t.id, checked: t === chosen, onchange: () => { chosen = t; fillFields(); } }),
      h('span', { class: 'tpl-name' }, t.name, t.builtin === false ? h('span', { class: 'tag' }, 'свой') : null),
      h('span', { class: 'tpl-desc' }, t.description || `${t.slides} ${plural(t.slides, 'слайд', 'слайда', 'слайдов')}`),
    ),
  );

  async function fillFields() {
    const title = h('input', { class: 'input', id: 'c-title', maxlength: 200, placeholder: chosen.id ? `${chosen.name} — название клиента` : 'Например: Отчёт за сентябрь' });
    const vars = chosen.variables.filter((v) => v.key !== 'date' && v.key !== 'manager');
    const inputs = Object.fromEntries(vars.map((v) => [v.key, h('input', { class: 'input', id: `c-${v.key}`, maxlength: 2000, placeholder: v.from.startsWith('lead.') ? 'Из заявки, если она выбрана' : '' })]));
    const lead = h('select', { class: 'select', id: 'c-lead' }, h('option', { value: '' }, 'Без заявки'));
    fill(fields, 
      h('div', { class: 'field' }, h('label', { for: 'c-title' }, 'Название документа'), title),
      chosen.id
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: 'c-lead' }, 'Заявка клиента'),
            lead,
            h('span', { class: 'hint' }, 'Клиент, услуга и задача подставятся из ответов квалификатора.'),
          )
        : null,
      vars.map((v) => h('div', { class: 'field' }, h('label', { for: `c-${v.key}` }, v.label), inputs[v.key])),
      chosen.variables.some((v) => v.key === 'date' || v.key === 'manager') ? h('p', { class: 'hint' }, 'Дата и менеджер подставятся автоматически.') : null,
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
        const body = { title: title.value.trim() || undefined };
        if (chosen.id) Object.assign(body, { templateId: chosen.id, values });
        if (lead.value) body.leadId = Number(lead.value);
        const { document: doc } = await api('/admin/api/documents', { method: 'POST', body });
        navigate('doc', new URLSearchParams({ id: String(doc.id) }));
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        submit.disabled = false;
      }
    };
    if (chosen.id) {
      leads ??= api('/admin/api/leads').then((d) => d.leads).catch(() => []);
      const rows = await leads;
      lead.append(
        ...rows.map((l) => {
          const company = l.answers.company?.raw ?? l.answers.company ?? 'Без названия';
          return h('option', { value: l.id }, `#${l.id} ${company}${l.is_test ? ' (тест)' : ''}`);
        }),
      );
    }
  }

  const form = h(
    'form',
    { class: 'panel create' },
    h('h2', {}, 'Новый документ'),
    h('fieldset', { class: 'tpl-choices' }, h('legend', { class: 'sr-only' }, 'Шаблон'), radios),
    fields,
    error,
    h('div', { class: 'work-actions' }, submit, h('button', { type: 'button', class: 'btn', onclick: onCancel }, 'Отмена')),
  );
  fillFields();
  return form;
}

// ---------- редактор ----------

let leaveGuard = null;
window.addEventListener('beforeunload', (e) => {
  if (leaveGuard?.()) e.preventDefault();
});
window.addEventListener('hashchange', () => leaveGuard?.flush?.());

export async function renderDoc(params) {
  const id = Number(params.get('id'));
  if (!id) return navigate('docs');
  fill(app, shell('docs', h('p', { class: 'muted' }, 'Загружаю…')));

  let doc, exportsList;
  try {
    await loadCatalog();
    ({ document: doc, exports: exportsList } = await api(`/admin/api/documents/${id}`));
  } catch (err) {
    if (err.status !== 401) fill(app, shell('docs', [h('p', { class: 'error' }, err.message), h('a', { href: '#/docs' }, 'Все документы')]));
    return;
  }

  const slides = doc.spec.slides;
  let current = Math.min(Number(params.get('slide') ?? 0), Math.max(slides.length - 1, 0));
  let qa = null;
  let qaStale = false;
  let dirty = false;
  let timer = null;
  let saving = null;

  // ----- сохранение -----
  const saveState = h('span', { class: 'save-state', role: 'status' }, 'Сохранено');
  function changed({ preview = true } = {}) {
    dirty = true;
    if (qa) qaStale = true;
    saveState.textContent = 'Изменения не сохранены';
    clearTimeout(timer);
    timer = setTimeout(() => save().then(() => preview && refreshPreview()).catch(() => {}), SAVE_DELAY);
  }
  async function save() {
    clearTimeout(timer);
    if (saving) await saving;
    if (!dirty) return;
    dirty = false;
    saveState.textContent = 'Сохраняю…';
    saving = api(`/admin/api/documents/${id}`, { method: 'PUT', body: { title: doc.title, spec: doc.spec } })
      .then(() => {
        saveState.textContent = 'Сохранено';
        renderQa();
      })
      .catch((err) => {
        dirty = true;
        saveState.textContent = `Не сохранено: ${err.message}`;
        throw err;
      })
      .finally(() => (saving = null));
    return saving;
  }
  leaveGuard = Object.assign(() => dirty, { flush: () => (dirty ? save().catch(() => {}) : null) });

  // ----- шапка -----
  const title = h('input', {
    class: 'doc-title', value: doc.title, maxlength: 200, 'aria-label': 'Название документа',
    oninput: (e) => { doc.title = e.target.value; changed({ preview: false }); },
  });
  const checkBtn = h('button', { type: 'button', class: 'btn', onclick: () => runCheck() }, 'Проверить');
  const exportBtns = FORMATS.map(([f, label]) => h('button', { type: 'button', class: 'btn', onclick: (e) => runExport(f, false, e.currentTarget) }, label));
  const more = h(
    'details',
    { class: 'menu' },
    h('summary', { class: 'btn' }, 'Ещё'),
    h(
      'div',
      { class: 'menu-list' },
      h('button', { type: 'button', onclick: () => { more.open = false; saveAsTemplate(); } }, 'Сохранить как шаблон'),
      h('a', { href: `/admin/api/documents/${id}/preview`, target: '_blank', rel: 'noopener', onclick: () => (more.open = false) }, 'Открыть весь документ'),
      doc.lead_id ? h('a', { href: `#/leads?lead=${doc.lead_id}` }, `Заявка #${doc.lead_id}`) : null,
      h('button', { type: 'button', class: 'danger', onclick: () => { more.open = false; removeDoc(); } }, 'Удалить документ'),
    ),
  );

  // ----- колонки -----
  const rail = h('ol', { class: 'rail-list' });
  const addType = h('select', { class: 'select', 'aria-label': 'Тип нового слайда' }, catalog.types.map((t) => h('option', { value: t.type }, t.label)));
  const formPane = h('section', { class: 'form-pane', 'aria-label': 'Содержание слайда' });
  const previewBox = h('div', { class: 'preview' });
  // Слайд в iframe — в натуральную величину 1920×1080, рамка уменьшается под ширину колонки
  new ResizeObserver(([e]) => {
    previewBox.style.setProperty('--pv-scale', String(e.contentRect.width / 1920));
    previewBox.querySelectorAll('iframe').forEach(relayoutSvg);
  }).observe(previewBox);
  const qaBox = h('section', { class: 'qa', 'aria-live': 'polite' });
  const exportsBox = h('section', { class: 'exports' });

  fill(app, 
    ...shell('docs', [
      h(
        'div',
        { class: 'doc-head' },
        h('a', { class: 'back', href: '#/docs' }, 'Документы'),
        title,
        saveState,
        h('span', { class: 'spacer' }),
        checkBtn,
        h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Скачать' }, h('span', { class: 'group-label' }, 'Скачать'), exportBtns),
        more,
      ),
      h(
        'div',
        { class: 'editor' },
        h(
          'aside',
          { class: 'rail', 'aria-label': 'Слайды' },
          rail,
          h('div', { class: 'add-slide' }, addType, h('button', { type: 'button', class: 'btn', onclick: addSlide }, 'Добавить слайд')),
        ),
        formPane,
        h('section', { class: 'preview-pane', 'aria-label': 'Превью' }, previewBox, qaBox, exportsBox),
      ),
    ]),
  );

  // ----- список слайдов -----
  function issuesBySlide() {
    const out = {};
    if (!qa) return out;
    for (const [level, list] of [['error', qa.errors], ['warning', qa.warnings]]) {
      for (const m of list) {
        const n = m.match(/^Слайд (\d+):/)?.[1];
        if (!n) continue;
        out[n - 1] ??= { error: 0, warning: 0 };
        out[n - 1][level] += 1;
      }
    }
    return out;
  }

  function renderRail() {
    const issues = qaStale ? {} : issuesBySlide();
    fill(rail, 
      ...slides.map((sl, i) => {
        const t = typeOf(sl.type);
        const is = issues[i];
        return h(
          'li',
          {},
          h(
            'button',
            { type: 'button', class: 'rail-item', 'aria-current': i === current ? 'true' : null, onclick: () => select(i) },
            h('span', { class: 'rail-n num' }, i + 1),
            h('span', { class: `swatch ${t?.theme ?? 'light'}`, 'aria-hidden': 'true' }),
            h('span', { class: 'rail-text' }, h('span', { class: 'rail-type' }, t?.label ?? sl.type), h('span', { class: 'rail-title' }, sl.title || 'Без заголовка')),
            is?.error ? h('span', { class: 'issue err', title: `Ошибок: ${is.error}` }, is.error) : is?.warning ? h('span', { class: 'issue warn', title: `Замечаний: ${is.warning}` }, is.warning) : null,
          ),
        );
      }),
    );
  }

  function select(i) {
    current = i;
    renderRail();
    renderForm();
    refreshPreview();
  }

  function addSlide() {
    const at = slides.length ? current + 1 : 0;
    slides.splice(at, 0, structuredClone(catalog.empty[addType.value]));
    current = at;
    changed();
    renderRail();
    renderForm();
    formPane.querySelector('input, textarea')?.focus();
  }

  function moveSlide(delta) {
    const to = current + delta;
    if (to < 0 || to >= slides.length) return;
    [slides[current], slides[to]] = [slides[to], slides[current]];
    current = to;
    changed();
    renderRail();
    renderForm();
  }

  function duplicateSlide() {
    slides.splice(current + 1, 0, structuredClone(slides[current]));
    current += 1;
    changed();
    renderRail();
    renderForm();
  }

  function deleteSlide() {
    if (!confirm(`Удалить слайд ${current + 1} «${slides[current].title || typeLabel(slides[current].type)}»?`)) return;
    slides.splice(current, 1);
    current = Math.max(0, Math.min(current, slides.length - 1));
    changed();
    renderRail();
    renderForm();
  }

  // ----- форма слайда -----
  function renderForm() {
    const sl = slides[current];
    if (!sl) {
      fill(formPane, 
        h('div', { class: 'empty' }, h('strong', {}, 'В документе нет слайдов'), 'Выберите тип слева и нажмите «Добавить слайд».'),
      );
      return;
    }
    const t = typeOf(sl.type);
    const n = slides.length;
    fill(formPane, 
      h(
        'div',
        { class: 'form-head' },
        h('h2', {}, `${current + 1}. ${t.label}`),
        h(
          'div',
          { class: 'slide-actions' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Переместить выше', title: 'Выше', disabled: current === 0, onclick: () => moveSlide(-1) }, '↑'),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Переместить ниже', title: 'Ниже', disabled: current === n - 1, onclick: () => moveSlide(1) }, '↓'),
          h('button', { type: 'button', class: 'btn btn-s', onclick: duplicateSlide }, 'Копия'),
          h('button', { type: 'button', class: 'btn btn-s', onclick: deleteSlide }, 'Удалить'),
        ),
      ),
      t.data ? h('p', { class: 'hint' }, 'Слайд с цифрами: укажите источник и статус данных — без них выгрузка не пройдёт.') : null,
      h('div', { class: 'fields' }, t.fields.map((f) => field(f, sl, `s${current}`, t.required.includes(f.key)))),
    );
  }

  /** Поле формы. obj — объект, в котором лежит значение (слайд, карточка повторяющегося блока, группа). */
  function field(f, obj, prefix, required = false) {
    const id = `${prefix}-${f.key}`;
    const label = h('label', { for: id }, f.label, required ? h('span', { class: 'req', title: 'Обязательное поле' }, ' *') : null);
    const hint = f.hint ? h('span', { class: 'hint' }, f.hint) : null;
    const wrap = (control, extra = null) => h('div', { class: `field f-${f.type}` }, label, control, hint, extra);

    switch (f.type) {
      case 'text':
      case 'textarea': {
        const counter = f.max ? h('span', { class: 'counter num', 'aria-hidden': 'true' }) : null;
        const count = (v) => {
          if (!counter) return;
          counter.textContent = `${v.length} / ${f.max}`;
          counter.classList.toggle('over', v.length > f.max);
        };
        const input = h(f.type === 'text' ? 'input' : 'textarea', {
          class: f.type === 'text' ? 'input' : 'textarea', id, value: f.type === 'text' ? (obj[f.key] ?? '') : null,
          oninput: (e) => { obj[f.key] = e.target.value; count(e.target.value); changed(); if (f.key === 'title' && obj === slides[current]) renderRail(); },
        }, f.type === 'textarea' ? (obj[f.key] ?? '') : null);
        count(String(obj[f.key] ?? ''));
        return wrap(input, counter);
      }
      case 'number': {
        const input = h('input', {
          class: 'input num', id, inputmode: 'decimal', value: obj[f.key] ?? '',
          oninput: (e) => {
            const v = parseNum(e.target.value);
            e.target.setAttribute('aria-invalid', Number.isNaN(v) ? 'true' : 'false');
            obj[f.key] = Number.isNaN(v) ? null : v;
            changed();
          },
        });
        return wrap(input);
      }
      case 'select': {
        const input = h('select', { class: 'select', id, onchange: (e) => { obj[f.key] = e.target.value; changed(); } }, f.options.map(([v, l]) => h('option', { value: v, selected: v === obj[f.key] }, l)));
        return wrap(input);
      }
      case 'checkbox':
        return h(
          'div',
          { class: 'field f-checkbox' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', id, checked: obj[f.key] === true, onchange: (e) => { obj[f.key] = e.target.checked; changed(); } }), f.label),
          hint,
        );
      case 'lines': {
        const input = h('textarea', {
          class: 'textarea', id, rows: Math.max(3, (obj[f.key]?.length ?? 0) + 1),
          oninput: (e) => { obj[f.key] = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); changed(); },
        }, (obj[f.key] ?? []).join('\n'));
        return h('div', { class: 'field f-lines' }, label, input, h('span', { class: 'hint' }, `По пункту на строку${f.max ? `, не больше ${f.max}` : ''}`));
      }
      case 'csv': {
        const input = h('input', {
          class: 'input', id, value: (obj[f.key] ?? []).join(', '),
          oninput: (e) => { obj[f.key] = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); changed(); },
        });
        return wrap(input);
      }
      case 'group': {
        obj[f.key] ??= {};
        return h('fieldset', { class: 'group' }, h('legend', {}, f.label), f.fields.map((sf) => field(sf, obj[f.key], id)));
      }
      case 'repeater':
        return repeater(f, obj, id, required);
      case 'chart':
        return chartEditor(f, obj, id);
      default:
        return null;
    }
  }

  function repeater(f, obj, id, required) {
    const box = h('fieldset', { class: 'group repeater' });
    const draw = () => {
      const items = (obj[f.key] ??= []);
      fill(box, 
        h('legend', {}, f.label, required ? h('span', { class: 'req', title: 'Обязательное поле' }, ' *') : null),
        items.map((item, i) =>
          h(
            'div',
            { class: 'rep-item' },
            h(
              'div',
              { class: 'rep-head' },
              h('span', {}, `${f.item} ${i + 1}`),
              h('button', {
                type: 'button', class: 'icon-btn', 'aria-label': `Удалить: ${f.item.toLowerCase()} ${i + 1}`, title: 'Удалить',
                onclick: () => { items.splice(i, 1); changed(); draw(); },
              }, '×'),
            ),
            h('div', { class: 'rep-fields' }, f.fields.map((sf) => field(sf, item, `${id}-${i}`))),
          ),
        ),
        h('button', {
          type: 'button', class: 'btn btn-s', disabled: f.max && items.length >= f.max,
          onclick: () => { items.push(Object.fromEntries(f.fields.map((sf) => [sf.key, sf.type === 'number' ? null : sf.type === 'csv' ? [] : '']))); changed(); draw(); },
        }, f.max && items.length >= f.max ? `Не больше ${f.max}` : `Добавить: ${f.item.toLowerCase()}`),
      );
    };
    draw();
    return box;
  }

  function chartEditor(f, obj, id) {
    const box = h('fieldset', { class: 'group chart-edit' });
    const draw = () => {
      const c = (obj[f.key] ??= { type: 'column', categories: [], series: [{ name: '', values: [] }] });
      c.series ??= [];
      c.categories ??= [];
      const sync = () => c.series.forEach((s) => (s.values = c.categories.map((_, i) => s.values?.[i] ?? null)));
      sync();
      const typeSel = h('select', { class: 'select', id: `${id}-type`, onchange: (e) => { c.type = e.target.value; changed(); } }, catalog.chartTypes.map(([v, l]) => h('option', { value: v, selected: v === c.type }, l)));
      const cell = (value, onInput, label, numeric) =>
        h('input', {
          class: `input${numeric ? ' num' : ''}`, value: value ?? '', 'aria-label': label, inputmode: numeric ? 'decimal' : null,
          oninput: (e) => {
            if (numeric) {
              const v = parseNum(e.target.value);
              e.target.setAttribute('aria-invalid', Number.isNaN(v) ? 'true' : 'false');
              onInput(Number.isNaN(v) ? null : v);
            } else onInput(e.target.value);
            changed();
          },
        });
      const table = h(
        'table',
        { class: 'grid-edit' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, 'Категория'),
            c.series.map((s, si) =>
              h(
                'th',
                { scope: 'col' },
                h(
                  'div',
                  { class: 'series-head' },
                  cell(s.name, (v) => (s.name = v), `Название ряда ${si + 1}`),
                  c.series.length > 1
                    ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Удалить ряд ${si + 1}`, title: 'Удалить ряд', onclick: () => { c.series.splice(si, 1); changed(); draw(); } }, '×')
                    : null,
                ),
              ),
            ),
            h('th', {}, c.series.length < 4 ? h('button', { type: 'button', class: 'btn btn-s', onclick: () => { c.series.push({ name: '', values: c.categories.map(() => null) }); changed(); draw(); } }, '+ ряд') : null),
          ),
        ),
        h(
          'tbody',
          {},
          c.categories.map((cat, ci) =>
            h(
              'tr',
              {},
              h('td', {}, cell(cat, (v) => (c.categories[ci] = v), `Категория ${ci + 1}`)),
              c.series.map((s, si) => h('td', {}, cell(s.values[ci], (v) => (s.values[ci] = v), `${s.name || `Ряд ${si + 1}`}, ${cat || `категория ${ci + 1}`}`, true))),
              h('td', {}, h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Удалить строку ${ci + 1}`, title: 'Удалить строку', onclick: () => { c.categories.splice(ci, 1); c.series.forEach((s) => s.values.splice(ci, 1)); changed(); draw(); } }, '×')),
            ),
          ),
        ),
      );
      fill(box, 
        h('legend', {}, f.label),
        h('div', { class: 'field' }, h('label', { for: `${id}-type` }, 'Вид'), typeSel),
        h('div', { class: 'grid-wrap' }, table),
        h('button', { type: 'button', class: 'btn btn-s', onclick: () => { c.categories.push(''); sync(); changed(); draw(); box.querySelector('tbody tr:last-child input')?.focus(); } }, '+ строка'),
        h('span', { class: 'hint' }, 'Числа без единиц: 1200 или 12,5. Ряд — то, что сравниваем (например, «План» и «Факт»).'),
      );
    };
    draw();
    return box;
  }

  // ----- превью: новый кадр грузится под старым (он остаётся видимым) и после загрузки его заменяет -----
  function refreshPreview() {
    if (!slides.length) {
      fill(previewBox, h('div', { class: 'preview-empty' }, 'Здесь будет слайд'));
      return;
    }
    const frame = h('iframe', { title: `Превью слайда ${current + 1}`, src: `/admin/api/documents/${id}/preview?slide=${current}&v=${Date.now()}`, tabindex: '-1' });
    frame.addEventListener('load', () => {
      relayoutSvg(frame);
      [...previewBox.children].filter((x) => x !== frame).forEach((x) => x.remove());
    });
    previewBox.prepend(frame);
  }

  // ----- проверка -----
  function renderQa() {
    renderRail();
    if (!qa) {
      fill(qaBox, 
        h('h3', {}, 'Проверка перед выгрузкой'),
        h('p', { class: 'muted' }, 'Смотрит заполненность, источники цифр, переносы и переполнение текста, кегль, поля, контраст и логотип. С ошибками документ не выгрузится.'),
      );
      return;
    }
    // «Слайд 3: …» — номер становится ссылкой на слайд
    const item = (m) => {
      const n = m.match(/^Слайд (\d+):\s*/);
      if (!n) return h('li', {}, m);
      return h('li', {}, h('button', { type: 'button', class: 'linkish', onclick: () => select(Number(n[1]) - 1) }, `Слайд ${n[1]}`), ' ', m.slice(n[0].length));
    };
    const summary = qa.ok
      ? h('p', { class: 'qa-ok' }, qa.warnings.length ? `Можно выгружать. Замечаний: ${qa.warnings.length}` : 'Можно выгружать')
      : h('p', { class: 'qa-bad' }, `Выгрузка заблокирована: ${qa.errors.length} ${plural(qa.errors.length, 'ошибка', 'ошибки', 'ошибок')}`);
    fill(qaBox, 
      h('h3', {}, 'Проверка перед выгрузкой'),
      qaStale ? h('p', { class: 'stale' }, 'Документ изменился после проверки — запустите её снова.') : null,
      summary,
      qa.errors.length ? h('ul', { class: 'qa-list err' }, qa.errors.map(item)) : null,
      qa.warnings.length ? h('details', { open: !qa.errors.length }, h('summary', {}, `Замечания (${qa.warnings.length})`), h('ul', { class: 'qa-list warn' }, qa.warnings.map(item))) : null,
      qa.forceFormat
        ? h(
            'div',
            { class: 'force' },
            h('p', { class: 'muted' }, 'Администратор может скачать черновик с ошибками — для внутреннего обсуждения, не для клиента.'),
            h('button', { type: 'button', class: 'btn btn-s', onclick: (e) => runExport(qa.forceFormat, true, e.currentTarget) }, `Скачать черновик ${qa.forceFormat.toUpperCase()}`),
          )
        : null,
    );
  }

  async function busy(btn, text, fn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function runCheck() {
    if (!slides.length) return toast('Добавьте хотя бы один слайд');
    await busy(checkBtn, 'Проверяю…', async () => {
      try {
        await save();
        qa = (await api(`/admin/api/documents/${id}/qa`, { method: 'POST', body: {} })).qa;
        qaStale = false;
        renderQa();
        if (!qa.ok) qaBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (err) {
        toast(err.message);
      }
    });
  }

  async function runExport(format, force, btn) {
    if (!slides.length) return toast('Добавьте хотя бы один слайд');
    await busy(btn, 'Готовлю…', async () => {
      try {
        await save();
        const res = await api(`/admin/api/documents/${id}/export`, { method: 'POST', body: { format, force } });
        qa = res.qa;
        qaStale = false;
        renderQa();
        download(res.exportId);
        toast(force ? 'Черновик скачан' : `${format.toUpperCase()} готов`);
        loadExports();
      } catch (err) {
        if (err.status === 422 && err.data.qa) {
          qa = { ...err.data.qa, forceFormat: err.data.canForce ? format : null };
          qaStale = false;
          renderQa();
          qaBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          toast('Выгрузка остановлена проверкой');
        } else toast(err.message);
      }
    });
  }

  // ----- история выгрузок -----
  function renderExports() {
    if (!exportsList.length) return fill(exportsBox, );
    fill(exportsBox, 
      h('h3', {}, 'Выгрузки'),
      h(
        'ul',
        { class: 'export-list' },
        exportsList.map((e) =>
          h(
            'li',
            {},
            h('a', { href: `/admin/api/exports/${e.id}`, download: '' }, e.format.toUpperCase()),
            h('span', { class: 'num' }, fmtDateTime(e.created_at)),
            h('span', { class: 'muted' }, e.created_by),
            e.forced ? h('span', { class: 'tag' }, 'черновик') : null,
          ),
        ),
      ),
    );
  }
  async function loadExports() {
    try {
      exportsList = (await api(`/admin/api/documents/${id}`)).exports;
      renderExports();
    } catch {
      /* список обновится при следующем открытии */
    }
  }

  // ----- шаблон и удаление -----
  async function saveAsTemplate() {
    await save().catch(() => {});
    let own = [];
    try {
      own = (await api('/admin/api/templates')).templates.filter((t) => !t.builtin);
    } catch {
      /* без списка — только новый шаблон */
    }
    const base = own.find((t) => t.id === doc.template);
    const name = h('input', { class: 'input', id: 't-name', required: true, maxlength: 120, value: base?.name ?? doc.title });
    const desc = h('textarea', { class: 'textarea', id: 't-desc', maxlength: 500 }, base?.description ?? '');
    const target = h(
      'select',
      { class: 'select', id: 't-target', onchange: () => { const t = own.find((x) => x.id === target.value); if (t) { name.value = t.name; desc.value = t.description; } } },
      h('option', { value: '' }, 'Новый шаблон'),
      own.map((t) => h('option', { value: t.id, selected: t.id === doc.template }, `Заменить «${t.name}»`)),
    );
    formDialog({
      title: 'Сохранить как шаблон',
      submitLabel: 'Сохранить шаблон',
      body: [
        h('p', { class: 'muted' }, 'Чтобы в шаблоне были подстановки, напишите в тексте {{client}}, {{date}}, {{manager}} — при создании документа они заменятся данными клиента.'),
        own.length ? h('div', { class: 'field' }, h('label', { for: 't-target' }, 'Куда'), target) : null,
        h('div', { class: 'field' }, h('label', { for: 't-name' }, 'Название'), name),
        h('div', { class: 'field' }, h('label', { for: 't-desc' }, 'Для чего'), desc),
      ],
      onSubmit: async () => {
        if (target.value) {
          await api(`/admin/api/templates/${target.value}`, { method: 'PUT', body: { name: name.value.trim(), description: desc.value.trim(), spec: doc.spec } });
        } else {
          await api('/admin/api/templates', { method: 'POST', body: { name: name.value.trim(), description: desc.value.trim(), fromDocument: id } });
        }
        toast('Шаблон сохранён');
      },
    });
  }

  async function removeDoc() {
    if (!confirm(`Удалить «${doc.title}» вместе с историей выгрузок? Это не отменить.`)) return;
    try {
      clearTimeout(timer);
      dirty = false;
      await api(`/admin/api/documents/${id}`, { method: 'DELETE' });
      toast('Документ удалён');
      navigate('docs');
    } catch (err) {
      toast(err.message);
    }
  }

  renderRail();
  renderForm();
  renderQa();
  renderExports();
  refreshPreview();
}

// ---------- шаблоны ----------

export async function renderTemplates() {
  const grid = h('div', { class: 'tpl-grid' }, h('p', { class: 'muted' }, 'Загружаю…'));
  fill(app, 
    ...shell('templates', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Шаблоны')),
      h('p', { class: 'lead-text' }, 'Встроенные шаблоны не меняются — правьте копию. Свой шаблон можно сделать из любого документа: «Ещё» → «Сохранить как шаблон».'),
      grid,
    ]),
  );
  let templates;
  try {
    [{ templates }] = await Promise.all([api('/admin/api/templates'), loadCatalog()]);
  } catch (err) {
    if (err.status !== 401) fill(grid, h('p', { class: 'error' }, err.message));
    return;
  }

  const editAsDocument = async (t) => {
    try {
      const { document: doc } = await api('/admin/api/documents', { method: 'POST', body: { templateId: t.id, keepVariables: true, title: t.builtin ? `${t.name} (копия)` : t.name } });
      navigate('doc', new URLSearchParams({ id: String(doc.id) }));
      toast('Отредактируйте и сохраните: «Ещё» → «Сохранить как шаблон»');
    } catch (err) {
      toast(err.message);
    }
  };

  fill(grid, 
    ...templates.map((t) =>
      h(
        'article',
        { class: 'panel tpl' },
        h('h2', {}, t.name),
        h('p', { class: 'tpl-meta' }, t.builtin ? 'Встроенный' : `Свой, ${t.created_by ?? ''}`.trim()),
        t.description ? h('p', {}, t.description) : null,
        h(
          'ol',
          { class: 'strip', 'aria-label': 'Слайды' },
          t.types.map((type) => h('li', {}, h('span', { class: `swatch ${typeOf(type)?.theme ?? 'light'}`, 'aria-hidden': 'true' }), typeLabel(type))),
        ),
        t.variables.length ? h('p', { class: 'muted vars' }, `Подставляется: ${t.variables.map((v) => v.label).join(', ')}`) : null,
        h(
          'div',
          { class: 'work-actions' },
          h('a', { class: 'btn btn-primary', href: `#/docs?new=${encodeURIComponent(t.id)}` }, 'Создать документ'),
          h('button', { type: 'button', class: 'btn', onclick: () => editAsDocument(t) }, t.builtin ? 'Изменить копию' : 'Изменить'),
          t.builtin
            ? null
            : h('button', {
                type: 'button', class: 'btn',
                onclick: async () => {
                  if (!confirm(`Удалить шаблон «${t.name}»? Созданные по нему документы останутся.`)) return;
                  try {
                    await api(`/admin/api/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
                    toast('Шаблон удалён');
                    renderTemplates();
                  } catch (err) {
                    toast(err.message);
                  }
                },
              }, 'Удалить'),
        ),
      ),
    ),
  );
}

// ---------- документы в карточке лида ----------

export function leadDocuments(lead) {
  const list = h('ul', { class: 'export-list' });
  const tplSel = h('select', { class: 'select', 'aria-label': 'Шаблон' });
  const create = h('button', { type: 'button', class: 'btn btn-primary' }, 'Создать');
  create.onclick = async () => {
    create.disabled = true;
    try {
      const { document: doc } = await api('/admin/api/documents', { method: 'POST', body: { templateId: tplSel.value, leadId: lead.id } });
      navigate('doc', new URLSearchParams({ id: String(doc.id) }));
    } catch (err) {
      toast(err.message);
      create.disabled = false;
    }
  };
  (async () => {
    try {
      const [{ documents }, { templates }] = await Promise.all([api(`/admin/api/leads/${lead.id}/documents`), api('/admin/api/templates')]);
      fill(tplSel, ...templates.map((t) => h('option', { value: t.id, selected: t.id === 'builtin:kp' }, t.name)));
      fill(list, 
        ...documents.map((d) => h('li', {}, h('a', { href: `#/doc?id=${d.id}` }, d.title), h('span', { class: 'num muted' }, fmtDateTime(d.updated_at)))),
      );
    } catch {
      /* блок останется пустым */
    }
  })();
  return h(
    'section',
    {},
    h('h3', {}, 'Документы'),
    list,
    h('div', { class: 'lead-doc' }, tplSel, create),
    h('p', { class: 'hint' }, `Клиент, услуга и задача подставятся из заявки${ctx.me ? ', менеджер — вы' : ''}.`),
  );
}
