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
    },
    max: {
      botUsername: env.MAX_BOT_USERNAME || null,
    },
    webhook: {
      url: env.LEAD_WEBHOOK_URL || null,
      secret: env.LEAD_WEBHOOK_SECRET || null,
    },
    logLevel: env.LOG_LEVEL || 'info',
  };
}
