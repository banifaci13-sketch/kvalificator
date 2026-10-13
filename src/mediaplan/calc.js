// Расчёт медиаплана. Чистый модуль без зависимостей: тот же код считает в админке (браузер),
// в выгрузке Excel и при вставке в презентацию — цифры везде одинаковые.
//
// Строка канала: бюджет в месяц и модель закупки.
//   CPC: клики = бюджет / CPC;            показы = клики / CTR (если CTR задан)
//   CPM: показы = бюджет / CPM × 1000;    клики = показы × CTR
//   лиды = клики × конверсия в лид;  CPL = бюджет / лиды
// Проценты (CTR, конверсии, комиссия, НДС) хранятся в процентах: 2.5 — это 2,5 %.

export const MODELS = [
  ['cpc', 'Клики (CPC)'],
  ['cpm', 'Показы (CPM)'],
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v) => (num(v) == null ? null : v / 100);
const div = (a, b) => (a != null && b ? a / b : null);

export function emptyPlan() {
  return {
    months: 1,
    settings: { agencyFee: null, vat: null, saleRate: null, avgCheck: null },
    scenarios: [{ name: 'Основной', rows: [emptyRow()] }],
    assumptions: '',
  };
}

export function emptyRow(b = null) {
  return {
    channel: b?.channel ?? '',
    model: b?.model ?? 'cpc',
    budget: null,
    cpc: b?.cpc ?? null,
    cpm: b?.cpm ?? null,
    ctr: b?.ctr ?? null,
    cr: b?.cr ?? null,
    benchmark: b?.id ?? null,
  };
}

/** Расчёт одной строки (в месяц). Пустые входные данные дают null, а не ноль. */
export function calcRow(r) {
  const budget = num(r.budget);
  const ctr = pct(r.ctr);
  let impressions = null;
  let clicks = null;
  if (r.model === 'cpm') {
    impressions = div(budget, num(r.cpm)) == null ? null : (budget / r.cpm) * 1000;
    clicks = impressions != null && ctr != null ? impressions * ctr : null;
  } else {
    clicks = div(budget, num(r.cpc));
    impressions = clicks != null && ctr ? clicks / ctr : null;
  }
  const cr = pct(r.cr);
  const leads = clicks != null && cr != null ? clicks * cr : null;
  return { budget, impressions, clicks, leads, cpc: div(budget, clicks), cpl: div(budget, leads) };
}

const sum = (rows, k) => (rows.some((r) => r[k] != null) ? rows.reduce((n, r) => n + (r[k] ?? 0), 0) : null);

/** Сценарий целиком: строки, итог в месяц, итог за период с комиссией и НДС, продажи. */
export function calcScenario(scenario, plan) {
  const months = Math.max(1, num(plan.months) ?? 1);
  const s = plan.settings ?? {};
  const rows = scenario.rows.map(calcRow);
  const month = {
    budget: sum(rows, 'budget'),
    impressions: sum(rows, 'impressions'),
    clicks: sum(rows, 'clicks'),
    leads: sum(rows, 'leads'),
  };
  month.cpc = div(month.budget, month.clicks);
  month.cpl = div(month.budget, month.leads);

  const media = (month.budget ?? 0) * months;
  const fee = media * (pct(s.agencyFee) ?? 0);
  const vat = (media + fee) * (pct(s.vat) ?? 0);
  const total = media + fee + vat;
  const leads = month.leads == null ? null : month.leads * months;
  const sales = leads != null && pct(s.saleRate) != null ? leads * pct(s.saleRate) : null;
  const revenue = sales != null && num(s.avgCheck) != null ? sales * s.avgCheck : null;
  const period = {
    months, media, fee, vat, total, leads,
    clicks: month.clicks == null ? null : month.clicks * months,
    impressions: month.impressions == null ? null : month.impressions * months,
    // стоимость лида с комиссией и НДС — во сколько лид обходится клиенту
    cpl: div(total, leads),
    sales, revenue,
    // ДРР — доля рекламных расходов в выручке
    drr: div(total, revenue),
  };
  return { rows, month, period };
}

export function calcPlan(plan) {
  return plan.scenarios.map((sc) => ({ name: sc.name, ...calcScenario(sc, plan) }));
}
