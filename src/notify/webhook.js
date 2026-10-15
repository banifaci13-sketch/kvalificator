// Отправка лида JSON-ом на произвольный URL: amoCRM/Bitrix24 через их входящие вебхуки,
// Make/n8n, Google Apps Script и т.п.

import { createHmac } from 'node:crypto';
import { ratingLetter } from '../core/scoring.js';
import { summaryText } from '../core/lead-summary.js';

export function createWebhookNotifier({ url, secret }) {
  return {
    async notifyLead(lead) {
      // level — уровень квалификации буквой (A — лучший); в lead.meta.dialog — диалог целиком, если он был с ИИ;
      // ai_summary — сводка ИИ (about, potential, why, comment), ai_summary_text — она же одним текстом для поля CRM
      const body = JSON.stringify({ event: 'lead.created', lead: { ...lead, level: ratingLetter(lead.rating), ai_summary_text: summaryText(lead.ai_summary) || null } });
      const headers = { 'content-type': 'application/json' };
      if (secret) headers['x-signature'] = createHmac('sha256', secret).update(body).digest('hex');
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Webhook: HTTP ${res.status}`);
    },
  };
}
