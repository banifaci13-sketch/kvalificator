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
  ecomplan: { label: 'Медиаплан: интернет-магазин', theme: 'light', required: ['title', 'rows', 'dataStatus'], data: true },
  image: { label: 'Фото или креатив', theme: 'light', required: ['title'] },
  gallery: { label: 'Креативы', theme: 'light', required: ['title', 'items'] },
  proposal: { label: 'Коммерческое предложение', theme: 'light', required: ['title', 'items'] },
  brief: { label: 'Вопросы брифа', theme: 'light', required: ['title', 'questions'] },
  closing: { label: 'Следующий шаг и контакты', theme: 'dark', required: ['title'] },
};

const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
export const fmtNumber = (v) => (typeof v === 'number' ? nf.format(v).replace(/ /g, ' ') : String(v ?? ''));
export const fmtMoney = (v, currency = '₽') => (typeof v === 'number' ? `${fmtNumber(Math.round(v))} ${currency}` : String(v ?? ''));
/** Крупные суммы для карточек KPI: 3 998 550 → «4 млн ₽», 650 000 → «650 тыс. ₽». */
export function fmtMoneyShort(v, currency = '₽') {
  if (typeof v !== 'number') return String(v ?? '');
  const abs = Math.abs(v);
  const short = (n, unit) => `${fmtNumber(+n.toFixed(Math.abs(n) >= 100 ? 0 : 1))} ${unit} ${currency}`;
  if (abs >= 1e9) return short(v / 1e9, 'млрд');
  if (abs >= 1e6) return short(v / 1e6, 'млн');
  if (abs >= 1e5) return short(v / 1e3, 'тыс.');
  return fmtMoney(v, currency);
}

export function renderSlide(slide, ctx) {
  const type = SLIDE_TYPES[slide.type];
  if (!type) throw new Error(`Неизвестный тип слайда «${slide.type}»`);
  // сборщик возвращает список элементов или { theme, elements }, если раскладка меняет тему (фото на весь слайд)
  const built = BUILDERS[slide.type](slide, ctx);
  const elements = (Array.isArray(built) ? built : built.elements).filter(Boolean);
  const theme = Array.isArray(built) ? type.theme : built.theme ?? type.theme;
  return { type: slide.type, theme, elements, notes: slide.notes ?? null };
}

/**
 * Раскладки — варианты расположения внутри фирменной сетки. Первая — по умолчанию.
 * Свободного перетаскивания нет намеренно: так любой вариант проходит проверку и одинаков в PDF и PowerPoint.
 */
export const LAYOUTS = {
  cover: [['left', 'Текст слева'], ['center', 'По центру'], ['image', 'С фото справа']],
  chart: [['side', 'Вывод справа'], ['side-left', 'Вывод слева'], ['wide', 'График во всю ширину']],
  strategy: [['columns', 'Колонки'], ['rows', 'Строки']],
  image: [['right', 'Фото справа'], ['left', 'Фото слева'], ['wide', 'Фото во всю ширину'], ['full', 'Фото на весь слайд']],
  gallery: [['grid', 'Сетка'], ['feature', 'Одно крупное']],
  brief: [['grid', 'Карточки 2 × 2'], ['rows', 'Строки: больше места для ответа']],
};
/** Сколько вопросов брифа помещается на слайд в каждой раскладке. */
export const BRIEF_PER_SLIDE = { grid: 4, rows: 3 };
const layoutOf = (slide) => {
  const list = LAYOUTS[slide.type];
  return list?.some(([v]) => v === slide.layout) ? slide.layout : list?.[0][0];
};

// ---------- общие части ----------

const text = (name, box, style, value, extra = {}) => ({ kind: 'text', name, ...box, style, text: value, color: 'ink', ...extra });

/**
 * Изображение из медиатеки. После подготовки документа (media.hydrate) в слайде лежит
 * { src, width, height } или { missing: true }; пока картинки нет — заглушка, которую видно в превью.
 */
function picture(name, box, img, { fit = 'cover', radius = 16, dark = false } = {}) {
  if (img?.src) {
    const out = [];
    // «целиком» — под картинкой фон ячейки, чтобы поля вокруг не выглядели дырой
    if (fit === 'contain') out.push({ kind: 'rect', name: `${name}-bg`, ...box, fill: dark ? 'ink' : 'mist', radius });
    out.push({ kind: 'image', name, ...box, src: img.src, mime: img.mime, iw: img.width, ih: img.height, fit, radius });
    return out;
  }
  return [
    { kind: 'rect', name: `${name}-empty`, ...box, fill: dark ? 'steel' : 'mist', radius },
    text(`${name}-hint`, { x: box.x + 24, y: box.y + box.h / 2 - 20, w: box.w - 48, h: 40 }, 'small', img?.missing ? 'Изображение удалено — выберите другое' : 'Добавьте изображение', {
      align: 'center',
      color: dark ? 'onDark' : 'steel',
    }),
  ];
}

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
    const layout = layoutOf(slide);
    if (layout === 'center') {
      return [
        { kind: 'logo', name: 'logo', x: L.M, y: L.top, h: 40, variant: 'onDark' },
        text('title', { x: L.M, y: 300, w: L.CW, h: 336 }, 'display', slide.title, { color: 'onDark', align: 'center' }),
        slide.subtitle ? text('subtitle', { x: L.M + 160, y: 672, w: L.CW - 320, h: 104 }, 'lead', slide.subtitle, { color: 'onDarkMuted', align: 'center' }) : null,
        { kind: 'rect', name: 'accent', x: L.W / 2 - 48, y: 820, w: 96, h: 8, fill: 'accent', radius: 4 },
        meta || slide.author
          ? text('meta', { x: L.M, y: 864, w: L.CW, h: 40 }, 'small', [meta, slide.author].filter(Boolean).join(' — '), { color: 'onDark', align: 'center' })
          : null,
      ];
    }
    if (layout === 'image') {
      const textW = 800;
      return [
        ...picture('cover-image', { x: 1008, y: 0, w: L.W - 1008, h: L.H }, slide.image, { fit: 'cover', radius: 0, dark: true }),
        { kind: 'logo', name: 'logo', x: L.M, y: L.top, h: 40, variant: 'onDark' },
        text('title', { x: L.M, y: 260, w: textW, h: 420 }, 'title', slide.title, { color: 'onDark' }),
        slide.subtitle ? text('subtitle', { x: L.M, y: 700, w: textW, h: 120 }, 'lead', slide.subtitle, { color: 'onDarkMuted' }) : null,
        { kind: 'rect', name: 'accent', x: L.M, y: 848, w: 96, h: 8, fill: 'accent', radius: 4 },
        meta ? text('meta', { x: L.M, y: 888, w: textW, h: 40 }, 'small', meta, { color: 'onDark' }) : null,
        slide.author ? text('author', { x: L.M, y: 936, w: textW, h: 40 }, 'small', slide.author, { color: 'onDarkMuted' }) : null,
      ];
    }
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
    // четыре карточки или длинные значения («3 998 550 ₽») — кегль меньше, иначе цифры не влезут
    const longest = Math.max(...kpis.map((k) => String(k.value ?? '').length));
    const style = kpis.length >= 4 || longest > (kpis.length === 3 ? 7 : 10) ? 'kpiSmall' : 'kpi';
    const y = 352;
    const out = [contentTitle(slide, L)];
    if (slide.lead) out.push(text('lead', { x: L.M, y: 256, w: L.CW, h: 56 }, 'lead', slide.lead, { color: 'steel' }));
    kpis.forEach((k, i) => {
      const { x, w } = cols[i];
      out.push({ kind: 'rect', name: `kpi-${i}-card`, x, y, w, h: 480, fill: 'mist', radius: 16 });
      out.push({ kind: 'rect', name: `kpi-${i}-mark`, x: x + 40, y: y + 48, w: 48, h: 8, fill: 'accent', radius: 4 });
      out.push(text(`kpi-${i}-value`, { x: x + 40, y: y + 80, w: w - 80, h: 128 }, style, k.value));
      out.push(text(`kpi-${i}-label`, { x: x + 40, y: y + 216, w: w - 80, h: 120 }, 'body', k.label));
      if (k.delta) out.push(text(`kpi-${i}-delta`, { x: x + 40, y: y + 352, w: w - 80, h: 88 }, 'small', k.delta, { color: 'steel' }));
    });
    return [...out, ...dataFooter(slide, ctx)];
  },

  chart(slide, ctx) {
    const { L } = ctx;
    const layout = layoutOf(slide);
    if (layout === 'wide') {
      const pointsW = 560;
      return [
        contentTitle(slide, L),
        { kind: 'chart', name: 'chart', x: L.M, y: L.contentTop - 16, w: L.CW, h: 456, chart: slide.chart },
        text('takeaway', { x: L.M, y: 744, w: slide.points?.length ? L.CW - pointsW - 64 : L.CW, h: 168 }, 'subtitle', slide.takeaway),
        slide.points?.length
          ? text('points', { x: L.W - L.M - pointsW, y: 744, w: pointsW, h: 168 }, 'small', null, { bullets: slide.points.slice(0, 3), color: 'ink' })
          : null,
        ...dataFooter(slide, ctx),
      ].filter(Boolean);
    }
    const chartW = 1088;
    const sideW = L.CW - chartW - 64;
    // «вывод слева»: панель и график меняются местами
    const chartX = layout === 'side-left' ? L.M + sideW + 64 : L.M;
    const sideX = layout === 'side-left' ? L.M : L.M + chartW + 64;
    return [
      contentTitle(slide, L),
      { kind: 'chart', name: 'chart', x: chartX, y: L.contentTop, w: chartW, h: 600, chart: slide.chart },
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
    if (layoutOf(slide) === 'rows') {
      // направления строками: номер и название слева, что делаем — по центру, каналы — справа
      const gap = 24;
      const rowH = Math.floor((904 - top - gap * (pillars.length - 1)) / pillars.length);
      const channelsW = 360;
      pillars.forEach((p, i) => {
        const y = top + i * (rowH + gap);
        const inner = rowH - 48;
        out.push({ kind: 'rect', name: `pillar-${i}-card`, x: L.M, y, w: L.CW, h: rowH, fill: 'mist', radius: 16 });
        out.push(text(`pillar-${i}-n`, { x: L.M + 32, y: y + 24, w: 80, h: 56 }, 'subtitle', String(i + 1).padStart(2, '0'), { color: 'accentText' }));
        out.push(text(`pillar-${i}-title`, { x: L.M + 136, y: y + 24, w: 440, h: inner }, 'bodyStrong', p.title));
        const textW = L.CW - 640 - (p.channels?.length ? channelsW + 32 : 32);
        out.push(text(`pillar-${i}-text`, { x: L.M + 608, y: y + 24, w: textW, h: inner }, 'small', p.text, { color: 'steel' }));
        if (p.channels?.length) {
          out.push(text(`pillar-${i}-channels`, { x: L.M + L.CW - channelsW - 32, y: y + 24, w: channelsW, h: inner }, 'caption', p.channels.join(', '), { color: 'accentText', align: 'right' }));
        }
      });
      return [...out, ...dataFooter(slide, ctx)];
    }
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

  // Интернет-магазин: площадка и таргетинг, бюджет с НДС, клики → корзины → продажи → выручка, ДРР
  ecomplan(slide, ctx) {
    const { L, brand } = ctx;
    const cur = brand.documents.currency;
    const rows = slide.rows;
    const sum = (k) => (rows.every((r) => typeof r[k] === 'number') ? rows.reduce((n, r) => n + r[k], 0) : null);
    const n = (v) => (v != null ? fmtNumber(v) : '—');
    const drr = (b, rev) => (typeof b === 'number' && typeof rev === 'number' && rev > 0 ? `${fmtNumber(+((b / rev) * 100).toFixed(1))} %` : '—');
    const line = (r) => [
      r.targeting ? `${r.channel}\n${r.targeting}` : r.channel,
      fmtMoney(r.budget, cur),
      n(r.clicks),
      n(r.carts),
      n(r.sales),
      r.revenue != null ? fmtMoney(r.revenue, cur) : '—',
      drr(r.budget, r.revenue),
    ];
    const totals = { channel: 'Итого', budget: sum('budget'), clicks: sum('clicks'), carts: sum('carts'), sales: sum('sales'), revenue: sum('revenue') };
    return [
      contentTitle(slide, L),
      {
        kind: 'table',
        name: 'ecomplan',
        x: L.M,
        y: 288,
        w: L.CW,
        colW: [520, 240, 170, 170, 170, 260, 150],
        header: ['Площадка и таргетинг', 'Бюджет с НДС', 'Клики', 'Корзины', 'Продажи', 'Выручка', 'ДРР'],
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

  // Бриф: вопрос, подсказка и поле ответа. Пустое поле остаётся белым — его заполняют на созвоне,
  // в PowerPoint или от руки в PDF; заполненный ответ печатается внутри поля.
  brief(slide, ctx) {
    const { L } = ctx;
    const layout = layoutOf(slide);
    const qs = (slide.questions ?? []).slice(0, BRIEF_PER_SLIDE[layout]);
    const top = slide.lead ? 320 : 288;
    const out = [contentTitle(slide, L)];
    if (slide.lead) out.push(text('lead', { x: L.M, y: 248, w: L.CW, h: 48 }, 'body', slide.lead, { color: 'steel' }));
    const num = (i) => `${slide.start ? Number(slide.start) + i : i + 1}.`;
    if (layout === 'rows') {
      const gap = 24;
      const h = Math.floor((L.contentBottom - top - gap * 2) / 3);
      const qW = 640;
      qs.forEach((q, i) => {
        const y = top + i * (h + gap);
        const ax = L.M + qW + 64;
        out.push({ kind: 'rect', name: `q-${i}-card`, x: L.M, y, w: L.CW, h, fill: 'mist', radius: 16 });
        out.push(text(`q-${i}-text`, { x: L.M + 32, y: y + 24, w: qW, h: 76 }, 'bodyStrong', `${num(i)} ${q.question ?? ''}`));
        if (q.hint) out.push(text(`q-${i}-hint`, { x: L.M + 32, y: y + 108, w: qW, h: 56 }, 'caption', q.hint, { color: 'steel' }));
        out.push({ kind: 'rect', name: `q-${i}-field`, x: ax, y: y + 20, w: L.W - L.M - ax - 20, h: h - 40, fill: 'paper', radius: 8 });
        if (q.answer) out.push(text(`q-${i}-answer`, { x: ax + 24, y: y + 32, w: L.W - L.M - ax - 68, h: h - 64 }, 'small', q.answer));
      });
      return out;
    }
    const cols = L.cols(2);
    const gap = 32;
    const h = Math.floor((L.contentBottom - top - gap) / 2);
    qs.forEach((q, i) => {
      const { x, w } = cols[i % 2];
      const y = top + Math.floor(i / 2) * (h + gap);
      out.push({ kind: 'rect', name: `q-${i}-card`, x, y, w, h, fill: 'mist', radius: 16 });
      out.push(text(`q-${i}-text`, { x: x + 32, y: y + 24, w: w - 64, h: 76 }, 'bodyStrong', `${num(i)} ${q.question ?? ''}`));
      if (q.hint) out.push(text(`q-${i}-hint`, { x: x + 32, y: y + 104, w: w - 64, h: 56 }, 'caption', q.hint, { color: 'steel' }));
      const fy = y + (q.hint ? 168 : 112);
      out.push({ kind: 'rect', name: `q-${i}-field`, x: x + 20, y: fy, w: w - 40, h: y + h - 20 - fy, fill: 'paper', radius: 8 });
      if (q.answer) out.push(text(`q-${i}-answer`, { x: x + 40, y: fy + 12, w: w - 80, h: y + h - 44 - fy }, 'small', q.answer));
    });
    return out;
  },

  // Фото или креатив с текстом: раскладка задаёт, где фото
  image(slide, ctx) {
    const { L } = ctx;
    const layout = layoutOf(slide);
    const fit = slide.fit === 'contain' ? 'contain' : 'cover';
    if (layout === 'full') {
      const lines = [slide.text, slide.caption].filter(Boolean).join(' — ');
      return {
        theme: 'dark',
        elements: [
          ...picture('photo', { x: 0, y: 0, w: L.W, h: L.H }, slide.image, { fit, radius: 0, dark: true }),
          // плашка под текстом — заголовок читается на любом фото
          { kind: 'rect', name: 'band', x: 0, y: 720, w: L.W, h: L.H - 720, fill: 'ink', radius: 0 },
          text('title', { x: L.M, y: 768, w: L.CW, h: 152 }, 'title', slide.title, { color: 'onDark' }),
          lines ? text('text', { x: L.M, y: 936, w: L.CW, h: 96 }, 'body', lines, { color: 'onDarkMuted' }) : null,
        ],
      };
    }
    if (layout === 'wide') {
      return [
        contentTitle(slide, L),
        ...picture('photo', { x: L.M, y: L.contentTop, w: L.CW, h: 504 }, slide.image, { fit }),
        slide.text ? text('text', { x: L.M, y: 816, w: slide.caption ? 1040 : L.CW, h: 104 }, 'body', slide.text) : null,
        slide.caption ? text('caption', { x: L.W - L.M - 560, y: 816, w: 560, h: 104 }, 'caption', slide.caption, { color: 'steel', align: 'right' }) : null,
      ];
    }
    const imgW = 888;
    const textW = L.CW - imgW - 72;
    const imgX = layout === 'left' ? L.M : L.W - L.M - imgW;
    const textX = layout === 'left' ? L.M + imgW + 72 : L.M;
    const box = { x: imgX, y: L.top - 8, w: imgW, h: slide.caption ? 776 : 824 };
    const points = slide.points?.slice(0, 4) ?? [];
    return [
      text('title', { x: textX, y: L.top - 8, w: textW, h: 232 }, 'title', slide.title),
      slide.text ? text('text', { x: textX, y: 352, w: textW, h: points.length ? 232 : 552 }, 'body', slide.text) : null,
      points.length ? text('points', { x: textX, y: slide.text ? 608 : 352, w: textW, h: slide.text ? 296 : 552 }, 'body', null, { bullets: points }) : null,
      ...picture('photo', box, slide.image, { fit }),
      slide.caption ? text('caption', { x: imgX, y: box.y + box.h + 12, w: imgW, h: 36 }, 'caption', slide.caption, { color: 'steel' }) : null,
    ];
  },

  // Креативы: до шести картинок сеткой или одна крупная и остальные рядом
  gallery(slide, ctx) {
    const { L } = ctx;
    const items = (slide.items ?? []).slice(0, 6);
    const fit = slide.fit === 'cover' ? 'cover' : 'contain';
    const capH = items.some((it) => it.caption) ? 44 : 0;
    const area = { x: L.M, y: L.contentTop, w: L.CW, h: 632 };
    const gap = 32;
    const out = [contentTitle(slide, L)];
    const cell = (it, i, box) => {
      out.push(...picture(`creative-${i}`, { ...box, h: box.h - capH }, it.image, { fit }));
      if (it.caption) out.push(text(`creative-${i}-caption`, { x: box.x, y: box.y + box.h - capH + 8, w: box.w, h: 36 }, 'caption', it.caption, { color: 'steel' }));
    };
    const grid = (list, box, cols, from = 0) => {
      const rows = Math.ceil(list.length / cols);
      const cw = (box.w - gap * (cols - 1)) / cols;
      const ch = (box.h - gap * (rows - 1)) / rows;
      list.forEach((it, i) => cell(it, from + i, { x: Math.round(box.x + (i % cols) * (cw + gap)), y: Math.round(box.y + Math.floor(i / cols) * (ch + gap)), w: Math.round(cw), h: Math.round(ch) }));
    };
    if (!items.length) return [...out, ...picture('creative-0', area, null)];
    if (layoutOf(slide) === 'feature' && items.length > 1) {
      const bigW = 1000;
      cell(items[0], 0, { x: area.x, y: area.y, w: bigW, h: area.h });
      const rest = items.slice(1);
      grid(rest, { x: area.x + bigW + gap, y: area.y, w: area.w - bigW - gap, h: area.h }, rest.length > 2 ? 2 : 1, 1);
      return out;
    }
    const cols = items.length <= 3 ? items.length : items.length === 4 ? 2 : 3;
    grid(items, area, cols);
    return out;
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
