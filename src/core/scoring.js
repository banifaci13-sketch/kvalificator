// Оценка лида 1–5 по таблице «Этапы продаж»:
// 5 — звёздный клиент / доход агентству 300 000+; 4 — бюджет 1 млн+ или доход 150 000+;
// 3 — крепкая адекватная компания; 2 — «сколько стоит», нет ЛПР; 1 — спам, стоп-слова.

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

const TEXT_FIELDS = ['task', 'reason', 'company', 'participants', 'dissatisfaction', 'name'];

export function scoreLead(answers, rules, scenario) {
  const reasons = [];
  const tags = [];
  const texts = TEXT_FIELDS.map((f) => answers[f]).filter((v) => typeof v === 'string');
  const allText = texts.join('\n').toLowerCase();

  // 1 — стоп-слова и спам: дальше не считаем
  const stopWord = rules.stopWords.find((w) => allText.includes(w.toLowerCase()));
  if (stopWord) {
    return { rating: 1, score: 0, reasons: [`стоп-слово «${stopWord}»`], tags: ['стоп-слово'] };
  }
  const task = String(answers.task ?? '').toLowerCase();
  const spam = rules.spamPatterns.find((p) => new RegExp(p, 'iu').test(task));
  if (spam) {
    return { rating: 1, score: 0, reasons: ['ответ похож на спам'], tags: ['спам'] };
  }

  let score = 0;
  for (const [field, table] of Object.entries(rules.points)) {
    const value = answers[field];
    if (value === undefined || !(value in table) || table[value] === 0) continue;
    const points = table[value];
    score += points;
    reasons.push(`${points > 0 ? '+' : ''}${points} ${LABELS[field] ?? field}: ${optionLabel(scenario, field, value)}`);
  }

  // «Отвечает охотно или надо тянуть информацию?»
  const optional = scenario.steps.filter((s) => !s.required);
  const answeredOptional = optional.filter((s) => s.id in answers).length;
  const avgTextLength = texts.length ? texts.reduce((n, t) => n + t.length, 0) / texts.length : 0;
  const share = optional.length ? answeredOptional / optional.length : 1;
  if (share >= 0.75 && avgTextLength >= 25) {
    score += rules.engagement.engagedBonus;
    reasons.push(`+${rules.engagement.engagedBonus} отвечает охотно и подробно`);
  } else if (share < 0.25 && avgTextLength < 15) {
    score += rules.engagement.reluctantPenalty;
    reasons.push(`${rules.engagement.reluctantPenalty} отвечает неохотно`);
  }

  const starBrand = findStarBrand(String(answers.company ?? ''), rules.starBrands);
  if (starBrand) {
    tags.push('звёздный бренд');
    reasons.push(`звёздный бренд: ${starBrand}`);
  }
  if (rules.priorityIndustries.includes(answers.industry)) tags.push('приоритетная сфера');
  if (answers.geography === 'international') tags.push('зарубежный');
  if (answers.market === 'b2b' || answers.market === 'both') tags.push('B2B');
  if (answers.source === 'unistream') tags.push('партнёр «Юнистрим»');
  if (answers.criteria === 'price') tags.push('важна цена');
  if (answers.decision_maker === 'other' && answers.role === 'manager') tags.push('нет доступа к ЛПР');

  let rating = 2;
  if (score >= rules.thresholds['5']) rating = 5;
  else if (score >= rules.thresholds['4']) rating = 4;
  else if (score >= rules.thresholds['3']) rating = 3;

  // «Звёздный клиент, мировой или федеральный бренд» — 5 по определению из таблицы.
  // Остальным без подтверждённого бюджета 4–5 не ставим.
  if (starBrand) {
    rating = 5;
  } else {
    if (rating === 5 && !rules.caps.rating5.budget.includes(answers.budget)) rating = 4;
    if (rating === 4 && !rules.caps.rating4.budget.includes(answers.budget)) rating = 3;
  }
  // «Важна только цена» при маленьком бюджете — типичный рейтинг 2
  if (answers.criteria === 'price' && answers.budget === 'lt100k') rating = Math.min(rating, 2);

  return { rating, score: round(score), reasons, tags };
}

function findStarBrand(company, brands) {
  const text = company.toLowerCase();
  return brands.find((brand) => {
    const escaped = brand.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
  });
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
