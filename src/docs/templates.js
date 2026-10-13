// Библиотека типов слайдов Soroka Marketing. Каждый тип превращает данные слайда в список
// элементов с координатами на холсте 1920×1080 — из этого списка рисуются HTML, PDF и PPTX.

export const SLIDE_TYPES = {
  cover: { label: 'Титульный', theme: 'dark', required: ['title'] },
  section: { label: 'Раздел', theme: 'dark', required: ['title'] },
  kpi: { label: 'KPI', theme: 'light', required: ['title', 'kpis', 'source', 'dataStatus'], data: true },
  chart: { label: 'Диаграмма с выводом', theme: 'light', required: ['title', 'chart', 'takeaway', 'source', 'dataStatus'], data: true },
  analytics: { label: 'Аналитика', theme: 'light', required: ['title', 'chart', 'insights', 'source', 'dataStatus'], data: true },
  case: { label: 'Кейс', theme: 'light', required: ['title', 'client', 'task', 'solution', 'results', 'source'], data: true },
  strategy: { label: 'Стратегия', theme: 'light', required: ['title', 'pillars'] },
  mediaplan: { label: 'Медиаплан', theme: 'light', required: ['title', 'rows', 'dataStatus'], data: true },
  proposal: { label: 'Коммерческое предложение', theme: 'light', required: ['title', 'items'] },
  closing: { label: 'Следующий шаг и контакты', theme: 'dark', required: ['title'] },
};

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
export const fmtNumber = (v) => (typeof v === 'number' ? nf.format(v).replace(/ /g, ' ') : String(v ?? ''));
export const fmtMoney = (v, currency = '₽') => (typeof v === 'number' ? `${fmtNumber(Math.round(v))} ${currency}` : String(v ?? ''));

export function renderSlide(slide, ctx) {
  const type = SLIDE_TYPES[slide.type];
  if (!type) throw new Error(`Неизвестный тип слайда «${slide.type}»`);
  const elements = BUILDERS[slide.type](slide, ctx);
  return { type: slide.type, theme: type.theme, elements, notes: slide.notes ?? null };
}

// ---------- общие части ----------

const text = (name, box, style, value, extra = {}) => ({ kind: 'text', name, ...box, style, text: value, color: 'ink', ...extra });

function contentTitle(slide, L) {
  return text('title', L.titleBox, 'title', slide.title, { placeholder: 'title' });
}

/** Подпись «Источник · период» и отметка статуса данных (факт / прогноз / гипотеза). */
function dataFooter(slide, ctx) {
  const { L, brand } = ctx;
  const out = [];
  const parts = [slide.source ? `Источник: ${slide.source}` : null, slide.period ? `Период: ${slide.period}` : null].filter(Boolean);
  if (parts.length) out.push(text('source', { x: L.M, y: L.sourceY, w: L.CW - 260, h: 32 }, 'caption', parts.join('. '), { color: 'steel' }));
  if (slide.dataStatus) {
    const label = brand.documents.dataStatusLabels[slide.dataStatus] ?? slide.dataStatus;
    out.push({ kind: 'rect', name: 'status-chip', x: L.W - L.M - 220, y: L.sourceY - 8, w: 220, h: 48, fill: 'mist', radius: 24 });
    out.push(text('status', { x: L.W - L.M - 220, y: L.sourceY - 2, w: 220, h: 36 }, 'smallStrong', label, { align: 'center', color: 'ink' }));
  }
  return out;
}

// ---------- типы ----------

const BUILDERS = {
  cover(slide, { L }) {
    const meta = [slide.client, slide.date].filter(Boolean).join(', ');
    return [
      { kind: 'logo', name: 'logo', x: L.M, y: L.top, h: 40, variant: 'onDark' },
      text('title', { x: L.M, y: 300, w: 1440, h: 336 }, 'display', slide.title, { color: 'onDark' }),
      slide.subtitle ? text('subtitle', { x: L.M, y: 672, w: 1280, h: 104 }, 'lead', slide.subtitle, { color: 'onDarkMuted' }) : null,
      { kind: 'rect', name: 'accent', x: L.M, y: 848, w: 96, h: 8, fill: 'accent', radius: 4 },
      meta ? text('meta', { x: L.M, y: 888, w: 1100, h: 40 }, 'small', meta, { color: 'onDark' }) : null,
      slide.author ? text('author', { x: L.W - L.M - 560, y: 888, w: 560, h: 40 }, 'small', slide.author, { color: 'onDarkMuted', align: 'right' }) : null,
    ].filter(Boolean);
  },

  section(slide, { L }) {
    return [
      slide.number ? text('number', { x: L.M, y: 344, w: 400, h: 64 }, 'subtitle', String(slide.number).padStart(2, '0'), { color: 'accent' }) : null,
      text('title', { x: L.M, y: 424, w: 1440, h: 240 }, 'display', slide.title, { color: 'onDark' }),
      slide.subtitle ? text('subtitle', { x: L.M, y: 688, w: 1280, h: 96 }, 'lead', slide.subtitle, { color: 'onDarkMuted' }) : null,
    ].filter(Boolean);
  },

  kpi(slide, ctx) {
    const { L } = ctx;
    const kpis = slide.kpis.slice(0, 4);
    const cols = L.cols(kpis.length);
    const y = 352;
    const out = [contentTitle(slide, L)];
    if (slide.lead) out.push(text('lead', { x: L.M, y: 256, w: L.CW, h: 56 }, 'lead', slide.lead, { color: 'steel' }));
    kpis.forEach((k, i) => {
      const { x, w } = cols[i];
      out.push({ kind: 'rect', name: `kpi-${i}-card`, x, y, w, h: 480, fill: 'mist', radius: 16 });
      out.push({ kind: 'rect', name: `kpi-${i}-mark`, x: x + 40, y: y + 48, w: 48, h: 8, fill: 'accent', radius: 4 });
      out.push(text(`kpi-${i}-value`, { x: x + 40, y: y + 80, w: w - 80, h: 128 }, 'kpi', k.value));
      out.push(text(`kpi-${i}-label`, { x: x + 40, y: y + 216, w: w - 80, h: 120 }, 'body', k.label));
      if (k.delta) out.push(text(`kpi-${i}-delta`, { x: x + 40, y: y + 352, w: w - 80, h: 88 }, 'small', k.delta, { color: 'steel' }));
    });
    return [...out, ...dataFooter(slide, ctx)];
  },

  chart(slide, ctx) {
    const { L } = ctx;
    const chartW = 1088;
    const sideX = L.M + chartW + 64;
    const sideW = L.W - L.M - sideX;
    return [
      contentTitle(slide, L),
      { kind: 'chart', name: 'chart', x: L.M, y: L.contentTop, w: chartW, h: 600, chart: slide.chart },
      { kind: 'rect', name: 'takeaway-card', x: sideX, y: L.contentTop, w: sideW, h: 600, fill: 'mist', radius: 16 },
      text('takeaway', { x: sideX + 40, y: L.contentTop + 40, w: sideW - 80, h: 200 }, 'subtitle', slide.takeaway),
      slide.points?.length
        ? text('points', { x: sideX + 40, y: L.contentTop + 264, w: sideW - 80, h: 296 }, 'body', null, { bullets: slide.points.slice(0, 4), color: 'ink' })
        : null,
      ...dataFooter(slide, ctx),
    ].filter(Boolean);
  },

  analytics(slide, ctx) {
    const { L } = ctx;
    const insights = slide.insights.slice(0, 3);
    const cols = L.cols(insights.length);
    const cardY = 640;
    return [
      contentTitle(slide, L),
      { kind: 'chart', name: 'chart', x: L.M, y: 272, w: L.CW, h: 344, chart: slide.chart },
      ...insights.flatMap((ins, i) => [
        { kind: 'rect', name: `insight-${i}-card`, x: cols[i].x, y: cardY, w: cols[i].w, h: 264, fill: 'mist', radius: 16 },
        text(`insight-${i}-title`, { x: cols[i].x + 32, y: cardY + 32, w: cols[i].w - 64, h: 72 }, 'bodyStrong', ins.title),
        text(`insight-${i}-text`, { x: cols[i].x + 32, y: cardY + 112, w: cols[i].w - 64, h: 128 }, 'small', ins.text, { color: 'steel' }),
      ]),
      ...dataFooter(slide, ctx),
    ];
  },

  case(slide, ctx) {
    const { L } = ctx;
    const [left, mid, right] = L.cols(3);
    const results = slide.results.slice(0, 3);
    const out = [
      contentTitle(slide, L),
      text('client', { x: L.M, y: 256, w: L.CW, h: 40 }, 'small', [slide.client, slide.industry].filter(Boolean).join(', '), { color: 'steel' }),
      text('task-h', { x: left.x, y: 328, w: left.w, h: 40 }, 'smallStrong', 'Задача', { color: 'accentText' }),
      text('task', { x: left.x, y: 376, w: left.w, h: 512 }, 'body', slide.task),
      text('solution-h', { x: mid.x, y: 328, w: mid.w, h: 40 }, 'smallStrong', 'Что сделали', { color: 'accentText' }),
      text('solution', { x: mid.x, y: 376, w: mid.w, h: 512 }, 'body', null, { bullets: [].concat(slide.solution).slice(0, 5) }),
      { kind: 'rect', name: 'results-card', x: right.x, y: 328, w: right.w, h: 576, fill: 'mist', radius: 16 },
      text('results-h', { x: right.x + 40, y: 360, w: right.w - 80, h: 40 }, 'smallStrong', 'Результат', { color: 'accentText' }),
    ];
    results.forEach((r, i) => {
      const y = 416 + i * 160;
      out.push(text(`result-${i}-value`, { x: right.x + 40, y, w: right.w - 80, h: 88 }, 'kpiSmall', r.value));
      out.push(text(`result-${i}-label`, { x: right.x + 40, y: y + 88, w: right.w - 80, h: 56 }, 'small', r.label, { color: 'steel' }));
    });
    return [...out, ...dataFooter({ ...slide, dataStatus: slide.dataStatus ?? 'fact' }, ctx)];
  },

  strategy(slide, ctx) {
    const { L } = ctx;
    const pillars = slide.pillars.slice(0, 4);
    const cols = L.cols(pillars.length);
    const top = slide.lead ? 360 : 304;
    const out = [contentTitle(slide, L)];
    if (slide.lead) out.push(text('lead', { x: L.M, y: 256, w: L.CW, h: 80 }, 'lead', slide.lead, { color: 'steel' }));
    pillars.forEach((p, i) => {
      const { x, w } = cols[i];
      out.push({ kind: 'rect', name: `pillar-${i}-card`, x, y: top, w, h: 904 - top, fill: 'mist', radius: 16 });
      out.push(text(`pillar-${i}-n`, { x: x + 32, y: top + 32, w: 120, h: 56 }, 'subtitle', String(i + 1).padStart(2, '0'), { color: 'accentText' }));
      out.push(text(`pillar-${i}-title`, { x: x + 32, y: top + 96, w: w - 64, h: 96 }, 'bodyStrong', p.title));
      out.push(text(`pillar-${i}-text`, { x: x + 32, y: top + 200, w: w - 64, h: 904 - top - 200 - (p.channels?.length ? 104 : 32) }, 'small', p.text, { color: 'steel' }));
      if (p.channels?.length) {
        out.push(text(`pillar-${i}-channels`, { x: x + 32, y: 904 - 96, w: w - 64, h: 64 }, 'caption', p.channels.join(', '), { color: 'accentText' }));
      }
    });
    return [...out, ...dataFooter(slide, ctx)];
  },

  mediaplan(slide, ctx) {
    const { L, brand } = ctx;
    const cur = brand.documents.currency;
    const rows = slide.rows;
    const sum = (k) => (rows.every((r) => typeof r[k] === 'number') ? rows.reduce((n, r) => n + r[k], 0) : null);
    const ratio = (a, b, digits = 0) => (typeof a === 'number' && typeof b === 'number' && b > 0 ? +(a / b).toFixed(digits) : null);
    const line = (r) => [
      r.channel,
      fmtMoney(r.budget, cur),
      r.impressions != null ? fmtNumber(r.impressions) : '—',
      r.clicks != null ? fmtNumber(r.clicks) : '—',
      ratio(r.budget, r.clicks) != null ? fmtMoney(ratio(r.budget, r.clicks), cur) : '—',
      r.leads != null ? fmtNumber(r.leads) : '—',
      ratio(r.budget, r.leads) != null ? fmtMoney(ratio(r.budget, r.leads), cur) : '—',
    ];
    const totals = { channel: 'Итого', budget: sum('budget'), impressions: sum('impressions'), clicks: sum('clicks'), leads: sum('leads') };
    return [
      contentTitle(slide, L),
      {
        kind: 'table',
        name: 'mediaplan',
        x: L.M,
        y: 288,
        w: L.CW,
        colW: [520, 220, 200, 180, 180, 160, 220],
        header: ['Канал', 'Бюджет', 'Показы', 'Клики', 'CPC', 'Лиды', 'CPL'],
        align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
        rows: rows.slice(0, 8).map(line),
        total: line(totals),
        rowH: 64,
      },
      slide.assumptions
        ? text('assumptions', { x: L.M, y: 288 + 64 * (Math.min(rows.length, 8) + 2) + 24, w: L.CW, h: 96 }, 'small', slide.assumptions, { color: 'steel' })
        : null,
      ...dataFooter(slide, ctx),
    ].filter(Boolean);
  },

  proposal(slide, ctx) {
    const { L, brand } = ctx;
    const cur = brand.documents.currency;
    const items = slide.items.slice(0, 7);
    const total = slide.total ?? (items.every((i) => typeof i.price === 'number') ? items.reduce((n, i) => n + i.price, 0) : null);
    const tableW = 1080;
    const sideX = L.M + tableW + 64;
    const sideW = L.W - L.M - sideX;
    return [
      contentTitle(slide, L),
      slide.lead ? text('lead', { x: L.M, y: 256, w: L.CW, h: 48 }, 'body', slide.lead, { color: 'steel' }) : null,
      {
        kind: 'table',
        name: 'scope',
        x: L.M,
        y: 320,
        w: tableW,
        colW: [760, 320],
        header: ['Работы', `Стоимость${slide.priceUnit ? `, ${slide.priceUnit}` : ''}`],
        align: ['left', 'right'],
        rows: items.map((i) => [i.description ? `${i.name}\n${i.description}` : i.name, typeof i.price === 'number' ? fmtMoney(i.price, cur) : i.price]),
        total: total != null ? ['Итого', fmtMoney(total, cur)] : null,
        rowH: items.some((i) => i.description) ? 88 : 64,
      },
      { kind: 'rect', name: 'terms-card', x: sideX, y: 320, w: sideW, h: 584, fill: 'mist', radius: 16 },
      text('terms-h', { x: sideX + 40, y: 352, w: sideW - 80, h: 40 }, 'smallStrong', 'Условия', { color: 'accentText' }),
      text('terms', { x: sideX + 40, y: 408, w: sideW - 80, h: 392 }, 'small', null, { bullets: (slide.terms ?? []).slice(0, 6) }),
      slide.validUntil ? text('valid', { x: sideX + 40, y: 824, w: sideW - 80, h: 48 }, 'caption', `Предложение действует до ${slide.validUntil}`, { color: 'steel' }) : null,
      ...dataFooter(slide, ctx),
    ].filter(Boolean);
  },

  closing(slide, { L }) {
    const c = slide.contacts ?? {};
    const contacts = [c.name, c.role, c.phone, c.email, c.telegram, c.site].filter(Boolean);
    return [
      { kind: 'logo', name: 'logo', x: L.M, y: L.top, h: 40, variant: 'onDark' },
      text('title', { x: L.M, y: 248, w: 1200, h: 224 }, 'display', slide.title, { color: 'onDark' }),
      slide.steps?.length
        ? text('steps', { x: L.M, y: 520, w: 980, h: 400 }, 'lead', null, { bullets: slide.steps.slice(0, 4), numbered: true, color: 'onDark' })
        : null,
      contacts.length ? text('contacts', { x: 1240, y: 520, w: 560, h: 400 }, 'body', contacts.join('\n'), { color: 'onDarkMuted' }) : null,
    ].filter(Boolean);
  },
};
