// Проверка настроек перед запуском: npm run check
// С флагом --send-test отправляет тестовую карточку лида в чат менеджеров.

import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { loadScenarioFile, stepsFromCsv, validateScenario } from '../src/core/scenario.js';
import { formatLeadCard } from '../src/notify/telegram.js';

const config = loadConfig();
const sendTest = process.argv.includes('--send-test');
let failed = 0;

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (msg) => { failed++; console.log(`  ✗ ${msg}`); };

async function step(title, fn) {
  console.log(title);
  try {
    await fn();
  } catch (err) {
    fail(err.message);
  }
}

let scenario;
await step('Сценарий вопросов', async () => {
  scenario = await loadScenarioFile(config.scenarioFile);
  ok(`${config.scenarioFile}: ${scenario.steps.length} вопросов`);
  if (config.scenarioCsvUrl) {
    const res = await fetch(config.scenarioCsvUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Google Таблица недоступна: HTTP ${res.status}`);
    scenario = validateScenario({ ...scenario, steps: stepsFromCsv(await res.text()) });
    ok(`Google Таблица: ${scenario.steps.length} вопросов, ошибок нет`);
  }
  const empty = Object.entries(scenario.budgetHints ?? {}).filter(([k, v]) => !k.startsWith('_') && !v);
  if (empty.length) warn(`не заполнены ориентиры по бюджету: ${empty.map(([k]) => k).join(', ')}`);
});

await step('Правила оценки', async () => {
  const rules = JSON.parse(await readFile(config.scoringFile, 'utf8'));
  const ids = new Set(scenario?.steps.map((s) => s.id));
  for (const [field, table] of Object.entries(rules.points)) {
    const step = scenario?.steps.find((s) => s.id === field);
    if (!ids.has(field)) { warn(`баллы для «${field}», но такого вопроса нет в сценарии`); continue; }
    const values = new Set(step.options?.map((o) => o.value));
    const unknown = Object.keys(table).filter((v) => !values.has(v));
    if (unknown.length) fail(`«${field}»: баллы для несуществующих вариантов ${unknown.join(', ')}`);
  }
  ok(`${config.scoringFile}: ${rules.starBrands.length} звёздных брендов, ${rules.stopWords.length} стоп-слов`);
});

await step('Сервер', async () => {
  if (!config.allowedOrigins.length) warn('ALLOWED_ORIGINS пуст — виджет можно подключить с любого сайта (только для разработки)');
  else ok(`виджет разрешён на: ${config.allowedOrigins.join(', ')}`);
  if (!config.privacyPolicyUrl) warn('PRIVACY_POLICY_URL не задан — в шаге согласия не будет ссылки на политику');
  else ok(`политика ПДн: ${config.privacyPolicyUrl}`);
});

await step('Telegram', async () => {
  const { token, managerChatId } = config.telegram;
  if (!token) return warn('TELEGRAM_BOT_TOKEN не задан — бот и уведомления в Telegram выключены');
  const api = async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`${method}: ${data.description}`);
    return data.result;
  };
  const me = await api('getMe');
  ok(`бот @${me.username}`);
  if (!managerChatId) return warn('TELEGRAM_MANAGER_CHAT_ID не задан — карточки лидов не будут приходить менеджерам');
  const chat = await api('getChat', { chat_id: managerChatId });
  ok(`чат менеджеров: ${chat.title ?? chat.first_name ?? chat.id}`);
  if (sendTest && scenario) {
    const lead = {
      id: 0, rating: 4, score: 6, channel: 'web', tags: ['тест'], reasons: ['тестовая карточка'],
      answers: { service: 'context', task: 'Проверка уведомлений', company: 'Тест', name: 'Тест', contact: { raw: '+7 900 000-00-00' } },
      meta: { page: 'npm run check' },
    };
    await api('sendMessage', { chat_id: managerChatId, text: formatLeadCard(lead, scenario), parse_mode: 'HTML' });
    ok('тестовая карточка отправлена в чат менеджеров');
  } else {
    console.log('    (чтобы отправить тестовую карточку: npm run check -- --send-test)');
  }
});

await step('CRM-вебхук', async () => {
  if (!config.webhook.url) return warn('LEAD_WEBHOOK_URL не задан — лиды в CRM не отправляются');
  ok(`лиды уходят на ${new URL(config.webhook.url).host}`);
});

console.log(failed ? `\nОшибок: ${failed}` : '\nВсё в порядке');
process.exit(failed ? 1 : 0);
