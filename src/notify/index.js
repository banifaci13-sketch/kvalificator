import { createTelegramNotifier } from './telegram.js';
import { createWebhookNotifier } from './webhook.js';
import { createEmailNotifier } from './email.js';

/**
 * Все настроенные получатели. Каждый получатель отмечается отдельно, чтобы при сбое
 * одного (например, CRM) повторная отправка не дублировала карточку в Telegram.
 */
export function createNotifier(config) {
  const targets = {};
  if (config.telegram.token && config.telegram.managerChatId) {
    targets.telegram = createTelegramNotifier({
      token: config.telegram.token,
      chatId: config.telegram.managerChatId,
      withTakeButton: config.telegram.botEnabled,
    });
  }
  if (config.webhook.url) targets.webhook = createWebhookNotifier(config.webhook);
  // почта: каждый новый лид (и, отдельно, брошенные диалоги — см. email.notifyAbandoned)
  const email = config.mail?.smtp?.host && config.mail.to.length ? createEmailNotifier({ smtp: config.mail.smtp, to: config.mail.to, publicUrl: config.publicUrl }) : null;
  if (email) targets.email = email;
  // Тестовые лиды — только в тестовый чат (если он задан), не менеджерам и не в CRM
  const testTargets = {};
  if (config.telegram.token && config.telegram.testChatId) {
    testTargets.telegramTest = createTelegramNotifier({ token: config.telegram.token, chatId: config.telegram.testChatId });
  }
  if (!Object.keys(targets).length && !Object.keys(testTargets).length) return null;

  return {
    targets: Object.keys(targets),
    email,
    /** @returns {Promise<{delivered: string[], errors: Error[]}>} */
    async notifyLead(lead, scenario, alreadyDelivered = []) {
      const pending = Object.entries(lead.is_test ? testTargets : targets).filter(
        ([name]) => !alreadyDelivered.includes(name),
      );
      const results = await Promise.allSettled(pending.map(([, t]) => t.notifyLead(lead, scenario)));
      const delivered = [...alreadyDelivered];
      const errors = [];
      results.forEach((r, i) => (r.status === 'fulfilled' ? delivered.push(pending[i][0]) : errors.push(r.reason)));
      return { delivered, errors };
    },
  };
}
