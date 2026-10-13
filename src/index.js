import { readFile } from 'node:fs/promises';
import pino from 'pino';
import { webhookCallback } from 'grammy';
import { loadConfig } from './config.js';
import { openDb } from './storage/db.js';
import { createScenarioSource } from './core/scenario.js';
import { createQualifier } from './core/qualifier.js';
import { createNotifier } from './notify/index.js';
import { buildServer } from './http/server.js';
import { createTelegramBot, setupTelegramCommands } from './channels/telegram.js';
import { createAuth } from './admin/auth.js';
import { createReports } from './admin/reports.js';
import { loadBrand } from './brand/index.js';
import { createDocLibrary } from './docs/library.js';
import { createMediaplans } from './mediaplan/store.js';
import { createCrm } from './crm/store.js';
import { createCalendar } from './calendar/store.js';
import { createVideo } from './calendar/video.js';
import { startReminders, telegramSender } from './calendar/reminders.js';
import { createAi } from './ai/client.js';
import { closeBrowser } from './docs/browser.js';
import { dirname, resolve } from 'node:path';

const RETRY_INTERVAL_MS = 5 * 60_000;
const TELEGRAM_UPDATES = ['message', 'callback_query'];

const config = loadConfig();
const log = pino({ level: config.logLevel });
const db = openDb(config.dbPath);
const rules = JSON.parse(await readFile(config.scoringFile, 'utf8'));
const notifier = createNotifier(config);
const scenarioSource = await createScenarioSource({ file: config.scenarioFile, csvUrl: config.scenarioCsvUrl, log });
const qualifier = createQualifier({ db, scenarioSource, rules, notifier, log });

if (!notifier) log.warn('Получатели лидов не настроены (TELEGRAM_* или LEAD_WEBHOOK_URL) — лиды только сохраняются в базу');

const auth = createAuth(db.raw);
bootstrapAdmin();
const calendar = createCalendar({ db: db.raw });
const crm = createCrm({ db: db.raw });

const telegramBot = config.telegram.botEnabled ? await initTelegramBot() : null;
const brand = loadBrand();
const library = createDocLibrary({ db: db.raw, brand, templatesDir: resolve(config.root, 'templates/decks'), dataDir: dirname(config.dbPath) });
for (const p of brand.logo.problems) log.warn(`Логотип: ${p}`);
const app = await buildServer({
  config,
  qualifier,
  brand,
  logger: log,
  admin: {
    auth,
    reports: createReports(db.raw),
    db,
    scenarioSource,
    brand,
    library,
    mediaplans: createMediaplans({ db: db.raw, library }),
    crm,
    calendar,
    video: createVideo(config),
    ai: createAi(config.ai),
  },
});

if (telegramBot && config.telegram.webhookUrl) {
  app.post(
    new URL(config.telegram.webhookUrl).pathname,
    { config: { rateLimit: false }, bodyLimit: 1024 * 1024 },
    webhookCallback(telegramBot, 'fastify', { secretToken: config.telegram.webhookSecret ?? undefined }),
  );
}

const retryTimer = setInterval(() => qualifier.retryUndelivered().catch((err) => log.error({ err })), RETRY_INTERVAL_MS);
// Напоминания о встречах и утренний план — в личный Telegram сотрудников (нужен токен бота)
const reminders = config.telegram.token
  ? startReminders({ calendar, crm, send: telegramSender({ token: config.telegram.token }), log, publicUrl: config.publicUrl })
  : null;

await app.listen({ port: config.port, host: config.host });
if (telegramBot) await startTelegramBot(telegramBot);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    clearInterval(retryTimer);
    reminders?.stop();
    scenarioSource.stop();
    if (telegramBot?.isRunning()) await telegramBot.stop();
    await closeBrowser();
    await app.close();
    db.close();
    process.exit(0);
  });
}

/** Первый администратор из ADMIN_EMAIL / ADMIN_PASSWORD — только если в базе ещё никого нет. */
function bootstrapAdmin() {
  if (auth.hasUsers()) return;
  const { bootstrapEmail: email, bootstrapPassword: password } = config.admin;
  if (!email) {
    log.warn('В админке нет сотрудников: выполните npm run admin -- add <логин> <имя> --admin');
    return;
  }
  auth.addUser(email, email, { password: password || null, role: 'admin' });
  log.info({ login: email }, 'Создан первый администратор админки');
}

async function initTelegramBot() {
  const bot = createTelegramBot({
    token: config.telegram.token,
    managerChatId: config.telegram.managerChatId,
    privacyPolicyUrl: config.privacyPolicyUrl,
    qualifier,
    log,
    staffLink: (code, chatId) => calendar.linkTelegram(code, chatId),
  });
  try {
    // Без ответа Telegram сайт должен работать: ждём не дольше 15 секунд
    await Promise.race([
      bot.init(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram не ответил за 15 секунд')), 15_000).unref()),
    ]);
  } catch (err) {
    log.error({ err }, 'Telegram-бот не запущен: не удалось подключиться к Telegram (проверьте токен и сеть)');
    return null;
  }
  // Ссылка «Продолжить в Telegram» в виджете — по имени бота, если оно не задано вручную
  config.telegram.botUsername ??= bot.botInfo.username;
  return bot;
}

async function startTelegramBot(bot) {
  await setupTelegramCommands(bot).catch((err) => log.warn({ err }, 'Не удалось установить команды бота'));
  if (config.telegram.webhookUrl) {
    await bot.api.setWebhook(config.telegram.webhookUrl, {
      secret_token: config.telegram.webhookSecret ?? undefined,
      allowed_updates: TELEGRAM_UPDATES,
    });
    log.info({ bot: bot.botInfo.username }, 'Telegram-бот запущен (webhook)');
    return;
  }
  // Long polling: start() работает до остановки, поэтому не ждём его
  bot
    .start({
      allowed_updates: TELEGRAM_UPDATES,
      onStart: (info) => log.info({ bot: info.username }, 'Telegram-бот запущен (long polling)'),
    })
    .catch((err) => log.error({ err }, 'Telegram-бот остановился'));
}
