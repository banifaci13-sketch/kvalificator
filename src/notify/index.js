import { createTelegramNotifier } from './telegram.js';
import { createWebhookNotifier } from './webhook.js';

/**
 * Все настроенные получатели. Каждый получатель отмечается отдельно, чтобы при сбое
 * одного (например, CRM) повторная отправка не дублировала карточку в Telegram.
 */
export function createNotifier(config) {
  const targets = {};
  if (config.telegram.token && config.telegram.managerChatId) {
    targets.telegram = createTelegramNotifier({ token: config.telegram.token, chatId: config.telegram.managerChatId });
  }
  if (config.webhook.url) targets.webhook = createWebhookNotifier(config.webhook);
  if (!Object.keys(targets).length) return null;

  return {
    targets: Object.keys(targets),
    /** @returns {Promise<{delivered: string[], errors: Error[]}>} */
    async notifyLead(lead, scenario, alreadyDelivered = []) {
      const pending = Object.entries(targets).filter(([name]) => !alreadyDelivered.includes(name));
      const results = await Promise.allSettled(pending.map(([, t]) => t.notifyLead(lead, scenario)));
      const delivered = [...alreadyDelivered];
      const errors = [];
      results.forEach((r, i) => (r.status === 'fulfilled' ? delivered.push(pending[i][0]) : errors.push(r.reason)));
      return { delivered, errors };
    },
  };
}
