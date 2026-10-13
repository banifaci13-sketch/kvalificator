// Карточка нового лида в Telegram-чат менеджеров (через Bot API).

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
    `<b>${STARS[lead.rating]} Лид #${lead.id} — рейтинг ${lead.rating}</b>`,
    lead.tags.length ? lead.tags.map((t) => `#${t.replace(/[^\p{L}\p{N}]+/gu, '_')}`).join(' ') : null,
    '',
  ];

  const rows = [];
  for (const step of scenario.steps) {
    if (step.type === 'consent' || !(step.id in lead.answers)) continue;
    rows.push(`<b>${esc(step.label ?? step.id)}:</b> ${esc(formatAnswer(step, lead.answers[step.id]))}`);
  }
  // Ответы на вопросы, которых уже нет в сценарии, не теряем
  const known = new Set(scenario.steps.map((s) => s.id));
  for (const [id, value] of Object.entries(lead.answers)) {
    if (!known.has(id)) rows.push(`<b>${esc(id)}:</b> ${esc(formatAnswer({}, value))}`);
  }

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
    `<b>Почему ${lead.rating}:</b> ${esc(lead.reasons.join('; ') || 'нет сигналов')} (баллы: ${lead.score})`,
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

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
