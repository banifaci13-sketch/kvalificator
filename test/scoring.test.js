import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, outroKey } from '../src/core/scoring.js';
import { scenario, rules, typicalAnswers } from './helpers.js';

const score = (patch) => scoreLead({ ...typicalAnswers, ...patch }, rules, scenario);

test('обычная адекватная компания — 3', () => {
  assert.equal(score({}).rating, 3);
});

test('большой бюджет + приоритетная сфера + собственник — B (A — только бренд)', () => {
  const r = score({ budget: 'gt3m', industry: 'finance', role: 'owner', decision_maker: 'me', start: 'asap', criteria: 'results' });
  assert.equal(r.rating, 4);
  assert.ok(r.tags.includes('приоритетная сфера'));
});

test('бюджет 1–3 млн и финсектор — 4', () => {
  assert.equal(score({ budget: '1m_3m', industry: 'finance', role: 'marketing_head', start: 'month', criteria: 'results' }).rating, 4);
});

test('без бюджета и без признаков B — C, даже при прочих плюсах', () => {
  const r = score({ budget: 'unknown', industry: 'finance', market: 'b2b', role: 'owner', decision_maker: 'me', start: 'asap', criteria: 'results', source: 'recommendation' });
  assert.equal(r.rating, 3);
});

test('звёздный бренд — 5 даже без бюджета', () => {
  const r = score({ company: 'Газпромбанк', budget: 'unknown' });
  assert.equal(r.rating, 5);
  assert.ok(r.tags.includes('звёздный бренд'));
});

test('бренд ищется целым словом, а не подстрокой', () => {
  assert.ok(!score({ company: 'Мтсвязьмонтаж' }).tags.includes('звёздный бренд'));
});

test('«важна цена» + маленький бюджет + нет ЛПР — 2', () => {
  const r = score({ budget: 'lt100k', criteria: 'price', role: 'manager', decision_maker: 'other' });
  assert.equal(r.rating, 2);
  assert.ok(r.tags.includes('нет доступа к ЛПР'));
});

test('стоп-слова — 1', () => {
  const r = score({ task: 'Я рос среди 4х тюрем, сделайте рекламу' });
  assert.equal(r.rating, 1);
});

test('спам — 1', () => {
  assert.equal(score({ task: 'ааааааааааааа' }).rating, 1);
  assert.equal(score({ task: '12345 !!!' }).rating, 1);
});

test('партнёр «Юнистрим» помечается тегом', () => {
  assert.ok(score({ source: 'unistream' }).tags.includes('партнёр «Юнистрим»'));
});

test('у каждой оценки есть объяснение', () => {
  assert.ok(score({ budget: 'gt3m' }).reasons.some((r) => r.includes('бюджет')));
});

test('тексты благодарности по рейтингу', () => {
  assert.equal(outroKey(5), 'hot');
  assert.equal(outroKey(3), 'warm');
  assert.equal(outroKey(2), 'cold');
  assert.equal(outroKey(1), 'rejected');
});

// ---------- уровни по таблице «Этапы продаж» ----------

const level = (a) => ({ 5: 'A', 4: 'B', 3: 'C', 2: 'D', 1: 'E' })[scoreLead({ name: 'Анна', task: 'Нужна реклама для нашей компании, хотим больше заявок', ...a }, rules, scenario).rating];

test('A — мировой или федеральный бренд: оценка ИИ (не только банки), без ИИ — список', () => {
  assert.equal(level({ company: 'Леруа Мерлен', company_scale: 'federal' }), 'A');
  assert.equal(level({ company: 'AstraZeneca', company_scale: 'world' }), 'A');
  assert.equal(level({ company: 'Кредит Европа Банк', budget: 'unknown' }), 'A', 'есть в запасном списке');
  assert.equal(level({ task: 'Здравствуйте, я из Газпромбанка, нужна реклама вклада' }), 'A', 'бренд в рассказе — как «я из …»');
  assert.equal(level({ budget: 'gt3m' }), 'B', 'большой бюджет без бренда — B, не A');
});

test('площадки и упоминания брендов — не A', () => {
  assert.equal(level({ company: 'ozon.ru/seller/mommy', budget: '100_300k' }), 'C', 'селлер на Ozon — не Ozon');
  assert.equal(level({ task: 'Продаём на Wildberries и в Яндекс Маркете, нужен внешний трафик' }), 'C');
  assert.equal(level({ task: 'Работаем с банками, например ВТБ, нужна реклама наших услуг' }), 'C', 'чужой бренд в рассказе');
});

test('B — бюджет от 500 000, может принести неплохо денег, несколько каналов или комплекс; зарубежные тоже', () => {
  assert.equal(level({ budget: '300k_1m', budget_rub: 600_000 }), 'B');
  assert.equal(level({ budget: '1m_3m' }), 'B');
  assert.equal(level({ budget: '300k_1m', budget_rub: 400_000 }), 'C', '400 000 без других признаков — C');
  assert.equal(level({ company_scale: 'large', budget: 'unknown' }), 'B', 'крупная компания по оценке ИИ');
  assert.equal(level({ services: ['context', 'seo'], service: 'complex' }), 'B', 'несколько каналов — без порога бюджета');
  assert.equal(level({ service: 'complex' }), 'B', 'комплекс');
  assert.equal(level({ geography: 'international' }), 'B', 'зарубежный — тоже B, но не обязательно');
  assert.equal(level({ industry: 'realty', budget: '100_300k' }), 'C', 'сфера уровень не меняет');
  assert.equal(level({ industry: 'ecom', budget: '300k_1m', budget_rub: 700_000 }), 'B', 'любая сфера');
});

test('C — все остальные адекватные клиенты, в том числе если почти ничего не известно', () => {
  assert.equal(level({ service: 'context', budget: 'unknown' }), 'C');
  assert.equal(level({ service: 'context', budget: '100_300k', budget_rub: 150_000, agency_experience: 'none', start: 'month' }), 'C');
  assert.equal(level({ company_scale: 'small', service: 'context' }), 'C');
});

test('D — собирает КП / нет ЛПР, только «сколько стоит», не проходит по цене', () => {
  assert.equal(level({ budget: 'lt100k', budget_rub: 20_000, price_from: 30_000 }), 'D', 'контекст за 20 000 при цене от 30 000');
  assert.equal(level({ budget: 'unknown', criteria: 'price' }), 'D');
  assert.equal(level({ budget: '100_300k', decision_maker: 'other', role: 'manager' }), 'D');
});

test('E — неадекваты, нищеброды, «короли мира» (оценка ИИ), стоп-слова, спам', () => {
  assert.equal(level({ inadequate: 'гарантируйте топ-1 за неделю за 3000 рублей' }), 'E');
  assert.equal(level({ task: 'Я рос среди 4х тюрем' }), 'E');
  assert.equal(level({ budget: 'lt100k', budget_rub: 5_000 }), 'C', 'своих порогов нет — только признаки таблицы');
});

test('признаки двух уровней сразу — верхний по таблице', () => {
  assert.equal(level({ company: 'Леруа Мерлен', company_scale: 'federal', decision_maker: 'other' }), 'A');
  assert.equal(level({ budget_rub: 800_000, budget: '300k_1m', criteria: 'price' }), 'B');
  assert.equal(level({ criteria: 'price', inadequate: true }), 'D');
});

test('объяснение уровня — первой строкой, с буквой', () => {
  const r = scoreLead({ ...typicalAnswers, budget: '300k_1m', budget_rub: 600_000 }, rules, scenario);
  assert.match(r.reasons[0], /^B: рекламный бюджет 600 000 ₽ в месяц/);
});
