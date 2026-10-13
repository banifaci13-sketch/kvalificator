// API раздела «Календарь»: встречи, ссылки Zoom/Телемост, Telegram для напоминаний, подписка на календарь.
// Подключается внутри авторизованной части админки (req.user уже есть).

import { CalendarError, FORMATS, PROVIDERS, REMIND_OPTIONS, fromDbTime } from '../calendar/store.js';
import { VideoError } from '../calendar/video.js';

const idParams = { type: 'object', properties: { id: { type: 'integer' } } };
const nullableId = { type: ['integer', 'null'] };
const nullableText = (max) => ({ type: ['string', 'null'], maxLength: max });
const meetingBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 200 },
    startsAt: { type: 'string', maxLength: 40 },
    duration: { type: 'integer', minimum: 5, maximum: 720 },
    format: { type: 'string', enum: Object.keys(FORMATS) },
    provider: { type: ['string', 'null'], enum: [...Object.keys(PROVIDERS), null] },
    link: nullableText(1000),
    hostLink: nullableText(2000),
    externalId: nullableText(200),
    place: nullableText(300),
    clientId: nullableId,
    leadId: nullableId,
    guests: nullableText(1000),
    agenda: nullableText(5000),
    remind: { type: 'array', maxItems: 6, items: { type: 'integer' } },
    participants: { type: 'array', maxItems: 50, items: { type: 'integer' } },
    cancelled: { type: 'boolean' },
  },
};

export async function calendarRoutes(api, { calendar, video, config, notify = null }) {
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof CalendarError) return reply.code(400).send({ error: err.message });
    if (err instanceof VideoError) {
      req.log.warn({ err: err.message }, 'Видеосвязь');
      return reply.code(502).send({ error: err.message });
    }
    throw err;
  });

  const icsUrl = (token) => `${config.publicUrl ?? ''}/calendar/${token}.ics`;

  api.get('/admin/api/calendar/settings', async (req) => {
    const me = calendar.staffInfo(req.user.id);
    return {
      formats: FORMATS,
      providers: PROVIDERS,
      remindOptions: REMIND_OPTIONS,
      video: video.available,
      telegram: { linked: Boolean(me?.telegram_chat_id), bot: config.telegram.botUsername ?? null, enabled: config.telegram.botEnabled },
      ics: me?.calendar_token ? icsUrl(me.calendar_token) : null,
    };
  });

  api.get(
    '/admin/api/calendar',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to'],
          properties: { from: { type: 'string', maxLength: 40 }, to: { type: 'string', maxLength: 40 }, mine: { type: 'boolean' }, client: { type: 'integer' } },
        },
      },
    },
    async (req) => {
      const from = new Date(req.query.from);
      const to = new Date(req.query.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new CalendarError('Неверный период');
      if (to - from > 100 * 24 * 3600_000) throw new CalendarError('Период — не больше 100 дней');
      return { meetings: calendar.list({ from, to, userId: req.query.mine ? req.user.id : null, clientId: req.query.client }).map(publicMeeting) };
    },
  );

  api.post('/admin/api/meetings', { schema: { body: { ...meetingBody, required: ['title', 'startsAt'] } } }, async (req) => {
    const m = calendar.create(req.body, req.user);
    // участникам — уведомление в кабинете
    const when = new Date(`${m.starts_at.replace(' ', 'T')}Z`).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    for (const p of m.participants ?? []) {
      notify?.add(p.id, { kind: 'meeting', text: `Вас пригласили на встречу «${m.title}» — ${when}`, href: `#/calendar?meeting=${m.id}`, actor: req.user.name, actorId: req.user.id });
    }
    return { meeting: publicMeeting(m) };
  });

  api.get('/admin/api/meetings/:id', { schema: { params: idParams } }, async (req) => ({ meeting: publicMeeting(calendar.get(req.params.id)) }));

  api.put('/admin/api/meetings/:id', { schema: { params: idParams, body: meetingBody } }, async (req) => ({
    meeting: publicMeeting(calendar.update(req.params.id, req.body)),
  }));

  api.delete('/admin/api/meetings/:id', { schema: { params: idParams } }, async (req, reply) => {
    const m = calendar.get(req.params.id);
    if (req.user.role !== 'admin' && m.created_by_id !== req.user.id) {
      return reply.code(403).send({ error: 'Удалить встречу может её автор или администратор — остальные могут отменить' });
    }
    calendar.remove(m.id);
    return { ok: true };
  });

  // Ссылка на видеовстречу — до сохранения встречи (заполняет поле формы)
  api.post(
    '/admin/api/video',
    {
      schema: {
        body: {
          type: 'object',
          required: ['provider', 'title', 'startsAt'],
          additionalProperties: false,
          properties: {
            provider: { type: 'string', enum: ['zoom', 'telemost'] },
            title: { type: 'string', maxLength: 200 },
            startsAt: { type: 'string', maxLength: 40 },
            duration: { type: 'integer', minimum: 5, maximum: 720 },
            agenda: nullableText(5000),
          },
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const start = new Date(req.body.startsAt);
      if (Number.isNaN(start.getTime())) throw new CalendarError('Неверная дата или время');
      const res = await video.create(req.body.provider, { title: req.body.title || 'Встреча', start, duration: req.body.duration ?? 60, agenda: req.body.agenda });
      req.log.info({ provider: res.provider, by: req.user.login }, 'Создана видеовстреча');
      return res;
    },
  );

  // ---------- Telegram и подписка сотрудника ----------

  api.post('/admin/api/me/telegram-link', async (req, reply) => {
    if (!config.telegram.botEnabled || !config.telegram.botUsername) {
      return reply.code(409).send({ error: 'Telegram-бот не запущен на сервере: нужен TELEGRAM_BOT_TOKEN' });
    }
    const code = calendar.telegramLinkCode(req.user.id);
    return { url: `https://t.me/${config.telegram.botUsername}?start=staff_${code}` };
  });

  api.delete('/admin/api/me/telegram', async (req) => {
    calendar.unlinkTelegram(req.user.id);
    return { ok: true };
  });

  api.post(
    '/admin/api/me/calendar-token',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { regenerate: { type: 'boolean' } } } } },
    async (req) => ({ url: icsUrl(calendar.calendarToken(req.user.id, { regenerate: Boolean(req.body?.regenerate) })) }),
  );
}

/** Время начала дополнительно в ISO — браузер переводит его в московское без разбора строк. */
function publicMeeting(m) {
  return { ...m, starts_at_iso: fromDbTime(m.starts_at).toISOString() };
}
