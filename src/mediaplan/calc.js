// Расчёт медиаплана. Чистый модуль без зависимостей: тот же код считает в админке (браузер),
// в выгрузке Excel и при вставке в презентацию — цифры везде одинаковые.
//
// Два вида плана:
//   leads — услуги: клики → лиды (конверсия в лид), CPL; продажи и выручка — по плану в целом.
//   ecom  — интернет-магазин: клики → корзины (CR1) и клики → продажи (CR2), средний чек,
//           выручка и ДРР по каждой строке. Так считают медиапланы для e-commerce в агентстве.
//
// Бюджет строки — в месяц. Его вводят без НДС или с НДС (settings.budgetWithVat); клики считаются
// от бюджета без НДС, потому что ставки CPC/CPM в кабинетах — без НДС.
//   CPC: клики = бюджет без НДС / CPC;          показы = клики / CTR (если CTR задан)
//   CPM: показы = бюджет без НДС / CPM × 1000;  клики = показы × CTR
// Проценты (CTR, конверсии, комиссия, НДС) хранятся в процентах: 2.5 — это 2,5 %.
// Комиссия агентства = процент от медиабюджета + фиксированная часть (₽ в месяц, без НДС).

export const MODELS = [
  ['cpc', 'Клики (CPC)'],
  ['cpm', 'Показы (CPM)'],
];

export const KINDS = [
  ['leads', 'Лиды (услуги)'],
  ['ecom', 'Интернет-магазин'],
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v) => (num(v) == null ? null : v / 100);
const div = (a, b) => (a != null && b ? a / b : null);
const mul = (a, b) => (a != null && b != null ? a * b : null);

export function emptyPlan(kind = 'leads') {
  return {
    kind,
    months: 1,
    settings: { agencyFee: null, agencyFixed: null, vat: null, budgetWithVat: false, saleRate: null, avgCheck: null },
    scenarios: [{ name: 'Основной', rows: [emptyRow()] }],
    assumptions: '',
  };
}

export function emptyRow(b = null) {
  return {
    channel: b?.channel ?? '',
    // тип размещения или кампания внутри площадки: «Поиск», «РСЯ», «Кампания „Бренд“»
    campaign: '',
    targeting: '',
    model: b?.model ?? 'cpc',
    budget: null,
    cpc: b?.cpc ?? null,
    cpm: b?.cpm ?? null,
    ctr: b?.ctr ?? null,
    cr: b?.cr ?? null,
    cart: null,
    sale: null,
    check: null,
    benchmark: b?.id ?? null,
  };
}

/** Расчёт одной строки (в месяц). Пустые входные данные дают null, а не ноль. */
export function calcRow(r, plan = {}) {
  const s = plan.settings ?? {};
  const vatRate = pct(s.vat) ?? 0;
  const budget = num(r.budget);
  const net = budget == null ? null : s.budgetWithVat ? budget / (1 + vatRate) : budget;
  const gross = budget == null ? null : s.budgetWithVat ? budget : budget * (1 + vatRate);
  const ctr = pct(r.ctr);
  let impressions = null;
  let clicks = null;
  if (r.model === 'cpm') {
    impressions = div(net, num(r.cpm)) == null ? null : (net / r.cpm) * 1000;
    clicks = impressions != null && ctr != null ? impressions * ctr : null;
  } else {
    clicks = div(net, num(r.cpc));
    impressions = clicks != null && ctr ? clicks / ctr : null;
  }
  const out = { budget, net, gross, impressions, clicks, cpc: div(net, clicks) };
  if (plan.kind === 'ecom') {
    const carts = mul(clicks, pct(r.cart));
    const sales = mul(clicks, pct(r.sale));
    const check = num(r.check) ?? num(s.avgCheck);
    const revenue = mul(sales, check);
    return { ...out, carts, cpa: div(gross, carts), sales, cps: div(gross, sales), check, revenue, drr: div(gross, revenue) };
  }
  const leads = mul(clicks, pct(r.cr));
  return { ...out, leads, cpl: div(net, leads) };
}

const sum = (rows, k) => (rows.some((r) => r[k] != null) ? rows.reduce((n, r) => n + (r[k] ?? 0), 0) : null);
const times = (v, m) => (v == null ? null : v * m);

/** Сценарий целиком: строки, итог в месяц, итог за период с комиссией и НДС, продажи. */
export function calcScenario(scenario, plan) {
  const months = Math.max(1, num(plan.months) ?? 1);
  const s = plan.settings ?? {};
  const ecom = plan.kind === 'ecom';
  const rows = scenario.rows.map((r) => calcRow(r, plan));
  const month = {};
  for (const k of ['budget', 'net', 'gross', 'impressions', 'clicks', ...(ecom ? ['carts', 'sales', 'revenue'] : ['leads'])]) month[k] = sum(rows, k);
  month.cpc = div(month.net, month.clicks);
  if (ecom) {
    month.cpa = div(month.gross, month.carts);
    month.cps = div(month.gross, month.sales);
    month.drr = div(month.gross, month.revenue);
  } else {
    month.cpl = div(month.net, month.leads);
  }

  const media = (month.net ?? 0) * months;
  // комиссия агентства: процент от медиабюджета и (или) фиксированная часть в месяц, обе без НДС
  const fee = media * (pct(s.agencyFee) ?? 0) + (num(s.agencyFixed) ?? 0) * months;
  const vat = (media + fee) * (pct(s.vat) ?? 0);
  const total = media + fee + vat;
  const period = {
    months, media, fee, vat, total,
    clicks: times(month.clicks, months),
    impressions: times(month.impressions, months),
  };
  if (ecom) {
    Object.assign(period, {
      leads: null,
      carts: times(month.carts, months),
      sales: times(month.sales, months),
      revenue: times(month.revenue, months),
    });
    period.cpa = div(total, period.carts);
    period.cps = div(total, period.sales);
  } else {
    const leads = times(month.leads, months);
    const sales = leads != null && pct(s.saleRate) != null ? leads * pct(s.saleRate) : null;
    const revenue = sales != null && num(s.avgCheck) != null ? sales * s.avgCheck : null;
    // стоимость лида с комиссией и НДС — во сколько лид обходится клиенту
    Object.assign(period, { leads, cpl: div(total, leads), sales, revenue });
  }
  // ДРР — доля рекламных расходов в выручке
  period.drr = div(total, period.revenue);
  return { rows, month, period };
}

// ---------- площадки и кампании ----------
// Строки одной площадки (подряд) — группа: «Яндекс Директ» → «Поиск», «РСЯ», отдельные кампании.
// В таблице у группы общая ячейка площадки и строка «Итого по площадке».

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е');
/** Одна и та же площадка: без учёта регистра и пробелов по краям; пустая — ни с чем не совпадает. */
export const sameChannel = (a, b) => Boolean(norm(a)) && norm(a) === norm(b);

/** Группы подряд идущих строк одной площадки: [{ channel, from, to }] (to — включительно). */
export function channelGroups(rows) {
  const out = [];
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j + 1 < rows.length && sameChannel(rows[j + 1].channel, rows[i].channel)) j++;
    out.push({ channel: String(rows[i].channel ?? '').trim(), from: i, to: j });
    i = j + 1;
  }
  return out;
}

/** Есть ли разбивка: хотя бы у одной площадки больше одной строки. */
export const hasBreakdown = (rows) => channelGroups(rows).some((g) => g.channel && g.to > g.from);

/** Итог по каждой площадке за месяц (строки одной площадки складываются, даже если стоят не подряд). */
export function byChannel(scenario, plan) {
  const map = new Map();
  for (const r of scenario.rows) {
    const key = norm(r.channel);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { channel: String(r.channel).trim(), rows: [] });
    map.get(key).rows.push(r);
  }
  return [...map.values()].map((g) => ({ channel: g.channel, count: g.rows.length, month: calcScenario({ rows: g.rows }, plan).month }));
}

/** Колонка «Тип размещения, кампания, таргетинг» в выгрузках: кампания первой строкой, ниже сегменты. */
export const rowDetail = (r) => [String(r.campaign ?? '').trim(), String(r.targeting ?? '').trim()].filter(Boolean).join('\n');

/** Подпись строки: «Яндекс Директ — РСЯ». */
export const rowLabel = (r) => [String(r.channel ?? '').trim(), String(r.campaign ?? '').trim()].filter(Boolean).join(' — ');

/** Подсказки для поля «Тип или кампания» по площадке. */
const CAMPAIGN_HINTS = [
  [/директ|yandex|яндекс(?!\s*(маркет|бизнес))/i, ['Поиск', 'РСЯ', 'Единая перфоманс-кампания', 'Мастер кампаний', 'Товарная кампания', 'Ретаргетинг', 'Брендовые запросы', 'Конкуренты']],
  [/vk|вк|вконтакт/i, ['Лид-формы', 'Трафик на сайт', 'Сообщения в сообщество', 'Подписчики', 'Ретаргетинг', 'Каталог товаров']],
  [/telegram|телеграм/i, ['Каналы по тематикам', 'Конкретные каналы', 'Боты', 'Ретаргетинг', 'Посевы']],
  [/mytarget|майтаргет/i, ['Одноклассники', 'Мобильные приложения', 'Ретаргетинг']],
  [/sber|сбер/i, ['Охват', 'Трафик', 'Ретаргетинг']],
  [/ozon|озон|wildberries|вайлдберр|wb|маркет/i, ['Продвижение в поиске', 'Продвижение в каталоге', 'Трафареты', 'Баннеры', 'Брендовая полка', 'Внешний трафик']],
  [/авито/i, ['Продвижение объявлений', 'Медийная реклама']],
  [/google|гугл/i, ['Поиск', 'КМС', 'Performance Max', 'YouTube']],
  [/2\s*гис|2gis/i, ['Приоритетное размещение', 'Брендирование карточки']],
];
export function campaignHints(channel) {
  return CAMPAIGN_HINTS.find(([re]) => re.test(String(channel ?? '')))?.[1] ?? ['Поиск', 'Ретаргетинг', 'Брендовые запросы', 'Охватная кампания'];
}

export function calcPlan(plan) {
  return plan.scenarios.map((sc) => ({ name: sc.name, ...calcScenario(sc, plan) }));
}
