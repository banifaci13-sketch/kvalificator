import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario, stepsFromCsv, stepsToCsv, parseCsv } from '../src/core/scenario.js';
import { scenario } from './helpers.js';

test('сценарий из таблицы совпадает с исходным (CSV туда и обратно)', () => {
  const steps = stepsFromCsv(stepsToCsv(scenario.steps));
  assert.deepEqual(steps, scenario.steps.map(({ id, label, type, text, required, options, when, placeholder }) => ({
    id, label, type, text, required: Boolean(required),
    ...(options ? { options } : {}), ...(when ? { when } : {}), ...(placeholder ? { placeholder } : {}),
  })));
  validateScenario({ ...scenario, steps });
});

test('CSV: кавычки, запятые и переводы строк внутри ячеек', () => {
  assert.deepEqual(parseCsv('a,"b, ""c""\nd"\r\n1,2\n'), [['a', 'b, "c"\nd'], ['1', '2']]);
});

test('ошибки в таблице понятны менеджеру', () => {
  const bad = (steps) => () => validateScenario({ ...scenario, steps });
  assert.throws(bad([{ id: 'a', type: 'choice', text: 'x' }]), /нет вариантов/);
  assert.throws(bad([{ id: 'a', type: 'radio', text: 'x' }]), /неизвестный тип/);
  assert.throws(bad([{ id: 'a', type: 'text', text: 'x', when: { b: ['1'] } }]), /которого нет выше/);
  assert.throws(bad([{ id: 'a', type: 'text', text: 'x' }]), /contact/);
});
