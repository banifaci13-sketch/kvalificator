// Выгружает вопросы из config/scenario.json в CSV — шаблон для Google Таблицы.
// Запуск: npm run scenario:csv
import { loadScenarioFile, stepsToCsv } from '../src/core/scenario.js';

const scenario = await loadScenarioFile(new URL('../config/scenario.json', import.meta.url));
process.stdout.write(stepsToCsv(scenario.steps));
