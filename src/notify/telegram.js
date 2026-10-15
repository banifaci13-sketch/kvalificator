// Карточка нового лида в Telegram-чат менеджеров (через Bot API).

import { ratingLetter } from '../core/scoring.js';
import { POTENTIAL } from '../core/lead-summary.js';

const STARS = ['', '★☆☆☆☆', '★★☆☆☆', '★★★☆☆', '★★★★☆', '★★★★★'];
const CHANNELS = { web: 'виджет на сайте', telegram: 'Telegram', max: 'MAX' };
// Лимит Telegram — 4096 символов; длинные ответы режем по отдельности, чтобы не сломать HTML-разметку
const ANSWER_LIMIT = 400;

/** withTakeButton — под карточкой кнопка «Взять в работу» (обрабатывает Telegram-бот). */
export function createTelegramNotifier({ token, chatId, withTakeButton = false, apiBase = 'https://api.telegram.org' }) {
  return {
    async notifyLead(lead, scenario) {
      const res = await fetch(`${apiBase}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatLeadCard(lead, scenario),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(withTakeButton
            ? { reply_markup: { inline_keyboard: [[{ text: '🙋 Взять в работу', callback_data: `take:${lead.id}` }]] } }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        throw new Error(`Telegram API: ${res.status} ${body.description ?? ''}`.trim());
      }
    },
  };
}

export function formatLeadCard(lead, scenario) {
  const head = [
    `<b>${STARS[lead.rating]} Лид #${lead.id} — уровень ${ratingLetter(lead.rating)}</b>`,
    lead.tags.length ? lead.tags.map((t) => `#${t.replace(/[^\p{L}\p{N}]+/gu, '_')}`).join(' ') : null,
    '',
  ];

  // сводка ИИ — первой: кто клиент, потенциал, что предложить
  const ai = lead.ai_summary;
  const summary = ai
    ? [
        `🤖 <b>Сводка ИИ</b> · потенциал: <b>${esc(POTENTIAL[ai.potential] ?? ai.potential)}</b>`,
        ai.about ? esc(ai.about) : null,
        ai.why ? `<i>${esc(ai.why)}</i>` : null,
        ai.comment ? `💬 ${esc(ai.comment)}` : null,
        '',
      ].filter((l) => l !== null)
    : [];

  const rows = [...summary];
  for (const step of scenario.steps) {
    if (step.type === 'consent' || !(step.id in lead.answers)) continue;
    rows.push(`<b>${esc(step.label ?? step.id)}:</b> ${esc(formatAnswer(step, lead.answers[step.id]))}`);
  }
  // Ответы, которых нет в сценарии: из диалога с ИИ (суть задачи, уточнение, список услуг) и устаревшие
  const known = new Set(scenario.steps.map((s) => s.id));
  const serviceStep = scenario.steps.find((s) => s.id === 'service');
  for (const [id, value] of Object.entries(lead.answers)) {
    if (known.has(id)) continue;
    const label = EXTRA[id] ?? id;
    const text = id === 'services' && Array.isArray(value) ? value.map((v) => serviceStep?.options?.find((o) => o.value === v)?.label ?? v).join(', ') : formatAnswer({}, value);
    rows.push(`<b>${esc(label)}:</b> ${esc(text)}`);
  }
  if (lead.meta?.dialog?.length) rows.push(`<i>Диалог с клиентом — ${lead.meta.dialog.length} сообщений, целиком в карточке заявки в кабинете</i>`);

  const meta = lead.meta ?? {};
  const tg = meta.telegram;
  const source = [
    `Канал: ${CHANNELS[lead.channel] ?? lead.channel}`,
    tg ? `Telegram: ${tg.username ? `@${tg.username}` : tg.name} (id ${tg.id})` : null,
    meta.page ? `Страница: ${meta.page}` : null,
    meta.referrer ? `Реферер: ${meta.referrer}` : null,
    meta.utm && Object.keys(meta.utm).length
      ? `UTM: ${Object.entries(meta.utm).map(([k, v]) => `${k}=${v}`).join(', ')}`
      : null,
  ].filter(Boolean);

  const tail = [
    '',
    `<b>Почему ${ratingLetter(lead.rating)}:</b> ${esc(lead.reasons.join('; ') || 'нет сигналов')} (баллы: ${lead.score})`,
    '',
    ...source.map(esc),
  ];

  return [...head.filter((l) => l !== null), ...rows, ...tail].join('\n');
}

function formatAnswer(step, value) {
  const text =
    value && typeof value === 'object'
      ? value.raw ?? JSON.stringify(value)
      : step.options?.find((o) => o.value === value)?.label ?? String(value);
  return text.length > ANSWER_LIMIT ? text.slice(0, ANSWER_LIMIT) + '…' : text;
}

// подписи ответов диалога с ИИ, которых нет среди вопросов сценария
const EXTRA = { proposal_request: 'Ждёт от нас', services: 'Услуги', summary: 'Суть задачи', clarification: 'Уточнение клиента', criteria_text: 'Главное в выборе (своими словами)', price: 'Предварительная стоимость (названа клиенту)' };

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
