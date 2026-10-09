import { readFileSync } from 'node:fs';
import { validateScenario } from '../src/core/scenario.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

export const scenario = validateScenario(read('../config/scenario.json'));
export const rules = read('../config/scoring.json');
export const staticSource = (s = scenario) => ({ get: () => s, stop() {} });
export const silentLog = { info() {}, warn() {}, error() {} };

/** Ответы «по умолчанию» на все обязательные вопросы — для сквозных тестов. */
export const typicalAnswers = {
  service: 'context',
  task: 'Нужно больше заявок на ипотеку из Москвы',
  company: 'ООО Ромашка, romashka.ru',
  industry: 'other',
  role: 'marketer',
  decision_maker: 'with_me',
  participants: 'Коммерческий директор',
  start: 'quarter',
  budget: '100_300k',
  agency_experience: 'none',
  criteria: 'expertise',
  name: 'Анна',
  consent: 'yes',
  contact: '+7 999 123-45-67',
};
