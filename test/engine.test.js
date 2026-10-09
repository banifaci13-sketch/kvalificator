import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, AnswerError, normalizeContact } from '../src/core/engine.js';
import { scenario } from './helpers.js';

const engine = createEngine(scenario);

test('начинает с первого вопроса и считает прогресс', () => {
  const { state, reply } = engine.start();
  assert.equal(reply.type, 'question');
  assert.equal(reply.step.id, 'service');
  assert.equal(state.stepId, 'service');
  assert.equal(reply.progress.index, 1);
});

test('принимает вариант по value, подписи и номеру', () => {
  for (const value of ['seo', 'SEO-продвижение', '3']) {
    const { state } = engine.answer(engine.start().state, { value });
    assert.equal(state.answers.service, 'seo');
  }
});

test('неизвестный вариант — ошибка, состояние не меняется', () => {
  const { state } = engine.start();
  assert.throws(() => engine.answer(state, { value: 'кофе' }), AnswerError);
  assert.equal(state.stepId, 'service');
});

test('обязательный вопрос нельзя пропустить, необязательный — можно', () => {
  let { state } = engine.start();
  assert.throws(() => engine.answer(state, { skip: true }), /обязательный/);
  ({ state } = engine.answer(state, { value: 'seo' }));
  ({ state } = engine.answer(state, { value: 'Нужен рост трафика' }));
  assert.equal(state.stepId, 'reason');
  ({ state } = engine.answer(state, { skip: true }));
  assert.deepEqual(state.skipped, ['reason']);
  assert.equal(state.stepId, 'company');
});

test('ответ на старый вопрос отклоняется', () => {
  const { state } = engine.start();
  assert.throws(() => engine.answer(state, { stepId: 'budget', value: 'gt3m' }), /уже пройден/);
});

test('условные вопросы: участники — только если решает не сам', () => {
  const before = { service: 'seo', task: 'Рост трафика', company: 'Ромашка', industry: 'other', role: 'marketer' };
  const walk = (dm) => {
    let state = { stepId: 'decision_maker', answers: { ...before }, skipped: ['reason', 'market', 'geography'] };
    ({ state } = engine.answer(state, { value: dm }));
    return state.stepId;
  };
  assert.equal(walk('me'), 'start');
  assert.equal(walk('other'), 'participants');
});

test('если текущий вопрос убрали из сценария — переходит к следующему', () => {
  const state = { stepId: 'removed', answers: {}, skipped: [] };
  assert.equal(engine.current(state).step.id, 'service');
});

test('нормализация контактов', () => {
  assert.equal(normalizeContact('8 (999) 123-45-67').phone, '+79991234567');
  assert.equal(normalizeContact('9991234567').phone, '+79991234567');
  assert.equal(normalizeContact('Anna@Mail.RU').email, 'anna@mail.ru');
  assert.equal(normalizeContact('@anna_smm').telegram, '@anna_smm');
  assert.equal(normalizeContact({ phone: '79991234567', name: 'Анна' }).phone, '+79991234567');
  assert.throws(() => normalizeContact('позвоните мне'), AnswerError);
});
