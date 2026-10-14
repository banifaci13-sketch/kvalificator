// Раздел «Документы»: список, создание из шаблона, редактор слайдов с превью, проверка и выгрузка; шаблоны.
// Формы редактора строятся по описанию полей с сервера (/admin/api/slide-types).

import { h, api, app, shell, toast, navigate, fmtDateTime, plural, ctx, rowActions, rerender, confirmDialog, suggestInput } from './admin.js';

const FORMATS = [
  ['pptx', 'PowerPoint'],
  ['pdf', 'PDF'],
  ['html', 'HTML'],
];
const SAVE_DELAY = 600;

/** replaceChildren, но как h(): массивы раскрываются, null и false пропускаются. */
export const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));

let catalog = null;
let aiInfo = null;
/** Подключён ли ИИ на сервере (ключ YandexGPT или Claude). */
export async function loadAi() {
  aiInfo ??= await api('/admin/api/ai').catch(() => ({ enabled: false }));
  return aiInfo;
}
async function loadCatalog() {
  catalog ??= await api('/admin/api/slide-types');
  return catalog;
}
const typeOf = (type) => catalog.types.find((t) => t.type === type);
const typeLabel = (type) => typeOf(type)?.label ?? type;

/** Пустое значение поля: число без значения — null, а не 0 (ноль — это тоже данные). */
export function parseNum(v) {
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
export function formDialog({ title, body, submitLabel, onSubmit }) {
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

/** ИИ не подключён: что он умеет и что сделать — администратору ссылка на «Подключения». */
function aiNotice() {
  return h(
    'div',
    { class: 'note ai-notice full' },
    h('strong', {}, 'ИИ-помощник пока не подключён'),
    h('p', {}, 'Он собирает черновик презентации по брифу и заявке, сокращает и переписывает слайды. Цифр не придумывает, данные клиентов в модель не уходят.'),
    ctx.me?.role === 'admin'
      ? h('a', { class: 'btn btn-s', href: '#/integrations' }, 'Как подключить YandexGPT')
      : h('p', { class: 'muted' }, 'Попросите администратора подключить YandexGPT в разделе «Подключения».'),
  );
}

// ---------- фото: подготовка, загрузка, медиатека ----------

const MAX_SIDE = 2560;

/**
 * Перед загрузкой браузер сам разворачивает фото по EXIF (иначе в PowerPoint оно ляжет набок),
 * уменьшает до 2560 px и переводит WebP/HEIC в JPEG — сервер принимает только JPG и PNG.
 */
export async function prepareImage(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Не удалось открыть файл — сохраните его как JPG или PNG');
  }
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const png = file.type === 'image/png';
  // PNG без уменьшения — как есть (прозрачность, логотипы, скриншоты)
  if (png && k === 1) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('Не удалось подготовить изображение'))), png ? 'image/png' : 'image/jpeg', 0.9));
}

export async function uploadImage(file) {
  const blob = await prepareImage(file);
  const res = await fetch('/admin/api/media', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': blob.type, 'x-file-name': encodeURIComponent(file.name) },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Не удалось загрузить изображение');
  return data.media;
}

/** Окно медиатеки: выбрать загруженное раньше или загрузить новое. Возвращает выбранное или null. */
export function pickMedia() {
  return new Promise((done) => {
    let chosen = null;
    const grid = h('div', { class: 'media-grid' }, h('p', { class: 'muted' }, 'Загружаю…'));
    const fileInput = h('input', {
      type: 'file', accept: 'image/*', multiple: true, hidden: true,
      onchange: async (e) => {
        for (const file of e.target.files ?? []) {
          try {
            await uploadImage(file);
          } catch (err) {
            toast(`${file.name}: ${err.message}`);
          }
        }
        load();
      },
    });
    const dlg = h(
      'dialog',
      { class: 'dialog media-dialog', 'aria-labelledby': 'media-title' },
      h('div', { class: 'media-head' }, h('h2', { id: 'media-title' }, 'Медиатека'), fileInput, h('button', { type: 'button', class: 'btn btn-primary btn-s', onclick: () => fileInput.click() }, 'Загрузить файлы')),
      grid,
      h('div', { class: 'work-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Закрыть')),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      done(chosen);
    });
    async function load() {
      try {
        const { media } = await api('/admin/api/media');
        if (!media.length) return fill(grid, h('p', { class: 'muted' }, 'Пока пусто — загрузите фото или креативы.'));
        fill(
          grid,
          media.map((m) =>
            h(
              'button',
              { type: 'button', class: 'media-item', title: m.name ?? '', onclick: () => { chosen = m; dlg.close(); } },
              h('img', { src: `/admin/api/media/${m.id}`, alt: m.name ?? '', loading: 'lazy' }),
              h('span', { class: 'media-name' }, m.name ?? `Изображение ${m.id}`),
              h('span', { class: 'media-size num' }, `${m.width}×${m.height}`),
            ),
          ),
        );
      } catch (err) {
        fill(grid, h('p', { class: 'error' }, err.message));
      }
    }
    document.body.append(dlg);
    dlg.showModal();
    load();
  });
}

/** Мини-схема раскладки: прямоугольники в долях слайда — фото, текст, график, карточки. */
const SCHEMES = {
  'cover:left': [['t', 8, 30, 60, 14], ['t', 8, 50, 40, 6]],
  'cover:center': [['t', 20, 30, 60, 14], ['t', 30, 50, 40, 6]],
  'cover:image': [['p', 54, 0, 46, 100], ['t', 8, 30, 40, 14], ['t', 8, 50, 30, 6]],
  'chart:side': [['t', 6, 8, 50, 8], ['c', 6, 24, 56, 64], ['b', 66, 24, 28, 64]],
  'chart:side-left': [['t', 6, 8, 50, 8], ['b', 6, 24, 28, 64], ['c', 38, 24, 56, 64]],
  'chart:wide': [['t', 6, 8, 50, 8], ['c', 6, 22, 88, 44], ['b', 6, 72, 88, 16]],
  'strategy:columns': [['t', 6, 8, 50, 8], ['b', 6, 26, 28, 64], ['b', 36, 26, 28, 64], ['b', 66, 26, 28, 64]],
  'strategy:rows': [['t', 6, 8, 50, 8], ['b', 6, 26, 88, 18], ['b', 6, 48, 88, 18], ['b', 6, 70, 88, 18]],
  'image:right': [['t', 6, 10, 40, 10], ['t', 6, 26, 36, 30], ['p', 52, 8, 42, 80]],
  'image:left': [['p', 6, 8, 42, 80], ['t', 54, 10, 40, 10], ['t', 54, 26, 36, 30]],
  'image:wide': [['t', 6, 8, 50, 8], ['p', 6, 22, 88, 50], ['t', 6, 78, 60, 8]],
  'image:full': [['p', 0, 0, 100, 100], ['d', 0, 68, 100, 32], ['l', 6, 74, 60, 8]],
  'gallery:grid': [['t', 6, 8, 50, 8], ['p', 6, 24, 27, 30], ['p', 37, 24, 27, 30], ['p', 68, 24, 27, 30], ['p', 6, 58, 27, 30], ['p', 37, 58, 27, 30], ['p', 68, 58, 27, 30]],
  'gallery:feature': [['t', 6, 8, 50, 8], ['p', 6, 24, 52, 64], ['p', 62, 24, 32, 30], ['p', 62, 58, 32, 30]],
  'brief:grid': [['t', 6, 8, 50, 8], ['b', 6, 24, 43, 32], ['b', 51, 24, 43, 32], ['b', 6, 60, 43, 32], ['b', 51, 60, 43, 32]],
  'brief:rows': [['t', 6, 8, 50, 8], ['b', 6, 24, 30, 20], ['p', 40, 24, 54, 20], ['b', 6, 48, 30, 20], ['p', 40, 48, 54, 20], ['b', 6, 72, 30, 20], ['p', 40, 72, 54, 20]],
};
function layoutScheme(type, value) {
  const dark = (type === 'cover') || value === 'full';
  return h(
    'span',
    { class: `scheme${dark ? ' dark' : ''}`, 'aria-hidden': 'true' },
    (SCHEMES[`${type}:${value}`] ?? []).map(([k, x, y, w, hh]) => h('i', { class: `s-${k}`, style: `left:${x}%;top:${y}%;width:${w}%;height:${hh}%` })),
  );
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
  await loadAi();
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
        h('thead', {}, h('tr', {}, ['Название', 'Шаблон', 'Слайдов', 'Выгрузок', 'Изменён'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Действия')))),
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
              rowActions({
                name: d.title,
                onCopy: async () => {
                  const { document: copy } = await api(`/admin/api/documents/${d.id}/copy`, { method: 'POST', body: {} });
                  toast(`Создана копия «${copy.title}»`);
                  rerender();
                },
                onDelete: async () => {
                  if (!(await confirmDialog(`Удалить документ «${d.title}» вместе с историей выгрузок?`))) return;
                  await api(`/admin/api/documents/${d.id}`, { method: 'DELETE' });
                  toast('Документ удалён');
                  rerender();
                },
              }),
            );
          }),
        ),
      ),
    ),
  );
}

/** Создание документа: выбор шаблона → данные для подстановки → редактор. */
function createPanel(templates, preselect, onCancel) {
  const choices = [
    { id: 'ai', ai: true, name: 'Собрать с ИИ', description: aiInfo?.enabled ? 'Черновик по брифу и заявке. Цифр ИИ не придумывает — оставит заготовки.' : 'Черновик по брифу и заявке. Нужно подключить YandexGPT — покажем как.', variables: [] },
    { id: '', name: 'Пустой документ', description: 'Слайды добавите сами.', types: [], variables: [] },
    ...templates,
  ];
  const fields = h('div', { class: 'create-fields' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Создать и открыть');
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  let chosen = choices.find((c) => c.id === preselect) ?? choices.find((c) => c.id === 'builtin:kp') ?? choices[0];
  let leads = null;

  const radio = (t) =>
    h(
      'label',
      { class: 'tpl-choice' },
      h('input', { type: 'radio', name: 'tpl', value: t.id, checked: t === chosen, onchange: () => { chosen = t; fillFields(); } }),
      h('span', { class: 'tpl-name' }, t.name, t.builtin === false ? h('span', { class: 'tag' }, 'свой') : null, t.ai ? h('span', { class: 'tag tag-ai' }, 'ИИ') : null),
      h('span', { class: 'tpl-desc' }, t.description || `${t.slides} ${plural(t.slides, 'слайд', 'слайда', 'слайдов')}`),
    );
  // брифы клиенту — отдельной группой под основными шаблонами
  const briefs = choices.filter((t) => t.group === 'brief');
  const radios = [
    ...choices.filter((t) => t.group !== 'brief').map(radio),
    briefs.length ? h('p', { class: 'tpl-group' }, 'Брифы для клиента — анкета с полями для ответов: заполнить на созвоне или отправить в PDF и PowerPoint') : null,
    ...briefs.map(radio),
  ];

  async function fillFields() {
    if (chosen.ai) return fillAiFields();
    submit.disabled = false;
    submit.textContent = 'Создать и открыть';
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

  async function fillAiFields() {
    if (!aiInfo?.enabled) {
      submit.textContent = 'Собрать черновик';
      submit.disabled = true;
      fill(fields, aiNotice());
      return;
    }
    submit.disabled = false;
    submit.textContent = 'Собрать черновик';
    const kind = h('select', { class: 'select', id: 'ai-kind', onchange: () => ((kindTouched = true), mpHint()) }, Object.entries(aiInfo.kinds).map(([k, l]) => h('option', { value: k }, l)));
    let kindTouched = false;
    // вид документа — по словам из брифа, пока сотрудник не выбрал его сам
    const KIND_WORDS = [['mediaplan', /медиаплан|(^|[^а-яё])мп([^а-яё]|$)|распределени\S* бюджета/i], ['report', /отч[её]т/i], ['strategy', /стратеги/i], ['kp', /(^|[^а-яё])кп([^а-яё]|$)|коммерческ\S* предложени/i], ['pitch', /презентаци\S* агентства|о нас/i]];
    const mpNote = h('div', { class: 'ai-notice field full', hidden: true });
    function mpHint() {
      mpNote.hidden = kind.value !== 'mediaplan';
      if (mpNote.hidden) return;
      fill(
        mpNote,
        h('p', {}, 'Цифры медиаплана — бюджет, клики, заявки, CPL — точнее посчитать в калькуляторе: по нормативам агентства, с Excel и готовым слайдом. ИИ цифры не придумывает — в презентации оставит заготовки.'),
        h('button', {
          type: 'button', class: 'btn btn-s btn-primary',
          onclick: async () => {
            const { emptyPlan } = await import('/admin/lib/mediaplan-calc.js');
            const name = client.value.trim();
            try {
              const { mediaplan } = await api('/admin/api/mediaplans', { method: 'POST', body: { title: name ? `Медиаплан — ${name}` : 'Медиаплан', client: name, spec: { ...emptyPlan(), months: 3 } } });
              navigate('plan', new URLSearchParams({ id: String(mediaplan.id) }));
            } catch (err) {
              toast(err.message);
            }
          },
        }, 'Посчитать в калькуляторе'),
      );
    }
    const count = h('select', { class: 'select', id: 'ai-count' }, [6, 8, 10, 12].map((n) => h('option', { value: n, selected: n === 8 }, `${n} слайдов`)));
    const lead = h('select', { class: 'select', id: 'ai-lead' }, h('option', { value: '' }, 'Без заявки'));
    const brief = h('textarea', {
      class: 'textarea', id: 'ai-brief', rows: 7, maxlength: 6000,
      placeholder: 'Пишите как коллеге: что за бизнес и задача, что предлагаем (каналы, услуги), что уже известно — бюджет, текущие заявки, цели, сроки. Можно и пожелания к документу: «акцент на маркетплейсы», «без SEO», «сделай слайд про риски».',
    });
    let clientNames = [];
    const client = suggestInput(h('input', { class: 'input', id: 'ai-client', maxlength: 200, placeholder: 'Например, Юнистрим' }), () => clientNames);
    api('/admin/api/clients').then((d) => (clientNames = (d.clients ?? []).map((c) => c.name))).catch(() => {});
    // клиент из списка, упомянутый в брифе, — подставим сами, если поле пустое
    brief.addEventListener('input', () => {
      if (kindTouched) return;
      const hit = KIND_WORDS.find(([k, re]) => aiInfo.kinds[k] && re.test(brief.value));
      if (hit && kind.value !== hit[0]) {
        kind.value = hit[0];
        mpHint();
      }
    });
    brief.addEventListener('blur', () => {
      if (client.value.trim()) return;
      const text = brief.value.toLowerCase();
      const hit = clientNames.find((name) => name.length > 2 && text.includes(name.toLowerCase().replace(/^(ооо|ип|ао|пао|зао)\s+/, '').replace(/[«»"]/g, '')));
      if (hit) client.value = hit;
    });
    const title = h('input', { class: 'input', id: 'ai-title', maxlength: 200, placeholder: 'Предложит ИИ' });
    fill(
      fields,
      h('div', { class: 'field' }, h('label', { for: 'ai-kind' }, 'Что готовим'), kind, h('span', { class: 'hint' }, 'Подберём сами по тексту задания, если не выбрать.')),
      h('div', { class: 'field' }, h('label', { for: 'ai-lead' }, 'Заявка клиента'), lead, h('span', { class: 'hint' }, 'Ответы квалификатора уйдут в ИИ без названия компании и контактов.')),
      h('div', { class: 'field' }, h('label', { for: 'ai-client' }, 'Клиент'), client, h('span', { class: 'hint' }, 'Подставим в документ сами; в ИИ название не уходит.')),
      mpNote,
      h('div', { class: 'field full' }, h('label', { for: 'ai-brief' }, 'Задание для ИИ (бриф)'), brief, h('span', { class: 'hint' }, 'ИИ строит документ по этому тексту. Чем конкретнее задача, тем точнее черновик; цифр, которых здесь нет, он не придумает — оставит «[заполнить]».')),
      h('div', { class: 'field' }, h('label', { for: 'ai-count' }, 'Объём'), count),
      h('div', { class: 'field' }, h('label', { for: 'ai-title' }, 'Название документа'), title),
      h('p', { class: 'hint' }, `Черновик соберёт ${aiInfo.provider === 'yandexgpt' ? 'YandexGPT' : 'Claude'}. Это займёт до минуты; дальше правьте в редакторе как обычно.`),
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      submit.textContent = 'ИИ собирает черновик…';
      error.hidden = true;
      try {
        const body = { kind: kind.value, brief: brief.value.trim(), slides: Number(count.value) };
        if (lead.value) body.leadId = Number(lead.value);
        if (title.value.trim()) body.title = title.value.trim();
        if (client.value.trim()) body.client = client.value.trim();
        const res = await api('/admin/api/ai/draft', { method: 'POST', body });
        navigate('doc', new URLSearchParams({ id: String(res.document.id) }));
        toast(res.replaced ? `Черновик готов. Цифр без источника: ${res.replaced} — помечены «[заполнить]»` : 'Черновик готов — проверьте и доработайте');
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        submit.disabled = false;
        submit.textContent = 'Собрать черновик';
      }
    };
    leads ??= api('/admin/api/leads').then((d) => d.leads).catch(() => []);
    for (const l of await leads) {
      const company = l.answers.company?.raw ?? l.answers.company ?? 'Без названия';
      lead.append(h('option', { value: l.id, dataset: { company } }, `#${l.id} ${company}${l.is_test ? ' (тест)' : ''}`));
    }
    lead.addEventListener('change', () => {
      const company = lead.selectedOptions[0]?.dataset.company;
      if (company && company !== 'Без названия' && !client.value.trim()) client.value = company;
    });
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
    await Promise.all([loadCatalog(), loadAi()]);
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

  const linkedBar = (await import('./tasks.js')).linkedTasksBar('document', doc.id);
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
      linkedBar,
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

  async function deleteSlide() {
    if (!(await confirmDialog(`Удалить слайд ${current + 1} «${slides[current].title || typeLabel(slides[current].type)}»?`))) return;
    slides.splice(current, 1);
    current = Math.max(0, Math.min(current, slides.length - 1));
    changed();
    renderRail();
    renderForm();
  }

  // ----- ИИ: правка слайда -----
  let aiUndo = null; // { index, slide, replaced }
  async function aiEdit(action, index = current, instruction = '') {
    if (aiBusy) return;
    aiBusy = true;
    renderForm();
    try {
      await save();
      const res = await api('/admin/api/ai/slide', { method: 'POST', body: { documentId: id, index, action, instruction } });
      aiUndo = { index, slide: structuredClone(slides[index]), replaced: res.replaced };
      slides[index] = res.slide;
      current = index;
      changed();
      renderRail();
    } catch (err) {
      toast(err.message);
    } finally {
      aiBusy = false;
      renderForm();
    }
  }
  let aiBusy = false;

  function aiMenu() {
    if (!aiInfo?.enabled) {
      const off = h('details', { class: 'menu ai-menu' }, h('summary', { class: 'btn btn-s' }, 'ИИ'), h('div', { class: 'menu-list ai-off' }, aiNotice()));
      return off;
    }
    const menu = h(
      'details',
      { class: 'menu ai-menu' },
      h('summary', { class: 'btn btn-s', 'aria-disabled': aiBusy ? 'true' : null }, aiBusy ? 'ИИ думает…' : 'ИИ'),
      h(
        'div',
        { class: 'menu-list' },
        Object.entries(aiInfo.actions).map(([action, label]) =>
          h('button', {
            type: 'button',
            onclick: () => {
              menu.open = false;
              if (action !== 'custom') return aiEdit(action);
              const text = h('textarea', { class: 'textarea', id: 'ai-instruction', rows: 3, maxlength: 1000, required: true, placeholder: 'Например: перепиши заголовок как вопрос клиенту' });
              formDialog({
                title: 'Что сделать со слайдом',
                submitLabel: 'Попросить ИИ',
                body: [h('div', { class: 'field' }, h('label', { for: 'ai-instruction' }, 'Просьба'), text), h('p', { class: 'hint' }, 'Цифры, источник и статус данных ИИ не меняет.')],
                onSubmit: async () => aiEdit('custom', current, text.value),
              });
            },
          }, label),
        ),
      ),
    );
    if (aiBusy) menu.addEventListener('toggle', () => (menu.open = false));
    return menu;
  }

  function aiUndoBar() {
    if (!aiUndo || aiUndo.index !== current) return null;
    return h(
      'div',
      { class: 'ai-undo', role: 'status' },
      h('span', {}, 'ИИ изменил слайд.', aiUndo.replaced ? ` Цифр без источника: ${aiUndo.replaced} — заменены на «[заполнить]».` : ''),
      h('button', {
        type: 'button', class: 'linkish',
        onclick: () => {
          slides[aiUndo.index] = aiUndo.slide;
          aiUndo = null;
          changed();
          renderRail();
          renderForm();
        },
      }, 'Вернуть как было'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Скрыть', onclick: () => { aiUndo = null; renderForm(); } }, '×'),
    );
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
          aiMenu(),
          h('button', { type: 'button', class: 'btn btn-s', onclick: duplicateSlide }, 'Копия'),
          h('button', { type: 'button', class: 'btn btn-s', onclick: deleteSlide }, 'Удалить'),
        ),
      ),
      aiUndoBar(),
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
      case 'image':
        return imageField(f, obj, id);
      case 'layout':
        return layoutField(f, obj, id, slides[current].type);
      default:
        return null;
    }
  }

  // ----- фото и раскладки -----
  function imageField(f, obj, id) {
    const box = h('div', { class: 'field f-image' });
    const draw = () => {
      const mediaId = typeof obj[f.key] === 'number' ? obj[f.key] : null;
      const set = (v) => {
        obj[f.key] = v;
        changed();
        draw();
      };
      const fileInput = h('input', {
        type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/*', hidden: true, id: `${id}-file`,
        onchange: async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          status.textContent = 'Загружаю…';
          try {
            set((await uploadImage(file)).id);
          } catch (err) {
            status.textContent = '';
            toast(err.message);
          }
        },
      });
      const status = h('span', { class: 'hint', role: 'status' });
      fill(
        box,
        h('span', { class: 'label' }, f.label),
        h(
          'div',
          { class: 'image-pick' },
          mediaId
            ? h('img', { class: 'image-thumb', src: `/admin/api/media/${mediaId}`, alt: '' })
            : h('div', { class: 'image-thumb empty' }, 'Нет изображения'),
          h(
            'div',
            { class: 'image-actions' },
            fileInput,
            h('button', { type: 'button', class: 'btn btn-s', onclick: () => fileInput.click() }, mediaId ? 'Заменить' : 'Загрузить'),
            h('button', { type: 'button', class: 'btn btn-s', onclick: async () => { const m = await pickMedia(); if (m) set(m.id); } }, 'Из медиатеки'),
            mediaId ? h('button', { type: 'button', class: 'btn btn-s', onclick: () => set(null) }, 'Убрать') : null,
            status,
          ),
        ),
        h('span', { class: 'hint' }, 'JPG, PNG или фото с телефона. Большие снимки уменьшим до 2560 px — презентация останется лёгкой.'),
      );
    };
    draw();
    return box;
  }

  function layoutField(f, obj, id, type) {
    obj[f.key] ??= f.options[0][0];
    const group = h('fieldset', { class: 'layout-pick' }, h('legend', {}, f.label));
    const draw = () =>
      fill(
        group,
        h('legend', {}, f.label),
        h(
          'div',
          { class: 'layout-tiles' },
          f.options.map(([v, label]) =>
            h(
              'label',
              { class: 'layout-tile' },
              h('input', { type: 'radio', name: id, value: v, checked: obj[f.key] === v, onchange: () => { obj[f.key] = v; changed(); draw(); renderForm(); } }),
              layoutScheme(type, v),
              h('span', {}, label),
            ),
          ),
        ),
      );
    draw();
    return group;
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
      // переполненный текст ИИ может сократить прямо отсюда
      const shorten = aiInfo?.enabled && /не помещается/.test(m)
        ? h('button', { type: 'button', class: 'btn btn-s ai-fix', onclick: () => { select(Number(n[1]) - 1); aiEdit('shorten', Number(n[1]) - 1); } }, 'Сократить с ИИ')
        : null;
      return h('li', {}, h('button', { type: 'button', class: 'linkish', onclick: () => select(Number(n[1]) - 1) }, `Слайд ${n[1]}`), ' ', m.slice(n[0].length), shorten ? ' ' : null, shorten);
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
    if (!(await confirmDialog(`Удалить «${doc.title}» вместе с историей выгрузок? Это не отменить.`))) return;
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
    ...templates.flatMap((t, i) => [
      // заголовок группы перед первым брифом
      t.group === 'brief' && templates[i - 1]?.group !== 'brief' ? h('h2', { class: 'tpl-group-head' }, 'Брифы для клиента') : null,
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
                  if (!(await confirmDialog(`Удалить шаблон «${t.name}»? Созданные по нему документы останутся.`))) return;
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
    ]),
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
