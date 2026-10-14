// Медиапланы и нормативы агентства в базе; превращение медиаплана в слайды презентации.

import { calcScenario, byChannel, rowLabel, MODELS, KINDS } from './calc.js';
import { fmtNumber, fmtMoney, fmtMoneyShort } from '../docs/templates.js';
import { DocError, leadValues } from '../docs/library.js';

// строк — с запасом под разбивку площадок на кампании; на слайд больше 8 не помещается — там итоги по площадкам
export const LIMITS = { scenarios: 6, rows: 30, months: 36, slideRows: 8 };
const MODEL_IDS = MODELS.map(([id]) => id);

export function createMediaplans({ db, library }) {
  const q = {
    list: db.prepare('SELECT id, title, client, lead_id, spec, created_by, updated_by, created_at, updated_at FROM mediaplans ORDER BY updated_at DESC LIMIT 200'),
    get: db.prepare('SELECT * FROM mediaplans WHERE id = ?'),
    insert: db.prepare('INSERT INTO mediaplans (title, client, lead_id, spec, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare("UPDATE mediaplans SET title = ?, client = ?, spec = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?"),
    remove: db.prepare('DELETE FROM mediaplans WHERE id = ?'),
    benchmarks: db.prepare('SELECT * FROM mp_benchmarks ORDER BY channel COLLATE NOCASE'),
    benchmark: db.prepare('SELECT * FROM mp_benchmarks WHERE id = ?'),
    addBenchmark: db.prepare('INSERT INTO mp_benchmarks (channel, model, cpc, cpm, ctr, cr, note, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    setBenchmark: db.prepare("UPDATE mp_benchmarks SET channel = ?, model = ?, cpc = ?, cpm = ?, ctr = ?, cr = ?, note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?"),
    removeBenchmark: db.prepare('DELETE FROM mp_benchmarks WHERE id = ?'),
  };
  const parse = (row) => row && { ...row, spec: JSON.parse(row.spec) };

  function get(id) {
    const plan = parse(q.get.get(Number(id)));
    if (!plan) throw new DocError('Медиаплан не найден');
    return plan;
  }

  // ---------- нормативы ----------

  function saveBenchmark({ id = null, channel, model = 'cpc', cpc = null, cpm = null, ctr = null, cr = null, note }, user) {
    const name = String(channel ?? '').trim().slice(0, 120);
    if (!name) throw new DocError('Укажите канал');
    if (!MODEL_IDS.includes(model)) throw new DocError('Неизвестная модель закупки');
    const why = String(note ?? '').trim().slice(0, 500);
    // норматив без основания — это догадка; в расчёт клиенту такое не идёт
    if (!why) throw new DocError('Укажите, на чём основан норматив: кампании, период, источник');
    const vals = [checkNum(cpc, 'CPC'), checkNum(cpm, 'CPM'), checkPct(ctr, 'CTR'), checkPct(cr, 'Конверсия')];
    if (model === 'cpc' && vals[0] == null) throw new DocError('Для закупки кликов нужен CPC');
    if (model === 'cpm' && vals[1] == null) throw new DocError('Для закупки показов нужен CPM');
    if (id) {
      if (!q.setBenchmark.run(name, model, ...vals, why, user, Number(id)).changes) throw new DocError('Норматив не найден');
      return q.benchmark.get(Number(id));
    }
    return q.benchmark.get(q.addBenchmark.run(name, model, ...vals, why, user).lastInsertRowid);
  }

  // ---------- медиапланы ----------

  function create({ title, client = '', leadId = null, spec }, user) {
    validatePlan(spec);
    const t = String(title ?? '').trim().slice(0, 200) || `Медиаплан${client ? `: ${client}` : ''}`;
    const { lastInsertRowid } = q.insert.run(t, String(client ?? '').slice(0, 200), leadId, JSON.stringify(spec), user, user);
    return get(lastInsertRowid);
  }

  function update(id, { title, client, spec }, user) {
    const plan = get(id);
    const next = spec ?? plan.spec;
    validatePlan(next);
    q.update.run(String(title ?? plan.title).slice(0, 200), String(client ?? plan.client ?? '').slice(0, 200), JSON.stringify(next), user, plan.id);
    return get(id);
  }

  /** Нормативы, на которые ссылаются строки плана, — для листа допущений в Excel. */
  function usedBenchmarks(plan) {
    const ids = new Set(plan.spec.scenarios.flatMap((s) => s.rows.map((r) => r.benchmark)).filter(Boolean));
    return q.benchmarks.all().filter((b) => ids.has(b.id));
  }

  /**
   * Слайды «Прогноз на период» (KPI) и «Медиаплан по каналам» для сценария.
   * Статус данных — прогноз, источник — расчёт агентства: проверка документа это требует.
   */
  function slidesFor(plan, scenarioIndex = 0) {
    const sc = plan.spec.scenarios[scenarioIndex];
    if (!sc) throw new DocError('Сценарий не найден');
    const { rows, period } = calcScenario(sc, plan.spec);
    const m = period.months;
    if (plan.spec.kind === 'ecom') return ecomSlides(plan, sc, rows, period);
    const lines = slideLines(plan, sc, rows)
      .map(({ label, c }) => {
        // в таблице лидов бюджеты без НДС — как и написано в допущениях
        const row = { channel: label, budget: Math.round(c.net * m) };
        if (c.impressions != null) row.impressions = Math.round(c.impressions * m);
        if (c.clicks != null) row.clicks = Math.round(c.clicks * m);
        if (c.leads != null) row.leads = Math.round(c.leads * m);
        return row;
      });
    if (!lines.length) throw new DocError('В сценарии нет каналов с бюджетом');
    const periodText = `${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}`;
    const base = `Прогноз на ${periodText} по нормативам агентства: ставки, CTR и конверсия в лид по каналам. Бюджеты без комиссии агентства и НДС.`;
    const own = plan.spec.assumptions?.trim();
    const common = { dataStatus: 'forecast', source: 'Расчёт агентства', period: periodText };
    const kpis = [];
    if (period.leads != null) kpis.push({ value: fmtNumber(Math.round(period.leads)), label: 'лидов за период', delta: '' });
    if (period.cpl != null) kpis.push({ value: fmtMoney(period.cpl), label: 'стоимость лида с комиссией и НДС', delta: '' });
    kpis.push({ value: fmtMoneyShort(period.total), label: 'бюджет с комиссией и НДС', delta: exact(period.total) });
    if (period.drr != null) kpis.push({ value: `${fmtNumber(+(period.drr * 100).toFixed(1))} %`, label: 'ДРР — доля рекламы в выручке', delta: '' });
    const suffix = plan.spec.scenarios.length > 1 ? `: ${sc.name}` : '';
    return [
      { type: 'kpi', title: `Прогноз на ${periodText}${suffix}`, kpis: kpis.slice(0, 4), ...common },
      { type: 'mediaplan', title: `Медиаплан по каналам${suffix}`, rows: lines, assumptions: own ? `${base} ${own}` : base, ...common },
    ];
  }

  /**
   * Строки таблицы на слайде: каждая кампания отдельно («Яндекс Директ — РСЯ»), а если строк больше,
   * чем помещается на слайд, — итоги по площадкам (подробности остаются в Excel и PDF).
   */
  function slideLines(plan, sc, rows) {
    const each = sc.rows
      .map((r, i) => ({ r, label: rowLabel(r), c: rows[i] }))
      .filter(({ r, c }) => r.channel?.trim() && c.budget);
    if (each.length <= LIMITS.slideRows) return each;
    return byChannel(sc, plan.spec)
      .filter((g) => g.month.budget)
      .map((g) => ({ r: null, label: g.count > 1 ? `${g.channel} (${g.count} ${plural(g.count, 'кампания', 'кампании', 'кампаний')})` : g.channel, c: g.month }));
  }

  /** Интернет-магазин: прогноз продаж, выручки и ДРР; таблица по площадкам с бюджетом с НДС. */
  function ecomSlides(plan, sc, rows, period) {
    const m = period.months;
    const round = (v) => (v == null ? undefined : Math.round(v));
    const lines = slideLines(plan, sc, rows)
      .map(({ r, label, c }) => {
        const segments = String(r?.targeting ?? '').split(/\n|;/).map((x) => x.trim()).filter(Boolean);
        const targeting = segments.join(', ');
        const row = { channel: label, budget: Math.round(c.gross * m) };
        if (targeting) row.targeting = targeting.length > 80 ? `${targeting.slice(0, 78)}…` : targeting;
        for (const [k, v] of [['clicks', c.clicks], ['carts', c.carts], ['sales', c.sales], ['revenue', c.revenue]]) {
          const x = round(v == null ? null : v * m);
          if (x !== undefined) row[k] = x;
        }
        return row;
      });
    if (!lines.length) throw new DocError('В сценарии нет площадок с бюджетом');
    const periodText = `${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}`;
    const base = `Прогноз на ${periodText} по нормативам агентства: ставки, конверсии в корзину и в продажу, средний чек. Бюджеты с НДС, без комиссии агентства.`;
    const own = plan.spec.assumptions?.trim();
    const common = { dataStatus: 'forecast', source: 'Расчёт агентства', period: periodText };
    const kpis = [];
    if (period.sales != null) kpis.push({ value: fmtNumber(Math.round(period.sales)), label: 'продаж за период', delta: period.cps != null ? `${fmtMoney(period.cps)} за продажу` : '' });
    if (period.revenue != null) kpis.push({ value: fmtMoneyShort(period.revenue), label: 'выручка', delta: exact(period.revenue) });
    kpis.push({ value: fmtMoneyShort(period.total), label: 'бюджет с НДС и комиссией', delta: exact(period.total) });
    if (period.drr != null) kpis.push({ value: `${fmtNumber(+(period.drr * 100).toFixed(1))} %`, label: 'ДРР — доля рекламы в выручке', delta: '' });
    const suffix = plan.spec.scenarios.length > 1 ? `: ${sc.name}` : '';
    return [
      { type: 'kpi', title: `Прогноз на ${periodText}${suffix}`, kpis: kpis.slice(0, 4), ...common },
      { type: 'ecomplan', title: `Медиаплан по площадкам${suffix}`, rows: lines, assumptions: own ? `${base} ${own}` : base, ...common },
    ];
  }

  /** В новую презентацию (шаблон «Медиаплан») или в конец существующей. */
  function toDocument(id, { scenario = 0, documentId = null }, user) {
    const plan = get(id);
    const slides = slidesFor(plan, scenario);
    if (documentId) {
      const doc = library.getDocument(documentId);
      return library.updateDocument(doc.id, { spec: { ...doc.spec, slides: [...doc.spec.slides, ...slides] } }, user.name);
    }
    const m = plan.spec.months ?? 1;
    const values = {
      ...leadValues(null, { steps: [] }, user),
      client: plan.client || '',
      period: `${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}`,
    };
    const doc = library.createDocument({ templateId: 'builtin:mediaplan', values, title: plan.title, leadId: plan.lead_id }, user.name);
    const next = [];
    let inserted = false;
    for (const s of doc.spec.slides) {
      if (s.type === 'kpi' || s.type === 'mediaplan' || s.type === 'ecomplan') {
        if (!inserted) next.push(...slides);
        inserted = true;
      } else next.push(s);
    }
    return library.updateDocument(doc.id, { spec: { ...doc.spec, slides: next } }, user.name);
  }

  return {
    list: () => q.list.all().map((r) => {
      const spec = JSON.parse(r.spec);
      const main = calcScenario(spec.scenarios[0], spec);
      const { spec: _, ...rest } = r;
      return { ...rest, kind: spec.kind ?? 'leads', months: spec.months, scenarios: spec.scenarios.length, total: main.period.total, leads: main.period.leads, sales: main.period.sales ?? null, revenue: main.period.revenue ?? null };
    }),
    get,
    create,
    update,
    remove: (id) => {
      get(id);
      q.remove.run(Number(id));
    },
    benchmarks: () => q.benchmarks.all(),
    saveBenchmark,
    removeBenchmark: (id) => {
      if (!q.removeBenchmark.run(Number(id)).changes) throw new DocError('Норматив не найден');
    },
    usedBenchmarks,
    slidesFor,
    toDocument,
  };
}

/** Точная сумма под округлённой — только если округление что-то скрыло. */
function exact(v) {
  return fmtMoneyShort(v) === fmtMoney(v) ? '' : fmtMoney(v);
}

function checkNum(v, label) {
  if (v == null || v === '') return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new DocError(`${label}: нужно неотрицательное число`);
  return v;
}

function checkPct(v, label) {
  const n = checkNum(v, label);
  if (n != null && n > 100) throw new DocError(`${label}: не больше 100 %`);
  return n;
}

export function validatePlan(spec) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.scenarios)) throw new DocError('Неверная структура медиаплана');
  if (!spec.scenarios.length) throw new DocError('Нужен хотя бы один сценарий');
  if (spec.scenarios.length > LIMITS.scenarios) throw new DocError(`Не больше ${LIMITS.scenarios} сценариев`);
  const months = spec.months ?? 1;
  if (!Number.isInteger(months) || months < 1 || months > LIMITS.months) throw new DocError(`Период — от 1 до ${LIMITS.months} месяцев`);
  if (spec.kind != null && !KINDS.some(([k]) => k === spec.kind)) throw new DocError('Неизвестный вид медиаплана');
  const s = spec.settings ?? {};
  if (s.budgetWithVat != null && typeof s.budgetWithVat !== 'boolean') throw new DocError('Неверная настройка НДС');
  checkPct(s.agencyFee, 'Комиссия агентства');
  checkNum(s.agencyFixed, 'Фиксированная комиссия');
  checkPct(s.vat, 'НДС');
  checkPct(s.saleRate, 'Конверсия в продажу');
  checkNum(s.avgCheck, 'Средний чек');
  spec.scenarios.forEach((sc, i) => {
    if (!Array.isArray(sc.rows)) throw new DocError(`Сценарий ${i + 1}: нет списка каналов`);
    if (sc.rows.length > LIMITS.rows) throw new DocError(`Сценарий «${sc.name}»: не больше ${LIMITS.rows} строк`);
    sc.rows.forEach((r) => {
      if (!MODEL_IDS.includes(r.model)) throw new DocError('Неизвестная модель закупки');
      checkNum(r.budget, 'Бюджет');
      checkNum(r.cpc, 'CPC');
      checkNum(r.cpm, 'CPM');
      checkPct(r.ctr, 'CTR');
      checkPct(r.cr, 'Конверсия в лид');
      checkPct(r.cart, 'Конверсия в корзину');
      checkPct(r.sale, 'Конверсия в продажу');
      checkNum(r.check, 'Средний чек');
      if (r.targeting != null && (typeof r.targeting !== 'string' || r.targeting.length > 1000)) throw new DocError('Таргетинг — текст до 1000 символов');
      if (r.campaign != null && (typeof r.campaign !== 'string' || r.campaign.length > 120)) throw new DocError('Тип размещения или кампания — до 120 символов');
    });
  });
  if (JSON.stringify(spec).length > 100_000) throw new DocError('Медиаплан слишком большой');
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
