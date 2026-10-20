import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, outroKey } from '../src/core/scoring.js';
import { scenario, rules, typicalAnswers } from './helpers.js';

const score = (patch) => scoreLead({ ...typicalAnswers, ...patch }, rules, scenario);

test('обычная адекватная компания — 3', () => {
  assert.equal(score({}).rating, 3);
});

test('большой бюджет + приоритетная сфера + собственник — 5', () => {
  const r = score({ budget: 'gt3m', industry: 'finance', role: 'owner', decision_maker: 'me', start: 'asap', criteria: 'results' });
  assert.equal(r.rating, 5);
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

test('A — мировой или федеральный бренд (не только банки) или бюджет от 3 млн', () => {
  assert.equal(level({ company: 'Кредит Европа Банк', budget: 'unknown' }), 'A');
  assert.equal(level({ company: 'AstraZeneca' }), 'A');
  assert.equal(level({ company: 'Юнистрим' }), 'A');
  assert.equal(level({ task: 'Здравствуйте, я из Газпромбанка, нужна реклама вклада' }), 'A', 'бренд в рассказе — как «я из …»');
  assert.equal(level({ famous_brand: 'Леруа Мерлен' }), 'A', 'известный бренд по оценке ИИ');
  assert.equal(level({ budget: 'gt3m' }), 'A');
  assert.equal(level({ budget_rub: 5_000_000, budget: 'gt3m' }), 'A');
});

test('площадки и упоминания брендов — не A', () => {
  assert.equal(level({ company: 'ozon.ru/seller/mommy', budget: '100_300k' }), 'C', 'селлер на Ozon — не Ozon');
  assert.equal(level({ task: 'Продаём на Wildberries и в Яндекс Маркете, нужен внешний трафик' }), 'C');
  assert.equal(level({ task: 'Работаем с банками, например ВТБ, нужна реклама наших услуг' }), 'C', 'чужой бренд в рассказе');
});

test('B — бюджет от 500 000, зарубежный клиент, несколько каналов или комплекс, приоритетная сфера при хорошем бюджете', () => {
  assert.equal(level({ budget: '300k_1m', budget_rub: 600_000 }), 'B');
  assert.equal(level({ budget: '300k_1m', budget_rub: 400_000 }), 'C', '400 000 — ещё C');
  assert.equal(level({ budget: '1m_3m' }), 'B');
  assert.equal(level({ budget: 'unknown', geography: 'international' }), 'B', 'зарубежные — B');
  assert.equal(level({ services: ['context', 'seo', 'smm'], service: 'complex', budget: '300k_1m', budget_rub: 300_000 }), 'B');
  assert.equal(level({ services: ['context', 'seo'], service: 'complex', budget: '100_300k', budget_rub: 150_000 }), 'C', 'комплекс при маленьком бюджете — C');
  assert.equal(level({ industry: 'realty', budget: '300k_1m', budget_rub: 350_000 }), 'B');
  assert.equal(level({ budget_rub: 800_000, budget: '300k_1m', decision_maker: 'other', role: 'manager' }), 'C', 'признаки B, но нет ЛПР — на ступень ниже');
});

test('C — все остальные адекватные клиенты, в том числе если почти ничего не известно', () => {
  assert.equal(level({ service: 'context', budget: 'unknown' }), 'C');
  assert.equal(level({ service: 'context', budget: '100_300k', budget_rub: 150_000, agency_experience: 'none', start: 'month' }), 'C');
  assert.equal(level({ service: 'context' }), 'C');
});

test('D — не проходит по цене, важна только цена, нет доступа к ЛПР', () => {
  assert.equal(level({ budget: 'lt100k', budget_rub: 20_000, price_from: 30_000 }), 'D', 'контекст за 20 000 при цене от 30 000');
  assert.equal(level({ budget: 'lt100k', budget_rub: 50_000, criteria: 'price' }), 'D');
  assert.equal(level({ budget: '100_300k', decision_maker: 'other', role: 'manager' }), 'D');
  assert.equal(level({ budget: '100_300k', budget_rub: 200_000, criteria: 'price' }), 'C', 'цена важна, но бюджет нормальный');
});

test('E — бюджет меньше 10 000, стоп-слова, спам', () => {
  assert.equal(level({ budget: 'lt100k', budget_rub: 5_000 }), 'E');
  assert.equal(level({ task: 'Я рос среди 4х тюрем' }), 'E');
});

test('объяснение уровня — первой строкой, с буквой', () => {
  const r = scoreLead({ ...typicalAnswers, budget: '300k_1m', budget_rub: 600_000 }, rules, scenario);
  assert.match(r.reasons[0], /^B: бюджет 600 000 ₽ в месяц/);
});
