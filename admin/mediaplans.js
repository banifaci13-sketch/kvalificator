// Раздел «Медиапланы»: список, редактор с живым пересчётом, сценарии, нормативы агентства.
// Расчёт — тот же модуль, что на сервере (Excel и слайды считаются по тем же правилам).

import { h, api, app, shell, toast, navigate, fmtDateTime, plural, ctx, rowActions, rerender, confirmDialog, suggestInput } from './admin.js';
import { fill, parseNum, formDialog } from './docs.js';
import { calcScenario, calcRow, emptyPlan, emptyRow, channelGroups, campaignHints, MODELS, KINDS } from '/admin/lib/mediaplan-calc.js';

const SAVE_DELAY = 600;
// с запасом под разбивку площадок на кампании (на слайд уходят итоги по площадкам, если строк больше 8)
const MAX_ROWS = 30;
const MAX_SCENARIOS = 6;
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const n0 = (v) => (v == null ? '—' : nf0.format(v));
const rub = (v) => (v == null ? '—' : `${nf0.format(v)} ₽`);
const pctText = (v) => (v == null ? '—' : `${nf1.format(v * 100)} %`);
const monthsText = (m) => `${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}`;

// ---------- список ----------

export async function renderPlans(params) {
  const list = h('div', {}, h('p', { class: 'muted' }, 'Загружаю…'));
  const creator = h('div');
  const count = h('span', { class: 'count num' });
  const newBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openCreator() }, 'Новый медиаплан');
  fill(app, shell('plans', [h('div', { class: 'page-head' }, h('h1', {}, 'Медиапланы'), count, h('span', { class: 'spacer' }), newBtn), creator, list]));

  let plans;
  try {
    plans = (await api('/admin/api/mediaplans')).mediaplans;
  } catch (err) {
    if (err.status !== 401) fill(list, h('p', { class: 'error' }, err.message));
    return;
  }
  count.textContent = `${plans.length} ${plural(plans.length, 'медиаплан', 'медиаплана', 'медиапланов')}`;

  function openCreator() {
    newBtn.hidden = true;
    const title = h('input', { class: 'input', id: 'p-title', maxlength: 200, placeholder: 'Медиаплан на IV квартал' });
    const client = h('input', { class: 'input', id: 'p-client', maxlength: 200 });
    const months = h('input', { class: 'input num', id: 'p-months', inputmode: 'numeric', value: '3' });
    const kind = h('select', { class: 'select', id: 'p-kind' }, KINDS.map(([k, l]) => h('option', { value: k }, l)));
    const lead = h('select', { class: 'select', id: 'p-lead', onchange: () => { if (lead.value) client.value = lead.selectedOptions[0].dataset.company; } }, h('option', { value: '' }, 'Без заявки'));
    const error = h('p', { class: 'error', role: 'alert', hidden: true });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Создать и открыть');
    const form = h(
      'form',
      {
        class: 'panel create',
        onsubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          try {
            const spec = { ...emptyPlan(kind.value), months: Math.round(parseNum(months.value) || 1) };
            // интернет-магазин: бюджеты обычно считают с НДС, как в кабинетах при пополнении
            if (kind.value === 'ecom') spec.settings = { ...spec.settings, vat: 22, budgetWithVat: true };
            const body = { title: title.value.trim(), client: client.value.trim(), spec };
            if (lead.value) body.leadId = Number(lead.value);
            const { mediaplan } = await api('/admin/api/mediaplans', { method: 'POST', body });
            navigate('plan', new URLSearchParams({ id: String(mediaplan.id) }));
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h('h2', {}, 'Новый медиаплан'),
      h(
        'div',
        { class: 'create-fields' },
        h('div', { class: 'field' }, h('label', { for: 'p-title' }, 'Название'), title),
        h('div', { class: 'field' }, h('label', { for: 'p-lead' }, 'Заявка клиента'), lead),
        h('div', { class: 'field' }, h('label', { for: 'p-client' }, 'Клиент'), client),
        h('div', { class: 'field' }, h('label', { for: 'p-months' }, 'Период, месяцев'), months),
        h('div', { class: 'field' }, h('label', { for: 'p-kind' }, 'Что считаем'), kind, h('span', { class: 'hint' }, 'Интернет-магазин: корзины, продажи, выручка и ДРР по каждой площадке')),
      ),
      error,
      h('div', { class: 'work-actions' }, submit, h('button', { type: 'button', class: 'btn', onclick: () => { fill(creator); newBtn.hidden = false; } }, 'Отмена')),
    );
    fill(creator, form);
    title.focus();
    api('/admin/api/leads')
      .then(({ leads }) => {
        for (const l of leads) {
          const company = l.answers.company?.raw ?? l.answers.company ?? '';
          lead.append(h('option', { value: l.id, dataset: { company } }, `#${l.id} ${company || 'Без названия'}${l.is_test ? ' (тест)' : ''}`));
        }
      })
      .catch(() => {});
  }

  if (params?.get('new') && plans.length) openCreator();
  if (!plans.length) {
    openCreator();
    fill(list, h('p', { class: 'note' }, 'Совет: сначала заполните «Нормативы» — средние ставки, CTR и конверсию по каналам из прошлых кампаний. Тогда канал добавляется в план одним кликом, а цифры в расчёте обоснованы.'));
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
        h('thead', {}, h('tr', {}, ['Медиаплан', 'Период', 'Сценариев', 'К оплате за период', 'Результат', 'Изменён'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Действия')))),
        h(
          'tbody',
          {},
          plans.map((p) => {
            const href = `#/plan?id=${p.id}`;
            return h(
              'tr',
              { onclick: () => (location.hash = href) },
              h('td', {}, h('a', { class: 'row-link company', href }, p.title), p.client ? h('span', { class: 'task' }, p.client) : null),
              h('td', { class: 'nowrap' }, monthsText(p.months ?? 1)),
              h('td', { class: 'num' }, p.scenarios),
              h('td', { class: 'num nowrap' }, rub(p.total)),
              h('td', { class: 'num nowrap' }, p.kind === 'ecom' ? `${n0(p.sales)} продаж` : `${n0(p.leads)} лидов`),
              h('td', { class: 'num nowrap' }, fmtDateTime(p.updated_at), h('span', { class: 'task' }, p.updated_by)),
              rowActions({
                name: p.title,
                onCopy: async () => {
                  const { mediaplan } = await api(`/admin/api/mediaplans/${p.id}/copy`, { method: 'POST', body: {} });
                  toast(`Создана копия «${mediaplan.title}»`);
                  rerender();
                },
                onDelete: async () => {
                  if (!(await confirmDialog(`Удалить медиаплан «${p.title}»?`))) return;
                  await api(`/admin/api/mediaplans/${p.id}`, { method: 'DELETE' });
                  toast('Медиаплан удалён');
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

// ---------- редактор ----------

let leaveGuard = null;
window.addEventListener('beforeunload', (e) => {
  if (leaveGuard?.()) e.preventDefault();
});
window.addEventListener('hashchange', () => leaveGuard?.flush?.());

export async function renderPlan(params) {
  const id = Number(params.get('id'));
  if (!id) return navigate('plans');
  fill(app, shell('plan', h('p', { class: 'muted' }, 'Загружаю…')));
  let plan, benchmarks;
  try {
    [{ mediaplan: plan }, { benchmarks }] = await Promise.all([api(`/admin/api/mediaplans/${id}`), api('/admin/api/benchmarks')]);
  } catch (err) {
    if (err.status !== 401) fill(app, shell('plan', [h('p', { class: 'error' }, err.message), h('a', { href: '#/plans' }, 'Все медиапланы')]));
    return;
  }
  const spec = plan.spec;
  spec.settings ??= {};
  let current = 0;
  let dirty = false;
  let timer = null;
  let saving = null;

  // ----- сохранение -----
  const saveState = h('span', { class: 'save-state', role: 'status' }, 'Сохранено');
  function changed() {
    dirty = true;
    saveState.textContent = 'Изменения не сохранены';
    clearTimeout(timer);
    timer = setTimeout(() => save().catch(() => {}), SAVE_DELAY);
    renderResults();
  }
  async function save() {
    clearTimeout(timer);
    if (saving) await saving;
    if (!dirty) return;
    dirty = false;
    saveState.textContent = 'Сохраняю…';
    saving = api(`/admin/api/mediaplans/${id}`, { method: 'PUT', body: { title: plan.title, client: plan.client ?? '', spec } })
      .then(() => (saveState.textContent = 'Сохранено'))
      .catch((err) => {
        dirty = true;
        saveState.textContent = `Не сохранено: ${err.message}`;
        throw err;
      })
      .finally(() => (saving = null));
    return saving;
  }
  leaveGuard = Object.assign(() => dirty, { flush: () => (dirty ? save().catch(() => {}) : null) });

  // ----- поля -----
  const numInput = (obj, key, { label, id: inputId, unit = '', placeholder = '' }) =>
    h('input', {
      class: 'input num', id: inputId, inputmode: 'decimal', value: obj[key] == null ? '' : String(obj[key]).replace('.', ','), placeholder, 'aria-label': label,
      oninput: (e) => {
        const v = parseNum(e.target.value);
        e.target.setAttribute('aria-invalid', Number.isNaN(v) ? 'true' : 'false');
        obj[key] = Number.isNaN(v) ? null : v;
        changed();
      },
      title: unit ? `${label}, ${unit}` : label,
    });

  const title = h('input', { class: 'doc-title', value: plan.title, maxlength: 200, 'aria-label': 'Название медиаплана', oninput: (e) => { plan.title = e.target.value; changed(); } });
  const client = h('input', { class: 'input', id: 'mp-client', value: plan.client ?? '', maxlength: 200, oninput: (e) => { plan.client = e.target.value; changed(); } });
  const months = h('input', {
    class: 'input num', id: 'mp-months', inputmode: 'numeric', value: spec.months ?? 1,
    oninput: (e) => {
      const v = parseNum(e.target.value);
      const ok = Number.isInteger(v) && v >= 1 && v <= 36;
      e.target.setAttribute('aria-invalid', ok ? 'false' : 'true');
      if (ok) {
        spec.months = v;
        changed();
      }
    },
  });

  const settings = h(
    'section',
    { class: 'panel mp-settings', 'aria-label': 'Условия' },
    h('div', { class: 'field' }, h('label', { for: 'mp-client' }, 'Клиент'), client),
    h('div', { class: 'field' }, h('label', { for: 'mp-months' }, 'Период, мес.'), months),
    h('div', { class: 'field' }, h('label', { for: 'mp-fee' }, 'Комиссия агентства, %'), numInput(spec.settings, 'agencyFee', { label: 'Комиссия агентства', id: 'mp-fee', placeholder: 'нет' })),
    h('div', { class: 'field' }, h('label', { for: 'mp-fixed' }, 'Фикс. комиссия, ₽/мес'), numInput(spec.settings, 'agencyFixed', { label: 'Фиксированная часть комиссии в месяц, без НДС', id: 'mp-fixed', placeholder: 'нет' })),
    h('div', { class: 'field' }, h('label', { for: 'mp-vat' }, 'НДС, %'), numInput(spec.settings, 'vat', { label: 'НДС', id: 'mp-vat', placeholder: 'без НДС' })),
    spec.kind === 'ecom'
      ? null
      : h('div', { class: 'field' }, h('label', { for: 'mp-sale' }, 'Конверсия в продажу, %'), numInput(spec.settings, 'saleRate', { label: 'Конверсия лида в продажу', id: 'mp-sale', placeholder: 'не считать' })),
    h('div', { class: 'field' }, h('label', { for: 'mp-check' }, spec.kind === 'ecom' ? 'Средний чек, ₽' : 'Средний чек, ₽'), numInput(spec.settings, 'avgCheck', { label: 'Средний чек', id: 'mp-check', placeholder: 'не считать' })),
    h(
      'div',
      { class: 'field mp-kind' },
      h('label', { for: 'mp-kind' }, 'Вид плана'),
      h('select', {
        class: 'select', id: 'mp-kind',
        onchange: async (e) => {
          spec.kind = e.target.value;
          changed();
          await save().catch(() => {});
          renderPlan(params);
        },
      }, KINDS.map(([k, l]) => h('option', { value: k, selected: k === (spec.kind ?? 'leads') }, l))),
    ),
    h(
      'label',
      { class: 'check mp-vat-flag' },
      h('input', { type: 'checkbox', checked: Boolean(spec.settings.budgetWithVat), onchange: (e) => { spec.settings.budgetWithVat = e.target.checked; changed(); renderScenario(); } }),
      'Бюджеты ввожу с НДС',
    ),
  );

  const tabs = h('div', { class: 'mp-tabs', role: 'tablist', 'aria-label': 'Сценарии' });
  const scenarioBox = h('section', { class: 'panel mp-scenario' });
  const results = h('section', { class: 'mp-results', 'aria-live': 'polite' });
  const compare = h('section');
  const assumptions = h('textarea', {
    class: 'textarea', id: 'mp-assumptions', maxlength: 2000,
    placeholder: 'Например: средний чек и конверсия в сделку — по CRM клиента за 2025 год; сезонность не учтена.',
    oninput: (e) => { spec.assumptions = e.target.value; changed(); },
  }, spec.assumptions ?? '');

  // Скачать: Excel с формулами, PDF со всеми сценариями, картинка текущего сценария
  const FORMATS = [
    ['xlsx', 'Excel', 'Таблица с формулами — можно менять цифры'],
    ['pdf', 'PDF', spec.scenarios.length > 1 ? 'Все сценарии и сравнение — для отправки клиенту' : 'Для отправки клиенту и печати'],
    ['png', 'PNG', 'Картинка сценария — в мессенджер или презентацию'],
    ['jpg', 'JPG', 'Картинка полегче — для почты и мессенджеров'],
  ];
  const downloadMenu = h(
    'details',
    { class: 'menu download-menu' },
    h('summary', { class: 'btn' }, 'Скачать ▾'),
    h(
      'div',
      { class: 'menu-list' },
      FORMATS.map(([f, label, hint]) =>
        h('button', { type: 'button', class: 'menu-format', onclick: () => { downloadMenu.open = false; download(f); } }, h('b', {}, label), h('span', { class: 'muted small' }, hint)),
      ),
    ),
  );

  const more = h(
    'details',
    { class: 'menu' },
    h('summary', { class: 'btn' }, 'Ещё'),
    h(
      'div',
      { class: 'menu-list' },
      plan.lead_id ? h('a', { href: `#/leads?lead=${plan.lead_id}` }, `Заявка #${plan.lead_id}`) : null,
      h('button', { type: 'button', class: 'danger', onclick: () => { more.open = false; removePlan(); } }, 'Удалить медиаплан'),
    ),
  );

  const linkedBar = (await import('./tasks.js')).linkedTasksBar('mediaplan', plan.id);
  fill(
    app,
    shell('plan', [
      h(
        'div',
        { class: 'doc-head' },
        h('a', { class: 'back', href: '#/plans' }, 'Медиапланы'),
        title,
        saveState,
        h('span', { class: 'spacer' }),
        downloadMenu,
        h('button', { type: 'button', class: 'btn btn-primary', onclick: toDocument }, 'В презентацию'),
        more,
      ),
      linkedBar,
      settings,
      h('div', { class: 'mp-tabs-row' }, tabs),
      h('div', { class: `mp-layout${spec.kind === 'ecom' ? ' wide' : ''}` }, scenarioBox, results),
      compare,
      h('section', { class: 'panel mp-notes' }, h('div', { class: 'field' }, h('label', { for: 'mp-assumptions' }, 'На чём основан прогноз'), assumptions, h('span', { class: 'hint' }, 'Попадает в Excel и под таблицу на слайде.'))),
    ]),
  );

  // ----- сценарии -----
  function renderTabs() {
    fill(
      tabs,
      spec.scenarios.map((sc, i) =>
        h('button', { type: 'button', role: 'tab', class: 'mp-tab', 'aria-selected': i === current ? 'true' : 'false', onclick: () => { current = i; renderAll(); } }, sc.name || `Сценарий ${i + 1}`),
      ),
      spec.scenarios.length < MAX_SCENARIOS
        ? h('button', {
            type: 'button', class: 'btn btn-s', title: 'Копия текущего сценария',
            onclick: () => {
              const copy = structuredClone(spec.scenarios[current]);
              copy.name = `${copy.name} (копия)`;
              spec.scenarios.push(copy);
              current = spec.scenarios.length - 1;
              changed();
              renderAll();
              scenarioBox.querySelector('.mp-name')?.select();
            },
          }, '+ сценарий')
        : null,
    );
  }

  // Колонки таблицы зависят от вида плана: лиды (услуги) или интернет-магазин
  function columns() {
    const budgetSub = spec.settings.budgetWithVat ? '₽ в мес., с НДС' : '₽ в мес., без НДС';
    const common = [
      { key: 'budget', title: 'Бюджет', sub: budgetSub, unit: '₽', ph: budgetSub.replace(/^₽ /, '') },
      { key: 'cpc', title: 'CPC', sub: 'клик без НДС, ₽', unit: '₽', ph: '₽', rate: 'cpc' },
      { key: 'cpm', title: 'CPM', sub: '1000 показов, ₽', unit: '₽', ph: '₽', rate: 'cpm' },
      { key: 'ctr', title: 'CTR', sub: 'кликабельность, %', unit: '%', ph: '%' },
    ];
    if (spec.kind === 'ecom') {
      return {
        inputs: [
          common[0],
          // одна ставка: CPC при закупке кликов, CPM — показов
          { key: 'rate', title: 'Ставка', sub: 'CPC или CPM без НДС, ₽', unit: '₽', ph: '₽' },
          common[3],
          { key: 'cart', title: 'CR1', sub: 'клик → корзина, %', unit: '%', ph: '%' },
          { key: 'sale', title: 'CR2', sub: 'клик → продажа, %', unit: '%', ph: '%' },
          { key: 'check', title: 'Ср. чек', sub: '₽; пусто — общий', unit: '₽', ph: spec.settings.avgCheck ? String(spec.settings.avgCheck) : '₽' },
        ],
        outputs: [
          { key: 'clicks', title: 'Клики', fmt: n0 },
          { key: 'carts', title: 'Корзины', fmt: n0 },
          { key: 'cpa', title: 'CPA', sub: 'цена корзины', fmt: rub },
          { key: 'sales', title: 'Продажи', fmt: n0 },
          { key: 'cps', title: 'CPS', sub: 'цена продажи', fmt: rub },
          { key: 'revenue', title: 'Выручка', fmt: rub },
          { key: 'drr', title: 'ДРР', fmt: pctText },
        ],
      };
    }
    return {
      inputs: [...common, { key: 'cr', title: 'Конверсия', sub: 'клик → лид, %', unit: '%', ph: '%' }],
      outputs: [
        { key: 'impressions', title: 'Показы', fmt: n0 },
        { key: 'clicks', title: 'Клики', fmt: n0 },
        { key: 'leads', title: 'Лиды', fmt: n0 },
        { key: 'cpl', title: 'CPL', sub: 'цена лида, ₽', fmt: rub },
      ],
    };
  }

  function renderScenario() {
    const sc = spec.scenarios[current];
    const ecom = spec.kind === 'ecom';
    const { inputs, outputs } = columns();
    const calc = () => sc.rows.map((r) => calcRow(r, spec));
    const out = {};
    // группы строк одной площадки: у группы итог, у строк внутри — отметка «кампания площадки»
    const groups = channelGroups(sc.rows);
    const groupOf = (i) => groups.find((g) => i >= g.from && i <= g.to);
    const subtotals = [];
    const addCampaign = (i) => {
      const row = sc.rows[i];
      const g = groupOf(i);
      // новая кампания встаёт в конец своей площадки: ставки разные у поиска и РСЯ — вписываются заново
      sc.rows.splice(g.to + 1, 0, { ...emptyRow(), channel: row.channel, model: row.model });
      changed();
      renderScenario();
      scenarioBox.querySelectorAll('tbody tr.mp-row')[g.to + 1]?.querySelector('.mp-campaign')?.focus();
    };
    const rowEls = sc.rows.map((row, i) => {
      const name = row.channel || `${ecom ? 'площадка' : 'канал'} ${i + 1}`;
      // «Ставка» пишет в cpc или cpm — по модели закупки строки
      const rateProxy = {
        get rate() { return row.model === 'cpm' ? row.cpm : row.cpc; },
        set rate(v) { if (row.model === 'cpm') row.cpm = v; else row.cpc = v; },
      };
      const fields = Object.fromEntries(inputs.map((c) => [c.key, numInput(c.key === 'rate' ? rateProxy : row, c.key, { label: `${c.title}, ${name}`, unit: c.unit, placeholder: c.ph })]));
      // ставка нужна только для выбранной модели закупки — вторая выключается с пометкой
      const syncModel = () => {
        if (fields.rate) {
          fields.rate.value = rateProxy.rate == null ? '' : String(rateProxy.rate).replace('.', ',');
          fields.rate.title = row.model === 'cpm' ? 'Цена 1000 показов без НДС, ₽' : 'Цена клика без НДС, ₽';
          return;
        }
        fields.cpc.disabled = row.model !== 'cpc';
        fields.cpm.disabled = row.model !== 'cpm';
        fields.cpc.placeholder = fields.cpc.disabled ? 'не нужна' : '₽';
        fields.cpm.placeholder = fields.cpm.disabled ? 'не нужна' : '₽';
      };
      syncModel();
      out[i] = Object.fromEntries(outputs.map((c) => [c.key, h('td', { class: 'num calc' })]));
      const b = benchmarks.find((x) => x.id === row.benchmark);
      const g = groupOf(i);
      const grouped = g.to > g.from;
      const campaign = suggestInput(
        h('input', {
          class: 'input mp-campaign', value: row.campaign ?? '', maxlength: 120, 'aria-label': `Тип размещения или кампания, ${name}`,
          placeholder: 'Тип или кампания: поиск, РСЯ…',
          oninput: (e) => { row.campaign = e.target.value; changed(); },
        }),
        () => campaignHints(row.channel),
      );
      return h(
        'tr',
        { class: `mp-row${grouped ? ' mp-grouped' : ''}${grouped && i > g.from ? ' mp-sub' : ''}` },
        h(
          'td',
          { class: 'mp-channel' },
          h('input', {
            class: 'input', value: row.channel ?? '', maxlength: 120, 'aria-label': `${ecom ? 'Площадка' : 'Канал'} ${i + 1}`, placeholder: ecom ? 'Площадка' : 'Канал',
            oninput: (e) => { row.channel = e.target.value; changed(); },
            // площадка поменялась — строки перегруппируются (итог по площадке)
            onchange: () => renderScenario(),
          }),
          campaign,
          ecom
            ? h('textarea', {
                class: 'textarea mp-targeting', rows: 2, maxlength: 1000, 'aria-label': `Таргетинг, ${name}`,
                placeholder: 'Таргетинг: по сегменту на строку',
                oninput: (e) => { row.targeting = e.target.value; changed(); },
              }, row.targeting ?? '')
            : null,
          b ? h('span', { class: 'hint', title: b.note }, 'по нормативу') : null,
        ),
        h('td', {}, h('select', { class: 'select', 'aria-label': `Модель закупки, ${name}`, onchange: (e) => { row.model = e.target.value; syncModel(); changed(); } }, MODELS.map(([v, l]) => h('option', { value: v, selected: v === row.model, title: l }, v.toUpperCase())))),
        inputs.map((c) => h('td', {}, fields[c.key])),
        outputs.map((c) => out[i][c.key]),
        h(
          'td',
          { class: 'mp-act' },
          h('button', {
            type: 'button', class: 'icon-btn', disabled: sc.rows.length >= MAX_ROWS || !row.channel?.trim(),
            'aria-label': `Добавить кампанию: ${name}`, title: row.channel?.trim() ? `Ещё кампания или тип размещения в «${row.channel.trim()}»` : 'Сначала впишите площадку',
            onclick: () => addCampaign(i),
          }, '+'),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Удалить: ${name}`, title: 'Удалить строку', onclick: () => { sc.rows.splice(i, 1); changed(); renderScenario(); } }, '×'),
        ),
      );
    });
    // строки и итоги площадок: итог встаёт под последней строкой группы
    const bodyRows = [];
    for (const g of groups) {
      bodyRows.push(...rowEls.slice(g.from, g.to + 1));
      if (g.to === g.from || !g.channel) continue;
      const cells = { budget: h('td', { class: 'num' }), ...Object.fromEntries(outputs.map((c) => [c.key, h('td', { class: 'num' })])) };
      subtotals.push({ g, cells });
      bodyRows.push(h('tr', { class: 'mp-subtotal' }, h('td', { colspan: 2 }, `Итого ${g.channel}`, h('span', { class: 'th-sub' }, `${g.to - g.from + 1} ${plural(g.to - g.from + 1, 'кампания', 'кампании', 'кампаний')}`)), cells.budget, h('td', { colspan: inputs.length - 1 }), outputs.map((c) => cells[c.key]), h('td')));
    }
    const totalBudget = h('td', { class: 'num' });
    const totalCells = Object.fromEntries(outputs.map((c) => [c.key, h('td', { class: 'num' })]));
    updateRows = () => {
      calc().forEach((r, i) => {
        // строку только что добавили или удалили — таблица перерисуется следом
        if (!out[i]) return;
        for (const c of outputs) out[i][c.key].textContent = c.fmt(r[c.key]);
      });
      for (const { g, cells } of subtotals) {
        const m = calcScenario({ rows: sc.rows.slice(g.from, g.to + 1) }, spec).month;
        cells.budget.textContent = rub(m.budget);
        for (const c of outputs) cells[c.key].textContent = c.fmt(m[c.key]);
      }
      const { month } = calcScenario(sc, spec);
      totalBudget.textContent = rub(month.budget);
      for (const c of outputs) totalCells[c.key].textContent = c.fmt(month[c.key]);
    };

    const fromBench = h(
      'select',
      {
        class: 'select', 'aria-label': 'Добавить из нормативов', disabled: sc.rows.length >= MAX_ROWS,
        onchange: (e) => {
          const b = benchmarks.find((x) => String(x.id) === e.target.value);
          if (!b) return;
          sc.rows.push(emptyRow(b));
          changed();
          renderScenario();
          scenarioBox.querySelector('tbody tr:last-child td:nth-child(3) input')?.focus();
        },
      },
      h('option', { value: '' }, benchmarks.length ? 'Из нормативов…' : 'Нормативов пока нет'),
      benchmarks.map((b) => h('option', { value: b.id }, b.channel)),
    );

    const th = (c, cls) => h('th', { scope: 'col', class: cls }, c.title, c.sub ? h('span', { class: 'th-sub' }, c.sub) : null);
    fill(
      scenarioBox,
      h(
        'div',
        { class: 'mp-scenario-head' },
        h('input', { class: 'input mp-name', value: sc.name, maxlength: 60, 'aria-label': 'Название сценария', oninput: (e) => { sc.name = e.target.value; changed(); renderTabs(); } }),
        spec.scenarios.length > 1
          ? h('button', {
              type: 'button', class: 'btn btn-s',
              onclick: async () => {
                if (!(await confirmDialog(`Удалить сценарий «${sc.name}»?`))) return;
                spec.scenarios.splice(current, 1);
                current = Math.max(0, current - 1);
                changed();
                renderAll();
              },
            }, 'Удалить сценарий')
          : null,
      ),
      h(
        'div',
        { class: 'grid-wrap' },
        h(
          'table',
          { class: `mp-table${ecom ? ' ecom' : ''}` },
          // ширины колонок: поля ввода стоят ровно под своими заголовками
          h(
            'colgroup',
            {},
            h('col', { class: 'c-channel' }),
            h('col', { class: 'c-model' }),
            inputs.map((c) => h('col', { class: c.key === 'budget' || c.key === 'check' ? 'c-budget' : c.unit === '%' ? 'c-pct' : 'c-rate' })),
            outputs.map((c) => h('col', { class: c.key === 'revenue' ? 'c-budget' : 'c-out' })),
            h('col', { class: 'c-act' }),
          ),
          h(
            'thead',
            {},
            h(
              'tr',
              { class: 'mp-groups' },
              h('th', { colspan: inputs.length + 2, scope: 'colgroup' }, 'Вводите'),
              h('th', { colspan: outputs.length, scope: 'colgroup', class: 'calc' }, 'Считается само, в месяц'),
              h('th'),
            ),
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, ecom ? 'Площадка' : 'Канал', h('span', { class: 'th-sub' }, ecom ? 'кампания и таргетинг' : 'тип размещения или кампания')),
              h('th', { scope: 'col' }, 'Закупка', h('span', { class: 'th-sub' }, 'клики или показы')),
              inputs.map((c) => th(c, 'num')),
              outputs.map((c) => th(c, 'calc num')),
              h('th', {}, h('span', { class: 'sr-only' }, 'Действия')),
            ),
          ),
          h('tbody', {}, bodyRows),
          h('tfoot', {}, h('tr', {}, h('td', { colspan: 2 }, 'Итого в месяц'), totalBudget, h('td', { colspan: inputs.length - 1 }), outputs.map((c) => totalCells[c.key]), h('td'))),
        ),
      ),
      h(
        'div',
        { class: 'mp-add' },
        h('button', { type: 'button', class: 'btn btn-s', disabled: sc.rows.length >= MAX_ROWS, onclick: () => { sc.rows.push(emptyRow()); changed(); renderScenario(); scenarioBox.querySelector('tbody tr:last-child input')?.focus(); } }, ecom ? '+ площадка' : '+ канал'),
        fromBench,
        sc.rows.length >= MAX_ROWS ? h('span', { class: 'hint' }, `Не больше ${MAX_ROWS} строк`) : h('span', { class: 'hint' }, '«+» у строки — ещё кампания этой площадки: поиск, РСЯ, ретаргетинг…'),
      ),
    );
    updateRows();
  }
  let updateRows = () => {};

  // ----- итоги -----
  function renderResults() {
    updateRows();
    const sc = spec.scenarios[current];
    const { period } = calcScenario(sc, spec);
    const card = (value, label, sub = null, main = false) => h('div', { class: `mp-card${main ? ' main' : ''}` }, h('div', { class: 'mp-value num' }, value), h('div', { class: 'mp-label' }, label), sub ? h('div', { class: 'mp-sub num' }, sub) : null);
    fill(
      results,
      h('h2', { class: 'sr-only' }, 'Итоги сценария'),
      card(rub(period.total), `К оплате за ${monthsText(period.months)}`, `медиа ${rub(period.media)}${period.fee ? ` + комиссия ${rub(period.fee)}` : ''}${period.vat ? ` + НДС ${rub(period.vat)}` : ''}`, true),
      spec.kind === 'ecom'
        ? [
            card(n0(period.sales), 'продаж за период', period.cps != null ? `${rub(period.cps)} за продажу` : null),
            card(n0(period.carts), 'корзин за период', period.cpa != null ? `${rub(period.cpa)} за корзину` : null),
          ]
        : [
            card(n0(period.leads), 'лидов за период', period.clicks != null ? `${n0(period.clicks)} кликов` : null),
            card(rub(period.cpl), 'стоимость лида', 'с комиссией и НДС'),
          ],
      period.revenue != null ? card(rub(period.revenue), 'выручка', spec.kind === 'ecom' ? null : `${n0(period.sales)} продаж`) : null,
      period.drr != null ? card(pctText(period.drr), 'ДРР', 'доля рекламы в выручке') : null,
    );
    renderCompare();
  }

  function renderCompare() {
    if (spec.scenarios.length < 2) return fill(compare);
    const rows = spec.scenarios.map((sc) => ({ name: sc.name, ...calcScenario(sc, spec) }));
    fill(
      compare,
      h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Сравнение сценариев'),
        h(
          'div',
          { class: 'grid-wrap' },
          h(
            'table',
            { class: 'mp-compare' },
            h('thead', {}, h('tr', {}, (spec.kind === 'ecom'
              ? ['Сценарий', 'Бюджет в месяц', 'К оплате за период', 'Продаж за период', 'Выручка за период', 'ДРР']
              : ['Сценарий', 'Бюджет в месяц', 'К оплате за период', 'Лидов за период', 'CPL с комиссией и НДС', 'ДРР']).map((t) => h('th', { scope: 'col' }, t)))),
            h(
              'tbody',
              {},
              rows.map((r, i) =>
                h(
                  'tr',
                  { class: i === current ? 'current' : '' },
                  h('td', {}, r.name),
                  h('td', { class: 'num' }, rub(r.month.budget)),
                  h('td', { class: 'num' }, rub(r.period.total)),
                  h('td', { class: 'num' }, n0(spec.kind === 'ecom' ? r.period.sales : r.period.leads)),
                  h('td', { class: 'num' }, rub(spec.kind === 'ecom' ? r.period.revenue : r.period.cpl)),
                  h('td', { class: 'num' }, pctText(r.period.drr)),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function renderAll() {
    renderTabs();
    renderScenario();
    renderResults();
  }

  // ----- действия -----
  async function download(format) {
    const btn = downloadMenu.querySelector('summary');
    btn.setAttribute('aria-busy', 'true');
    const label = btn.textContent;
    btn.textContent = format === 'xlsx' ? 'Готовлю…' : 'Рисую…';
    try {
      await save();
      const url = format === 'xlsx' ? `/admin/api/mediaplans/${id}/xlsx` : `/admin/api/mediaplans/${id}/export?format=${format}&scenario=${current}`;
      // PDF и картинки рисует сервер — сначала дождаться ответа, чтобы показать ошибку, если что-то не так
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Не удалось скачать');
      const blob = await res.blob();
      const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${plan.title}.${format}`);
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.textContent = label;
      btn.removeAttribute('aria-busy');
    }
  }

  async function toDocument() {
    await save().catch(() => {});
    let docs = [];
    try {
      docs = (await api('/admin/api/documents')).documents;
    } catch {
      /* только новая презентация */
    }
    const scenario = h('select', { class: 'select', id: 'td-scenario' }, spec.scenarios.map((sc, i) => h('option', { value: i, selected: i === current }, sc.name)));
    const target = h('select', { class: 'select', id: 'td-target' }, h('option', { value: '' }, 'Новая презентация «Медиаплан»'), docs.map((d) => h('option', { value: d.id }, `Добавить в «${d.title}»`)));
    formDialog({
      title: 'Медиаплан в презентацию',
      submitLabel: 'Создать слайды',
      body: [
        h('p', { class: 'muted' }, 'Два слайда: прогноз на период (лиды, стоимость лида, бюджет) и таблица по каналам. Статус данных — «Прогноз», источник — расчёт агентства.'),
        spec.scenarios.length > 1 ? h('div', { class: 'field' }, h('label', { for: 'td-scenario' }, 'Сценарий'), scenario) : null,
        h('div', { class: 'field' }, h('label', { for: 'td-target' }, 'Куда'), target),
      ],
      onSubmit: async () => {
        const body = { scenario: Number(scenario.value) };
        if (target.value) body.documentId = Number(target.value);
        const { document: doc } = await api(`/admin/api/mediaplans/${id}/to-document`, { method: 'POST', body });
        navigate('doc', new URLSearchParams({ id: String(doc.id), slide: String(Math.max(0, doc.spec.slides.findIndex((s) => s.type === 'mediaplan'))) }));
        toast('Слайды медиаплана добавлены');
      },
    });
  }

  async function removePlan() {
    if (!(await confirmDialog(`Удалить «${plan.title}»? Это не отменить.`))) return;
    try {
      clearTimeout(timer);
      dirty = false;
      await api(`/admin/api/mediaplans/${id}`, { method: 'DELETE' });
      toast('Медиаплан удалён');
      navigate('plans');
    } catch (err) {
      toast(err.message);
    }
  }

  renderAll();
}

// ---------- нормативы ----------

export async function renderBenchmarks() {
  const admin = ctx.me.role === 'admin';
  const box = h('div', {}, h('p', { class: 'muted' }, 'Загружаю…'));
  const addBtn = admin ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => edit() }, 'Добавить норматив') : null;
  fill(
    app,
    shell('benchmarks', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Нормативы'), h('span', { class: 'spacer' }), addBtn),
      h('p', { class: 'lead-text' }, 'Средние показатели агентства по каналам — из ваших прошлых кампаний. Подставляются в медиапланы и попадают в Excel вместе с основанием. ' + (admin ? '' : 'Менять нормативы может администратор.')),
      box,
    ]),
  );
  let list;
  async function load() {
    try {
      list = (await api('/admin/api/benchmarks')).benchmarks;
    } catch (err) {
      if (err.status !== 401) fill(box, h('p', { class: 'error' }, err.message));
      return;
    }
    if (!list.length) {
      fill(box, h('div', { class: 'panel empty' }, h('strong', {}, 'Нормативов пока нет'), admin ? 'Добавьте первый: канал, ставку, CTR и конверсию в лид — и откуда эти цифры.' : 'Попросите администратора внести нормативы агентства.'));
      return;
    }
    const pctCell = (v) => (v == null ? '—' : `${nf1.format(v)} %`);
    const money = (v) => (v == null ? '—' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v)} ₽`);
    fill(
      box,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'staff bench' },
          h('thead', {}, h('tr', {}, ['Канал', 'Закупка', 'CPC', 'CPM', 'CTR', 'Конв. в лид', 'Основание', 'Обновлено', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            {},
            list.map((b) =>
              h(
                'tr',
                {},
                h('td', {}, h('strong', {}, b.channel)),
                h('td', {}, MODELS.find(([v]) => v === b.model)?.[1] ?? b.model),
                h('td', { class: 'num' }, money(b.cpc)),
                h('td', { class: 'num' }, money(b.cpm)),
                h('td', { class: 'num' }, pctCell(b.ctr)),
                h('td', { class: 'num' }, pctCell(b.cr)),
                h('td', { class: 'bench-note' }, b.note),
                h('td', { class: 'num nowrap' }, fmtDateTime(b.updated_at), h('span', { class: 'task' }, b.updated_by)),
                h(
                  'td',
                  { class: 'row-actions' },
                  admin ? h('button', { type: 'button', class: 'btn btn-s', onclick: () => edit(b) }, 'Изменить') : null,
                  admin
                    ? h('button', {
                        type: 'button', class: 'btn btn-s',
                        onclick: async () => {
                          if (!(await confirmDialog(`Удалить норматив «${b.channel}»? В сохранённых медиапланах цифры останутся.`))) return;
                          try {
                            await api(`/admin/api/benchmarks/${b.id}`, { method: 'DELETE' });
                            load();
                          } catch (err) {
                            toast(err.message);
                          }
                        },
                      }, 'Удалить')
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function edit(b = null) {
    const v = b ?? { channel: '', model: 'cpc', cpc: null, cpm: null, ctr: null, cr: null, note: '' };
    const draft = { ...v };
    const num = (key, label) => {
      const input = h('input', {
        class: 'input num', id: `b-${key}`, inputmode: 'decimal', value: draft[key] ?? '',
        oninput: (e) => {
          const x = parseNum(e.target.value);
          e.target.setAttribute('aria-invalid', Number.isNaN(x) ? 'true' : 'false');
          draft[key] = Number.isNaN(x) ? null : x;
        },
      });
      return h('div', { class: 'field' }, h('label', { for: `b-${key}` }, label), input);
    };
    const channel = h('input', { class: 'input', id: 'b-channel', required: true, maxlength: 120, value: draft.channel, placeholder: 'Яндекс Директ, поиск' });
    const model = h('select', { class: 'select', id: 'b-model' }, MODELS.map(([m, l]) => h('option', { value: m, selected: m === draft.model }, l)));
    const note = h('textarea', { class: 'textarea', id: 'b-note', required: true, maxlength: 500, placeholder: 'Например: среднее по 12 кампаниям в недвижимости, январь — сентябрь 2026' }, draft.note);
    formDialog({
      title: b ? `Норматив: ${b.channel}` : 'Новый норматив',
      submitLabel: 'Сохранить',
      body: [
        h('div', { class: 'field' }, h('label', { for: 'b-channel' }, 'Канал'), channel),
        h('div', { class: 'field' }, h('label', { for: 'b-model' }, 'Модель закупки'), model),
        h('div', { class: 'dialog-grid' }, num('cpc', 'CPC, ₽'), num('cpm', 'CPM, ₽'), num('ctr', 'CTR, %'), num('cr', 'Конверсия в лид, %')),
        h('div', { class: 'field' }, h('label', { for: 'b-note' }, 'На чём основан'), note, h('span', { class: 'hint' }, 'Обязательно: по каким кампаниям и за какой период посчитано.')),
      ],
      onSubmit: async () => {
        const body = { channel: channel.value.trim(), model: model.value, cpc: draft.cpc, cpm: draft.cpm, ctr: draft.ctr, cr: draft.cr, note: note.value.trim() };
        await api(b ? `/admin/api/benchmarks/${b.id}` : '/admin/api/benchmarks', { method: b ? 'PUT' : 'POST', body });
        toast('Норматив сохранён');
        load();
      },
    });
  }

  load();
}
