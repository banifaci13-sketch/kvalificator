// Уровень лида A–E (рейтинг 5…1) по таблице «Этапы продаж»:
//   A (5) — звёздный клиент: мировой или федеральный бренд (не обязательно банк);
//   B (4) — рекламный бюджет от 500 000 ₽ в месяц, или клиент, которому можно продать несколько
//           каналов или комплекс, или зарубежный клиент;
//   C (3) — крепкая адекватная компания — все остальные клиенты агентства (по умолчанию);
//   D (2) — собирают КП, нет доступа к ЛПР, важно только «сколько стоит», не проходят по цене
//           (услуга нужна, но хотят контекст за 15–20 000 ₽);
//   E (1) — неадекваты, спам, «нищеброды», стоп-слова.
// Уровень решают явные признаки из таблицы; баллы (score) — справочно: что в заявке говорит в плюс и в минус.
// Пороги и списки — в config/scoring.json (levels, starBrands, priorityIndustries).

const LABELS = {
  budget: 'бюджет',
  industry: 'сфера',
  geography: 'география',
  market: 'рынок',
  role: 'роль',
  decision_maker: 'ЛПР',
  start: 'старт',
  criteria: 'критерий выбора',
  source: 'источник',
};

const TEXT_FIELDS = ['task', 'reason', 'company', 'participants', 'dissatisfaction', 'name', 'clarification'];

// бюджет категорией (сценарий из 19 вопросов) → границы суммы, если точной суммы нет
const BUDGET_RANGE = { lt100k: [0, 99_999], '100_300k': [100_000, 299_999], '300k_1m': [300_000, 999_999], '1m_3m': [1_000_000, 2_999_999], gt3m: [3_000_000, Infinity] };
const DEFAULT_LEVELS = {
  A: { budgetFrom: 3_000_000 },
  B: { budgetFrom: 500_000, multiServiceBudgetFrom: 300_000, priorityIndustryBudgetFrom: 300_000 },
  D: { priceOnlyBudgetBelow: 100_000 },
  E: { budgetBelow: 10_000 },
};
const rub = (v) => `${Math.round(v).toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`;
// «мы — Кредит Европа Банк», «я из Газпромбанка», «представляю AstraZeneca»: бренд в рассказе — только как «мы»
const SELF_RE = '(?<![а-яa-z])(?:мы|мы\\s+—|компания|представляю|представитель|я\\s+из|из\\s+компании|от\\s+лица|работаю\\s+в|наш(?:а|е)?\\s+(?:компания|банк|бренд))';

export function scoreLead(answers, rules, scenario) {
  const reasons = [];
  const tags = [];
  const texts = TEXT_FIELDS.map((f) => answers[f]).filter((v) => typeof v === 'string');
  const allText = texts.join('\n').toLowerCase();
  const L = { ...DEFAULT_LEVELS, ...(rules.levels ?? {}) };
  for (const k of Object.keys(DEFAULT_LEVELS)) L[k] = { ...DEFAULT_LEVELS[k], ...(rules.levels?.[k] ?? {}) };

  // E — стоп-слова и спам: дальше не считаем
  const stopWord = rules.stopWords.find((w) => allText.includes(w.toLowerCase()));
  if (stopWord) {
    return { rating: 1, score: 0, reasons: [`E: стоп-слово «${stopWord}»`], tags: ['стоп-слово'] };
  }
  const task = String(answers.task ?? '').toLowerCase();
  const spam = rules.spamPatterns.find((p) => new RegExp(p, 'iu').test(task));
  if (spam) {
    return { rating: 1, score: 0, reasons: ['E: ответ похож на спам'], tags: ['спам'] };
  }

  // справочные баллы: что в заявке говорит в плюс и в минус
  let score = 0;
  const signals = [];
  for (const [field, table] of Object.entries(rules.points)) {
    const value = answers[field];
    if (value === undefined || !(value in table) || table[value] === 0) continue;
    const points = table[value];
    score += points;
    signals.push(`${points > 0 ? '+' : ''}${points} ${LABELS[field] ?? field}: ${optionLabel(scenario, field, value)}`);
  }

  // бюджет: точная сумма из разговора или границы категории
  const exact = Number.isFinite(answers.budget_rub) && answers.budget_rub > 0 ? answers.budget_rub : null;
  const [low, high] = exact != null ? [exact, exact] : BUDGET_RANGE[answers.budget] ?? [null, null];
  const budgetText = exact != null ? rub(exact) : optionLabel(scenario, 'budget', answers.budget);
  const services = Array.isArray(answers.services) ? answers.services.filter((s) => s !== 'consult') : [];
  const multi = services.length >= 2 || answers.service === 'complex';
  const priority = rules.priorityIndustries.includes(answers.industry);
  const noDecisionMaker = answers.decision_maker === 'other';
  const priceFrom = Number.isFinite(answers.price_from) ? answers.price_from : null;

  // A — звёздный клиент: мировой или федеральный бренд
  const starBrand = findStarBrand([answers.company, answers.site].filter((v) => typeof v === 'string').join(' '), rules.starBrands)
    ?? findStarBrand(texts.join(' '), rules.starBrands, SELF_RE)
    ?? (typeof answers.famous_brand === 'string' && answers.famous_brand.trim() ? answers.famous_brand.trim() : null);
  if (starBrand) tags.push('звёздный бренд');
  if (priority) tags.push('приоритетная сфера');
  if (answers.geography === 'international') tags.push('зарубежный');
  if (answers.market === 'b2b' || answers.market === 'both') tags.push('B2B');
  if (answers.source === 'unistream') tags.push('партнёр «Юнистрим»');
  if (answers.criteria === 'price') tags.push('важна цена');
  if (noDecisionMaker) tags.push('нет доступа к ЛПР');
  if (multi) tags.push('несколько направлений');

  let rating;
  if (starBrand) {
    rating = 5;
    reasons.push(`A: звёздный бренд — ${starBrand}`);
  } else if (low != null && low >= L.A.budgetFrom) {
    rating = 5;
    reasons.push(`A: звёздный клиент — бюджет ${budgetText} в месяц`);
  } else if (high != null && high < L.E.budgetBelow) {
    rating = 1;
    reasons.push(`E: бюджет ${budgetText} — меньше ${rub(L.E.budgetBelow)}`);
  } else {
    // B — бюджет от 500 000, зарубежный клиент, несколько каналов или комплекс, приоритетная сфера при хорошем бюджете
    const b = [];
    if (low != null && low >= L.B.budgetFrom) b.push(`бюджет ${budgetText} в месяц (от ${rub(L.B.budgetFrom)})`);
    if (answers.geography === 'international') b.push('зарубежный клиент');
    if (multi && low != null && low >= L.B.multiServiceBudgetFrom) b.push(`несколько направлений при бюджете от ${rub(L.B.multiServiceBudgetFrom)}`);
    if (priority && low != null && low >= L.B.priorityIndustryBudgetFrom) b.push(`приоритетная сфера при бюджете от ${rub(L.B.priorityIndustryBudgetFrom)}`);
    // D — не проходят по цене, важна только цена, нет доступа к ЛПР
    const d = [];
    if (priceFrom != null && high != null && high < priceFrom) d.push(`бюджет ${budgetText} меньше минимальной стоимости услуг (от ${rub(priceFrom)})`);
    if (answers.criteria === 'price' && high != null && high < L.D.priceOnlyBudgetBelow) d.push(`важна только цена при бюджете до ${rub(L.D.priceOnlyBudgetBelow)}`);
    if (noDecisionMaker) d.push('нет доступа к ЛПР — собирает предложения');

    if (d.some((x) => !x.startsWith('нет доступа'))) {
      rating = 2;
      reasons.push(...d.map((x) => `D: ${x}`));
    } else if (b.length) {
      // признаки B, но решение принимает не он — на ступень ниже
      rating = noDecisionMaker ? 3 : 4;
      reasons.push(...b.map((x) => `B: ${x}`));
      if (noDecisionMaker) reasons.push('C, а не B: нет доступа к ЛПР');
    } else if (d.length) {
      rating = 2;
      reasons.push(...d.map((x) => `D: ${x}`));
    } else {
      rating = 3;
      reasons.push('C: адекватная компания — признаков A, B, D и E нет');
    }
  }
  reasons.push(...signals);
  return { rating, score: round(score), reasons, tags };
}

/** Бренд из списка — целым словом; prefix — только после «мы», «я из», «представляю» (в рассказе о задаче). */
function findStarBrand(text, brands, prefix = null) {
  const t = String(text ?? '').toLowerCase().replace(/ё/g, 'е');
  if (!t.trim()) return null;
  return brands.find((brand) => {
    const escaped = brand.toLowerCase().replace(/ё/g, 'е').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const head = prefix ? `${prefix}\\s+(?:\\S+\\s+){0,2}` : '(^|[^\\p{L}\\p{N}])';
    // окончание допускаем («Газпромбанка», «из Сбербанка»)
    return new RegExp(`${head}${escaped}[а-я]{0,3}($|[^\\p{L}\\p{N}])`, 'u').test(t);
  }) ?? null;
}

export function optionLabel(scenario, stepId, value) {
  const step = scenario.steps.find((s) => s.id === stepId);
  return step?.options?.find((o) => o.value === value)?.label ?? value;
}

/** Уровень квалификации буквой: критерии те же, что у рейтинга 5…1 (A — лучший, E — спам и стоп-слова). */
export const RATING_LETTERS = { 5: 'A', 4: 'B', 3: 'C', 2: 'D', 1: 'E' };
export const ratingLetter = (rating) => RATING_LETTERS[rating] ?? '—';

/** Категория для текста благодарности клиенту. Рейтинг клиенту не показываем. */
export function outroKey(rating) {
  if (rating >= 4) return 'hot';
  if (rating === 3) return 'warm';
  if (rating === 2) return 'cold';
  return 'rejected';
}

const round = (n) => Math.round(n * 10) / 10;
