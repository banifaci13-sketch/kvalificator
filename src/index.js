import { readFile } from 'node:fs/promises';
import pino from 'pino';
import { loadConfig } from './config.js';
import { openDb } from './storage/db.js';
import { createScenarioSource } from './core/scenario.js';
import { createQualifier } from './core/qualifier.js';
import { createNotifier } from './notify/index.js';
import { buildServer } from './http/server.js';

const RETRY_INTERVAL_MS = 5 * 60_000;

const config = loadConfig();
const log = pino({ level: config.logLevel });
const db = openDb(config.dbPath);
const rules = JSON.parse(await readFile(config.scoringFile, 'utf8'));
const notifier = createNotifier(config);
const scenarioSource = await createScenarioSource({ file: config.scenarioFile, csvUrl: config.scenarioCsvUrl, log });
const qualifier = createQualifier({ db, scenarioSource, rules, notifier, log });

if (!notifier) log.warn('Получатели лидов не настроены (TELEGRAM_* или LEAD_WEBHOOK_URL) — лиды только сохраняются в базу');

const app = await buildServer({ config, qualifier, logger: log });
const retryTimer = setInterval(() => qualifier.retryUndelivered().catch((err) => log.error({ err })), RETRY_INTERVAL_MS);

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    clearInterval(retryTimer);
    scenarioSource.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
