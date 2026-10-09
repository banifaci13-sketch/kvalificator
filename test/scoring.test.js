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

test('без бюджета 4–5 не ставим, даже при прочих плюсах', () => {
  const r = score({ budget: 'unknown', industry: 'finance', geography: 'international', market: 'b2b', role: 'owner', decision_maker: 'me', start: 'asap', criteria: 'results', source: 'recommendation' });
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
