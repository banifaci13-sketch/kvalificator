// Отправка лида JSON-ом на произвольный URL: amoCRM/Bitrix24 через их входящие вебхуки,
// Make/n8n, Google Apps Script и т.п.

import { createHmac } from 'node:crypto';

export function createWebhookNotifier({ url, secret }) {
  return {
    async notifyLead(lead) {
      const body = JSON.stringify({ event: 'lead.created', lead });
      const headers = { 'content-type': 'application/json' };
      if (secret) headers['x-signature'] = createHmac('sha256', secret).update(body).digest('hex');
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Webhook: HTTP ${res.status}`);
    },
  };
}
