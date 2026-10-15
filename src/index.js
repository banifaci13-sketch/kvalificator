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
import { createMedia } from './docs/media.js';
import { createMediaplans } from './mediaplan/store.js';
import { createFiles } from './files/store.js';
import { createHotLeads } from './crm/hot-leads.js';
import { createMoney } from './crm/money.js';
import { createNotifications } from './notify/store.js';
import { createCrm } from './crm/store.js';
import { createCalendar } from './calendar/store.js';
import { createVideo } from './calendar/video.js';
import { startReminders, telegramSender } from './calendar/reminders.js';
import { createAi } from './ai/client.js';
import { closeBrowser } from './docs/browser.js';
import { createMonitor } from './ops/monitor.js';
import { createAbandoned } from './core/abandoned.js';
import { loadPricing } from './core/pricing.js';
import { createLeadSummary } from './core/lead-summary.js';
import { dirname, resolve } from 'node:path';

const RETRY_INTERVAL_MS = 5 * 60_000;
const TELEGRAM_UPDATES = ['message', 'callback_query'];

const config = loadConfig();
// монитор для «Состояния системы»: фоновые задачи и последние ошибки из журнала
const monitor = createMonitor();
const log = pino({ level: config.logLevel, hooks: { logMethod: monitor.logHook } });
monitor.useLog(log);
const db = openDb(config.dbPath);
const rules = JSON.parse(await readFile(config.scoringFile, 'utf8'));
const notifier = createNotifier(config);
const scenarioSource = await createScenarioSource({ file: config.scenarioFile, csvUrl: config.scenarioCsvUrl, log });
const ai = createAi(config.ai);
// прайс для «от … ₽» в диалоге квалификатора (если файла нет — цена не называется)
const pricing = loadPricing(resolve(config.root, 'config/pricing.json'), log);
const qualifier = createQualifier({ db, scenarioSource, rules, notifier, log, ai, aiMode: config.qualifierAi, pricing, summarizer: createLeadSummary({ ai, log }) });

if (!notifier) log.warn('Получатели лидов не настроены (TELEGRAM_* или LEAD_WEBHOOK_URL) — лиды только сохраняются в базу');

const auth = createAuth(db.raw);
bootstrapAdmin();
const calendar = createCalendar({ db: db.raw });
const crm = createCrm({ db: db.raw });
// горячая заявка — сразу задача «Связаться» за 15 минут
const hotLeads = createHotLeads({ db: db.raw, crm });
// деньги по клиентам: счета за ведение каждый месяц, напоминания о сроках оплаты
const money = createMoney({ db: db.raw, notify: createNotifications({ db: db.raw }) });
qualifier.onLead((lead) => hotLeads.onLead(lead));

const telegramBot = config.telegram.botEnabled ? await initTelegramBot() : null;
const brand = loadBrand();
const media = createMedia({ db: db.raw, dir: dirname(config.dbPath) });
const files = createFiles({ db: db.raw, dir: dirname(config.dbPath) });
const library = createDocLibrary({ db: db.raw, brand, templatesDir: resolve(config.root, 'templates/decks'), dataDir: dirname(config.dbPath), media });
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
    media,
    files,
    money,
    mediaplans: createMediaplans({ db: db.raw, library }),
    crm,
    calendar,
    video: createVideo(config),
    ai,
    monitor,
  },
});

if (telegramBot && config.telegram.webhookUrl) {
  app.post(
    new URL(config.telegram.webhookUrl).pathname,
    { config: { rateLimit: false }, bodyLimit: 1024 * 1024 },
    webhookCallback(telegramBot, 'fastify', { secretToken: config.telegram.webhookSecret ?? undefined }),
  );
}

// Фоновые задачи отмечаются в мониторе: когда работали и чем закончились (ошибка — и в журнал)
const leadsJob = monitor.job('leads', 'Досылка заявок менеджерам', RETRY_INTERVAL_MS);
const moneyJob = monitor.job('money', 'Счета за ведение и напоминания об оплате', 3600e3);
const retryTimer = setInterval(() => leadsJob(() => qualifier.retryUndelivered()), RETRY_INTERVAL_MS);
// раз в час: счета за ведение на новый месяц и напоминания об оплате
const moneyTimer = setInterval(() => moneyJob(() => money.remind()), 3600e3);
setTimeout(() => moneyJob(() => money.remind()), 30e3);
// раз в час: брошенные диалоги старше срока хранения — стираем переписку и ответы
const abandoned = createAbandoned({ db: db.raw, days: config.abandonedDays });
const purgeJob = monitor.job('purge', `Удаление брошенных диалогов старше ${config.abandonedDays} дн.`, 3600e3);
const purgeTimer = setInterval(() => purgeJob(() => abandoned.purge()), 3600e3);
setTimeout(() => purgeJob(() => abandoned.purge()), 60e3);
// раз в час: регулярные встречи — продлить серии на полгода вперёд
const seriesJob = monitor.job('meetings', 'Регулярные встречи: продление на полгода вперёд', 3600e3);
const seriesTimer = setInterval(() => seriesJob(() => calendar.extendSeries()), 3600e3);
setTimeout(() => seriesJob(() => calendar.extendSeries()), 90e3);
// Напоминания о встречах и утренний план — в личный Telegram сотрудников (нужен токен бота)
const reminders = config.telegram.token
  ? startReminders({ calendar, crm, send: telegramSender({ token: config.telegram.token }), log, publicUrl: config.publicUrl, track: monitor.job('reminders', 'Напоминания о встречах и план дня в Telegram', 60_000) })
  : null;

await app.listen({ port: config.port, host: config.host });
if (telegramBot) await startTelegramBot(telegramBot);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    clearInterval(retryTimer);
    clearInterval(moneyTimer);
    clearInterval(purgeTimer);
    clearInterval(seriesTimer);
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
