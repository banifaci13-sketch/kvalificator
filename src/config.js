import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function loadConfig(env = process.env) {
  if (env === process.env && existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

  const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const path = (v, fallback) => resolve(root, v || fallback);

  return {
    root,
    // Адрес сервера снаружи, например https://kval.soroka-marketing.ru — для входа через Яндекс и ссылок
    publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, '') || null,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    trustProxy: env.TRUST_PROXY === 'true',
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    dbPath: env.DB_PATH === ':memory:' ? ':memory:' : path(env.DB_PATH, 'data/kvalificator.db'),
    scenarioFile: path(env.SCENARIO_FILE, 'config/scenario.json'),
    scenarioCsvUrl: env.SCENARIO_CSV_URL || null,
    scoringFile: path(env.SCORING_FILE, 'config/scoring.json'),
    privacyPolicyUrl: env.PRIVACY_POLICY_URL || null,
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN || null,
      managerChatId: env.TELEGRAM_MANAGER_CHAT_ID || null,
      botUsername: env.TELEGRAM_BOT_USERNAME || null,
      // Бот-собеседник для клиентов; выключите, если токен нужен только для уведомлений
      botEnabled: Boolean(env.TELEGRAM_BOT_TOKEN) && env.TELEGRAM_BOT_ENABLED !== 'false',
      // Пусто — long polling (проще, работает на любом сервере); иначе webhook на этот адрес
      webhookUrl: env.TELEGRAM_WEBHOOK_URL || null,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || null,
      // Чат для тестовых лидов; если не задан — тестовые лиды никуда не отправляются
      testChatId: env.TELEGRAM_TEST_CHAT_ID || null,
    },
    max: {
      botUsername: env.MAX_BOT_USERNAME || null,
    },
    webhook: {
      url: env.LEAD_WEBHOOK_URL || null,
      secret: env.LEAD_WEBHOOK_SECRET || null,
    },
    admin: {
      yandexClientId: env.YANDEX_CLIENT_ID || null,
      yandexClientSecret: env.YANDEX_CLIENT_SECRET || null,
      // Сотрудники с почтой на этих доменах входят через Яндекс без предварительного добавления
      allowedDomains: list(env.ADMIN_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
      // Первый сотрудник создаётся при запуске, если в базе ещё никого нет
      bootstrapEmail: env.ADMIN_EMAIL || null,
      bootstrapPassword: env.ADMIN_PASSWORD || null,
    },
    // Видеовстречи: Zoom — приложение Server-to-Server OAuth; Телемост — OAuth-токен (Яндекс 360 для бизнеса)
    zoom: {
      accountId: env.ZOOM_ACCOUNT_ID || null,
      clientId: env.ZOOM_CLIENT_ID || null,
      clientSecret: env.ZOOM_CLIENT_SECRET || null,
      // e-mail пользователя Zoom, от имени которого создаются встречи
      user: env.ZOOM_USER || 'me',
    },
    telemost: {
      token: env.TELEMOST_TOKEN || null,
      // PUBLIC — без комнаты ожидания; ORGANIZATION — гости ждут, сотрудники входят сразу
      waitingRoom: env.TELEMOST_WAITING_ROOM || 'PUBLIC',
    },
    // ИИ-помощник: YandexGPT (данные остаются в России) или Claude
    ai: {
      provider: env.AI_PROVIDER || (env.YANDEX_GPT_API_KEY ? 'yandexgpt' : env.ANTHROPIC_API_KEY ? 'anthropic' : null),
      yandexApiKey: env.YANDEX_GPT_API_KEY || null,
      yandexFolderId: env.YANDEX_GPT_FOLDER_ID || null,
      yandexModel: env.YANDEX_GPT_MODEL || 'yandexgpt/latest',
      anthropicApiKey: env.ANTHROPIC_API_KEY || null,
      anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    },
    logLevel: env.LOG_LEVEL || 'info',
  };
}
