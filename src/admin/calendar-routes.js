// API раздела «Календарь»: встречи, ссылки Zoom/Телемост, Telegram для напоминаний, подписка на календарь.
// Подключается внутри авторизованной части админки (req.user уже есть).

import { CalendarError, FORMATS, PROVIDERS, REMIND_OPTIONS, REPEATS, fromDbTime } from '../calendar/store.js';
import { VideoError } from '../calendar/video.js';
import { parseFollowup } from '../assistant/followup.js';

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
    // регулярная встреча: правило повтора; null — больше не повторять
    repeat: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['rule'],
      properties: {
        rule: { type: 'string', enum: Object.keys(REPEATS) },
        days: { type: 'array', maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } },
        until: { type: ['string', 'null'], format: 'date' },
        count: { type: ['integer', 'null'], minimum: 2, maximum: 500 },
      },
    },
    // для встречи из серии: изменить только эту или эту и следующие
    scope: { type: 'string', enum: ['one', 'following'] },
  },
};
const scopeQuery = { type: 'object', properties: { scope: { type: 'string', enum: ['one', 'following'] } } };

export async function calendarRoutes(api, { calendar, video, config, notify = null, crm = null, auth = null }) {
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
      repeats: REPEATS,
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
    // участникам — уведомление в кабинете (о серии — одно, с правилом повтора)
    const when = new Date(`${m.starts_at.replace(' ', 'T')}Z`).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
    const text = m.series
      ? `Вас пригласили на регулярную встречу «${m.title}» — ${m.series.label[0].toLowerCase()}${m.series.label.slice(1)}, первая — ${when}`
      : `Вас пригласили на встречу «${m.title}» — ${when}`;
    for (const p of m.participants ?? []) {
      notify?.add(p.id, { kind: 'meeting', text, href: `#/calendar?meeting=${m.id}`, actor: req.user.name, actorId: req.user.id });
    }
    return { meeting: publicMeeting(m) };
  });

  api.get('/admin/api/meetings/:id', { schema: { params: idParams } }, async (req) => ({ meeting: publicMeeting(calendar.get(req.params.id)) }));

  // ---------- итоги встречи (постмит) ----------
  // список договорённостей текстом → строки задач с исполнителями и сроками
  api.post('/admin/api/meetings/:id/followup/parse', {
    schema: { params: idParams, body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 10000 } } } },
  }, async (req) => {
    calendar.get(req.params.id);
    const team = auth ? auth.listUsers().filter((u) => !u.disabled) : [];
    return { items: parseFollowup(req.body.text, { team }) };
  });

  // резюме встречи и задачи по итогам: в проект клиента встречи, каждая — своему исполнителю
  api.post('/admin/api/meetings/:id/followup', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: ['string', 'null'], maxLength: 10000 },
          send: { type: 'boolean' },
          items: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              required: ['title'],
              additionalProperties: false,
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 300 },
                assigneeId: nullableId,
                due: { type: ['string', 'null'], format: 'date' },
                dueTime: { type: ['string', 'null'], pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
                priority: { type: 'integer', minimum: 0, maximum: 4 },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const m = calendar.get(req.params.id);
    const items = req.body.items ?? [];
    if (items.length && !crm) throw new CalendarError('Задачи недоступны');
    const when = new Date(`${m.starts_at.replace(' ', 'T')}Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
    const tasks = [];
    for (const it of items) {
      const t = crm.createTask(
        { title: it.title, description: `По итогам встречи «${m.title}», ${when}.`, clientId: m.client_id ?? null, assigneeId: it.assigneeId ?? null, due: it.due ?? null, dueTime: it.due ? it.dueTime ?? null : null, priority: it.priority ?? 0 },
        req.user,
      );
      crm.linkTask(t.id, { kind: 'meeting', refId: m.id }, req.user);
      tasks.push(t);
    }
    const updated = req.body.summary !== undefined ? calendar.setSummary(m.id, req.body.summary, req.user) : calendar.get(m.id);
    // итоги — участникам встречи и исполнителям (каждому свои задачи уже пришли уведомлением о поручении)
    if (req.body.send && notify) {
      const mine = (uid) => tasks.filter((t) => t.assignee_id === uid).length;
      const to = new Set([...(updated.participants ?? []).map((p) => p.id), ...tasks.map((t) => t.assignee_id).filter(Boolean)]);
      for (const uid of to) {
        const n = mine(uid);
        notify.add(uid, { kind: 'meeting', text: `Итоги встречи «${m.title}»${tasks.length ? `: задач — ${tasks.length}${n ? `, ваших — ${n}` : ''}` : ''}`, href: `#/calendar?meeting=${m.id}`, actor: req.user.name, actorId: req.user.id });
      }
    }
    return { meeting: publicMeeting(updated), tasks };
  });

  api.put('/admin/api/meetings/:id', { schema: { params: idParams, body: meetingBody } }, async (req) => {
    const { scope = 'one', ...patch } = req.body;
    return { meeting: publicMeeting(calendar.update(req.params.id, patch, { scope })) };
  });

  api.delete('/admin/api/meetings/:id', { schema: { params: idParams, querystring: scopeQuery } }, async (req, reply) => {
    const m = calendar.get(req.params.id);
    if (req.user.role !== 'admin' && m.created_by_id !== req.user.id) {
      return reply.code(403).send({ error: 'Удалить встречу может её автор или администратор — остальные могут отменить' });
    }
    calendar.remove(m.id, { scope: req.query.scope ?? 'one' });
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
            // для регулярной встречи — постоянная ссылка (в Zoom — повторяющаяся встреча без времени)
            recurring: { type: 'boolean' },
          },
        },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const start = new Date(req.body.startsAt);
      if (Number.isNaN(start.getTime())) throw new CalendarError('Неверная дата или время');
      const res = await video.create(req.body.provider, { title: req.body.title || 'Встреча', start, duration: req.body.duration ?? 60, agenda: req.body.agenda, recurring: Boolean(req.body.recurring) });
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
