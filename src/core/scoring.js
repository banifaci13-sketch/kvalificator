// Уровень лида A–E (рейтинг 5…1) по таблице «Этапы продаж»:
//   A (5) — звёздный клиент: мировой или федеральный бренд, не обязательно банк. Масштаб бренда
//           оценивает ИИ по названию и рассказу клиента; список starBrands — запасной путь без ИИ;
//   B (4) — рекламный бюджет от 500 000 ₽ в месяц, либо клиент, который потенциально может принести
//           неплохо денег (оценка ИИ), либо можно продать несколько каналов или комплекс; зарубежные
//           клиенты тоже сюда;
//   C (3) — крепкая адекватная компания — все остальные клиенты агентства (по умолчанию);
//   D (2) — собирают КП, нет доступа к ЛПР, важно только «сколько стоит», не проходят по цене
//           (услуга нужна, но хотят контекст за 15–20 000 ₽);
//   E (1) — неадекваты, спам, «нищеброды», «короли мира», стоп-слова (неадекватность оценивает ИИ).
// Сфера (финансы, B2B, недвижимость, медицина, авто…) уровень не меняет — это метки для менеджера.
// Баллы (score) — справочно. Пороги и списки — в config/scoring.json.

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
const DEFAULT_LEVELS = { B: { budgetFrom: 500_000 } };
const rub = (v) => `${Math.round(v).toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`;
// «мы — Кредит Европа Банк», «я из Газпромбанка», «представляю AstraZeneca»: бренд в рассказе — только как «мы»
const SELF_RE = '(?<![а-яa-z])(?:мы|мы\\s+—|компания|представляю|представитель|я\\s+из|из\\s+компании|от\\s+лица|работаю\\s+в|наш(?:а|е)?\\s+(?:компания|банк|бренд))';

export function scoreLead(answers, rules, scenario) {
  const reasons = [];
  const tags = [];
  const texts = TEXT_FIELDS.map((f) => answers[f]).filter((v) => typeof v === 'string');
  const allText = texts.join('\n').toLowerCase();
  const L = { B: { ...DEFAULT_LEVELS.B, ...(rules.levels?.B ?? {}) } };

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

  // A — мировой или федеральный бренд: оценка ИИ, а без неё — список брендов
  const scale = answers.company_scale;
  const listBrand = findStarBrand([answers.company, answers.site].filter((v) => typeof v === 'string').join(' '), rules.starBrands)
    ?? findStarBrand(texts.join(' '), rules.starBrands, SELF_RE);
  const bigBrand = scale === 'world' || scale === 'federal' ? (answers.company || 'по рассказу клиента') : listBrand;
  if (bigBrand) tags.push('звёздный бренд');
  if (priority) tags.push('приоритетная сфера');
  if (answers.geography === 'international') tags.push('зарубежный');
  if (answers.market === 'b2b' || answers.market === 'both') tags.push('B2B');
  if (answers.source === 'unistream') tags.push('партнёр «Юнистрим»');
  if (answers.criteria === 'price') tags.push('важна цена');
  if (noDecisionMaker) tags.push('нет доступа к ЛПР');
  if (multi) tags.push('несколько направлений');

  // признаки — только формулировки таблицы
  const b = [];
  if (low != null && low >= L.B.budgetFrom) b.push(`рекламный бюджет ${budgetText} в месяц (от ${rub(L.B.budgetFrom)})`);
  if (scale === 'large') b.push('может принести неплохо денег (оценка ИИ)');
  if (multi) b.push(`можно продать несколько каналов или комплекс${services.length >= 2 ? ` (${services.length})` : ''}`);
  if (answers.geography === 'international') b.push('зарубежный клиент');
  const d = [];
  if (noDecisionMaker) d.push('собирает КП, нет доступа к ЛПР');
  if (answers.criteria === 'price') d.push('важно только «сколько стоит»');
  if (priceFrom != null && high != null && high < priceFrom) d.push(`не проходит по цене: бюджет ${budgetText} меньше стоимости услуг (от ${rub(priceFrom)})`);
  const e = [];
  if (answers.inadequate) e.push(`${typeof answers.inadequate === 'string' ? answers.inadequate : 'неадекват, нищеброд или «король мира»'} (оценка ИИ)`);

  // признаки двух уровней сразу — берём верхний по таблице: A → B → D → E; нет признаков — C
  let rating;
  if (bigBrand) {
    rating = 5;
    reasons.push(`A: ${scale === 'world' ? 'мировой' : 'федеральный'} бренд — ${bigBrand}${scale === 'world' || scale === 'federal' ? ' (оценка ИИ)' : ''}`);
  } else if (b.length) {
    rating = 4;
    reasons.push(...b.map((x) => `B: ${x}`));
  } else if (d.length) {
    rating = 2;
    reasons.push(...d.map((x) => `D: ${x}`));
  } else if (e.length) {
    rating = 1;
    reasons.push(...e.map((x) => `E: ${x}`));
  } else {
    rating = 3;
    reasons.push('C: крепкая адекватная компания — признаков A, B, D и E нет');
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
