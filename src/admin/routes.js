// Админка: вход (Яндекс ID или пароль), лиды, история, сводка, выгрузка.
// Сессия — httpOnly-cookie с SameSite=Strict; изменения принимаются только JSON-запросами.

import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAD_STATUSES, leadsToCsv } from './reports.js';
import { createYandexOAuth } from './yandex.js';
import { AuthError, ROLES, AVATAR_MAX } from './auth.js';
import { docsRoutes } from './docs-routes.js';
import { chromiumPath } from '../docs/browser.js';
import { mediaplanRoutes } from './mediaplan-routes.js';
import { crmRoutes } from './crm-routes.js';
import { calendarRoutes } from './calendar-routes.js';
import { aiRoutes } from './ai-routes.js';
import { DEFAULT_PREFS, PrefsError, checkPrefsPatch } from './prefs.js';
import { assistantRoutes } from './assistant-routes.js';
import { createNotifications } from '../notify/store.js';
import { createNews } from '../news/store.js';
import { newsRoutes } from './news-routes.js';
import { createChat } from '../chat/store.js';
import { createMonitor } from '../ops/monitor.js';
import { createSystemStatus } from '../ops/status.js';
import { createAbandoned } from '../core/abandoned.js';
import { chatRoutes } from './chat-routes.js';
import { createAssistant } from '../assistant/index.js';
import { createKb } from '../assistant/kb.js';
import { createSearch } from '../assistant/search.js';
import { meetingsIcs } from '../calendar/store.js';
import { createLeadSummary } from '../core/lead-summary.js';

const SESSION_COOKIE = 'kval_admin';
// Вход и смена пароля считаются по IP: иначе поддельная cookie давала бы новый счётчик на каждую попытку
const byIp = (req) => `ip:${req.ip}`;
const OVERDUE_SQL = "(t.due || ' ' || COALESCE(t.due_time, '23:59')) < strftime('%Y-%m-%d %H:%M', 'now', '+3 hours')";
const STATE_COOKIE = 'kval_oauth_state';
const CHANNELS = ['web', 'telegram', 'max'];

const leadQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rating: { type: 'string', pattern: '^[1-5](,[1-5])*$' },
    status: { type: 'string', maxLength: 100 },
    channel: { type: 'string', enum: CHANNELS },
    assignee: { type: 'string', maxLength: 100 },
    from: { type: 'string', format: 'date' },
    to: { type: 'string', format: 'date' },
    q: { type: 'string', maxLength: 100 },
    test: { type: 'string', enum: ['0', '1'] },
    page: { type: 'integer', minimum: 1 },
  },
};

function toFilter(query) {
  return {
    ...query,
    rating: query.rating ? query.rating.split(',').map(Number) : null,
    status: query.status ? query.status.split(',').filter((s) => s in LEAD_STATUSES) : null,
    test: query.test === '1',
  };
}

export async function adminRoutes(app, { config, auth, reports, db, scenarioSource, library, brand, mediaplans, crm, calendar, video, ai, media, files = null, money = null, monitor = null }) {
  const secure = config.publicUrl?.startsWith('https://') ?? false;
  // уведомления в кабинете: задачи шлют их сами, встречам — через маршруты календаря
  const notify = createNotifications({ db: db.raw });
  crm?.useNotify?.(notify);
  const news = createNews({ db: db.raw, files });
  const kb = createKb({ db: db.raw });
  const chat = createChat({ db: db.raw, files });
  // «Состояние системы» (администратор): бэкапы, фоновые задачи, ошибки — без секретов и персональных данных
  const system = createSystemStatus({
    db: db.raw,
    dbPath: config.dbPath,
    monitor: monitor ?? createMonitor(),
    leadRecipients: Boolean((config.telegram?.token && config.telegram?.managerChatId) || config.webhook?.url),
  });
  chat.useNotify(notify);
  news.useNotify(notify);
  const yandex =
    config.admin.yandexClientId && config.admin.yandexClientSecret && config.publicUrl
      ? createYandexOAuth({
          clientId: config.admin.yandexClientId,
          clientSecret: config.admin.yandexClientSecret,
          redirectUri: `${config.publicUrl}/admin/auth/yandex/callback`,
        })
      : null;

  await app.register(cookie);
  await app.register(fastifyStatic, {
    root: resolve(config.root, 'admin'),
    prefix: '/admin/',
    decorateReply: false,
    index: 'index.html',
  });

  // Расчёт медиаплана — один модуль для сервера и браузера: цифры в админке и в Excel совпадают
  const calcModule = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../mediaplan/calc.js'), 'utf8');
  app.get('/admin/lib/mediaplan-calc.js', (req, reply) => reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(calcModule));

  // Подписка на календарь сотрудника (Яндекс Календарь, Google, iPhone) — по секретной ссылке, без входа
  if (calendar) {
    app.get('/calendar/:file', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const user = calendar.userByCalendarToken(req.params.file.replace(/\.ics$/, ''));
      if (!user) return reply.code(404).send({ error: 'Календарь не найден' });
      const day = 24 * 3600_000;
      const meetings = calendar.meetingsForUser(user.id, new Date(Date.now() - 60 * day), new Date(Date.now() + 365 * day));
      const host = config.publicUrl ? new URL(config.publicUrl).hostname : 'soroka-assistant';
      return reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(meetingsIcs(meetings, { name: `Встречи — ${user.name}`, host }));
    });
  }

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/admin')) {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('referrer-policy', 'same-origin');
      // Превью и выгрузки документов задают свою политику (встроенные стили документа)
      if (!reply.getHeader('content-security-policy')) {
        reply.header('x-frame-options', 'DENY');
        reply.header(
          'content-security-policy',
          "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self' https://oauth.yandex.ru",
        );
      }
    }
    return payload;
  });

  const setSession = (reply, token) =>
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/admin',
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: auth.sessionDays * 86400,
    });

  // Все /admin/api/* кроме входа требуют сессию
  const requireUser = async (req, reply) => {
    req.user = auth.userByToken(req.cookies[SESSION_COOKIE]);
    if (!req.user) return reply.code(401).send({ error: 'Нужно войти' });
  };

  // ---------- вход ----------

  app.get('/admin/api/auth', async () => ({
    yandex: Boolean(yandex),
    password: true,
  }));

  app.post(
    '/admin/api/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['login', 'password'],
          additionalProperties: false,
          properties: { login: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 200 } },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '15 minutes', keyGenerator: byIp } },
    },
    async (req, reply) => {
      const token = auth.login(req.body.login, req.body.password);
      if (!token) return reply.code(401).send({ error: 'Неверный логин или пароль' });
      setSession(reply, token);
      return { ok: true };
    },
  );

  app.get('/admin/auth/yandex', { config: { rateLimit: { max: 20, timeWindow: '15 minutes', keyGenerator: byIp } } }, async (req, reply) => {
    if (!yandex) return reply.code(404).send({ error: 'Вход через Яндекс не настроен' });
    const state = randomBytes(16).toString('base64url');
    reply.setCookie(STATE_COOKIE, state, { path: '/admin/auth', httpOnly: true, sameSite: 'lax', secure, maxAge: 600 });
    return reply.redirect(yandex.authorizeUrl(state));
  });

  app.get('/admin/auth/yandex/callback', async (req, reply) => {
    const fail = (reason) => reply.redirect(`/admin/?error=${encodeURIComponent(reason)}`);
    if (!yandex) return fail('Вход через Яндекс не настроен');
    const { code, state } = req.query;
    const expected = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: '/admin/auth' });
    if (!code || !state || state !== expected) return fail('Сессия входа устарела, попробуйте ещё раз');
    try {
      const profile = await yandex.fetchProfile(String(code));
      const token = auth.loginWithYandex(profile, { allowedDomains: config.admin.allowedDomains });
      if (!token) {
        req.log.warn({ email: profile.default_email }, 'Вход через Яндекс: нет доступа');
        return fail(`У ${profile.default_email ?? 'этого аккаунта'} нет доступа. Попросите администратора добавить вашу почту.`);
      }
      setSession(reply, token);
      return reply.redirect('/admin/');
    } catch (err) {
      req.log.error({ err }, 'Ошибка входа через Яндекс');
      return fail('Не удалось войти через Яндекс');
    }
  });

  app.post('/admin/api/logout', async (req, reply) => {
    auth.logout(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/admin' });
    return { ok: true };
  });

  // ---------- данные ----------

  app.register(async (api) => {
    // проверка входа — первым делом, до разбора тела и приёма файлов
    api.addHook('onRequest', requireUser);
    api.setErrorHandler((err, req, reply) => {
      if (err instanceof AuthError) return reply.code(400).send({ error: err.message });
      throw err;
    });

    api.get('/admin/api/me', async (req) => ({
      user: req.user,
      roles: ROLES,
      statuses: LEAD_STATUSES,
      scenario: scenarioSource.get(),
      links: {
        widgetTest: '/demo.html?kval_test=1',
        telegramTest: config.telegram.botUsername ? `https://t.me/${config.telegram.botUsername}?start=test` : null,
      },
      testChat: Boolean(config.telegram.testChatId),
      avatars: auth.avatars(),
      aiSummary: Boolean(ai?.enabled),
      sections: config.adminSections ?? null,
    }));

    api.get('/admin/api/leads', { schema: { querystring: leadQuery } }, async (req) => ({
      ...reports.listLeads(toFilter(req.query)),
      assignees: reports.assignees(),
    }));

    api.get('/admin/api/board', { schema: { querystring: leadQuery } }, async (req) => ({
      leads: reports.allLeads(toFilter(req.query), 500),
    }));

    api.get('/admin/api/leads/:id', { schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } } }, async (req, reply) => {
      const lead = db.getLead(req.params.id);
      if (!lead) return reply.code(404).send({ error: 'Лид не найден' });
      return { lead, events: db.leadEvents(lead.id) };
    });

    // сводка ИИ по заявке: составить заново (по тем же данным заявки)
    const summarizer = createLeadSummary({ ai, log: app.log });
    api.post('/admin/api/leads/:id/summary', {
      schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (req, reply) => {
      const lead = db.getLead(req.params.id);
      if (!lead) return reply.code(404).send({ error: 'Лид не найден' });
      if (!summarizer.enabled) return reply.code(409).send({ error: 'ИИ не подключён — сводку составить нельзя' });
      const summary = await summarizer.summarize(lead, scenarioSource.get());
      if (!summary) return reply.code(502).send({ error: 'ИИ не ответил — попробуйте ещё раз' });
      db.setLeadSummary(lead.id, summary);
      return { lead: db.getLead(lead.id), events: db.leadEvents(lead.id) };
    });

    api.patch(
      '/admin/api/leads/:id',
      {
        schema: {
          params: { type: 'object', properties: { id: { type: 'integer' } } },
          body: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              status: { type: 'string', enum: Object.keys(LEAD_STATUSES) },
              assignee: { type: ['string', 'null'], maxLength: 100 },
              comment: { type: ['string', 'null'], maxLength: 5000 },
            },
          },
        },
      },
      async (req, reply) => {
        const patch = { ...req.body };
        if (typeof patch.assignee === 'string') patch.assignee = patch.assignee.trim() || null;
        const lead = db.updateLead(req.params.id, patch, req.user.name);
        if (!lead) return reply.code(404).send({ error: 'Лид не найден' });
        return { lead, events: db.leadEvents(lead.id) };
      },
    );

    // ---------- сотрудники ----------

    // Своё имя (видно в шапке, у задач и встреч) каждый меняет сам
    api.patch(
      '/admin/api/me',
      {
        schema: {
          body: {
            type: 'object',
            minProperties: 1,
            additionalProperties: false,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              position: { type: ['string', 'null'], maxLength: 100 },
              phone: { type: ['string', 'null'], maxLength: 40 },
            },
          },
        },
      },
      async (req) => {
        if (req.body.name !== undefined && !req.body.name.trim()) throw new AuthError('Укажите имя');
        const { name, position, phone } = req.body;
        return { user: auth.updateUser(req.user.id, { name, position, phone }) };
      },
    );

    // Фото профиля: картинка приходит «как есть» в теле запроса, браузер заранее обрезает её до квадрата
    await api.register(async (r) => {
      r.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: AVATAR_MAX }, (req, body, done) => done(null, body));
      r.put('/admin/api/me/avatar', { bodyLimit: AVATAR_MAX, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
        if (!Buffer.isBuffer(req.body)) throw new AuthError('Нужна картинка JPG или PNG');
        return { avatar: auth.setAvatar(req.user.id, req.body) };
      });
    });
    api.delete('/admin/api/me/avatar', async (req) => {
      auth.removeAvatar(req.user.id);
      return { avatar: null };
    });
    api.get('/admin/api/users/:id/avatar', { schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } } }, async (req, reply) => {
      const a = auth.getAvatar(req.params.id);
      if (!a) return reply.code(404).send({ error: 'Фото нет' });
      // адрес меняется вместе с фото (?v=версия), поэтому браузер может держать его в кэше
      return reply.header('content-type', a.mime).header('cache-control', 'private, max-age=31536000, immutable').send(Buffer.from(a.data));
    });

    // Личные настройки внешнего вида кабинета — каждый меняет свои
    api.patch(
      '/admin/api/me/prefs',
      {
        schema: {
          body: {
            type: 'object',
            minProperties: 1,
            additionalProperties: false,
            properties: Object.fromEntries(Object.keys(DEFAULT_PREFS).map((k) => [k, { type: 'string', maxLength: k === 'nav' || k === 'notifyMute' ? 200 : 32 }])),
          },
        },
      },
      async (req, reply) => {
        try {
          checkPrefsPatch(req.body, {
            mediaExists: (id) => {
              try {
                return Boolean(media?.get(id));
              } catch {
                return false;
              }
            },
          });
        } catch (err) {
          if (err instanceof PrefsError) return reply.code(400).send({ error: err.message });
          throw err;
        }
        return { prefs: auth.setPrefs(req.user.id, req.body) };
      },
    );

    api.post(
      '/admin/api/me/password',
      {
        schema: {
          body: {
            type: 'object',
            required: ['next'],
            additionalProperties: false,
            properties: { current: { type: 'string', maxLength: 200 }, next: { type: 'string', minLength: 10, maxLength: 200 } },
          },
        },
        config: { rateLimit: { max: 10, timeWindow: '15 minutes', keyGenerator: byIp } },
      },
      async (req) => {
        auth.changeOwnPassword(req.user.id, req.body.current ?? '', req.body.next, req.cookies[SESSION_COOKIE]);
        return { ok: true };
      },
    );

    api.register(async (staff) => {
      staff.addHook('preHandler', async (req, reply) => {
        if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Доступно только администратору' });
      });
      const idParams = { type: 'object', properties: { id: { type: 'integer' } } };

      staff.get('/admin/api/users', async () => ({ users: auth.listUsers(), roles: ROLES }));

      staff.get('/admin/api/system', async () => system.get());

      // брошенные диалоги с квалификатором: переписка без согласия — только администратору
      const abandoned = createAbandoned({ db: db.raw, days: config.abandonedDays ?? 10 });
      staff.get('/admin/api/abandoned', async () => ({ days: abandoned.days, dialogs: abandoned.list() }));

      // Что подключено на сервере: ключи не показываем, только «есть / нет»
      staff.get('/admin/api/integrations', async () => {
        let pdf = true;
        try {
          chromiumPath();
        } catch {
          pdf = false;
        }
        return {
          ai: { enabled: Boolean(ai?.enabled), provider: ai?.provider ?? null, model: ai?.model ?? null },
          zoom: Boolean(video?.available.zoom),
          telemost: Boolean(video?.available.telemost),
          search: Boolean(config.search?.apiKey && config.search?.folderId),
          telegram: { enabled: config.telegram.botEnabled, bot: config.telegram.botUsername ?? null, managerChat: Boolean(config.telegram.managerChatId) },
          pdf,
          publicUrl: config.publicUrl,
        };
      });

      staff.post(
        '/admin/api/users',
        {
          schema: {
            body: {
              type: 'object',
              required: ['login'],
              additionalProperties: false,
              properties: {
                login: { type: 'string', maxLength: 64 },
                name: { type: 'string', maxLength: 100 },
                role: { type: 'string', enum: Object.keys(ROLES) },
              },
            },
          },
        },
        async (req) => {
          const { user, password } = auth.addUser(req.body.login, req.body.name, { role: req.body.role ?? 'manager' });
          req.log.info({ by: req.user.login, login: user.login }, 'Добавлен сотрудник');
          return { user, password };
        },
      );

      staff.post('/admin/api/users/:id/reset-password', { schema: { params: idParams } }, async (req) => {
        const password = auth.resetPassword(req.params.id);
        req.log.info({ by: req.user.login, id: req.params.id }, 'Сброшен пароль сотрудника');
        return { password };
      });

      staff.patch(
        '/admin/api/users/:id',
        {
          schema: {
            params: idParams,
            body: {
              type: 'object',
              minProperties: 1,
              additionalProperties: false,
              properties: {
                name: { type: 'string', maxLength: 100 },
                login: { type: 'string', maxLength: 64 },
                position: { type: ['string', 'null'], maxLength: 100 },
                phone: { type: ['string', 'null'], maxLength: 40 },
                role: { type: 'string', enum: Object.keys(ROLES) },
                disabled: { type: 'boolean' },
              },
            },
          },
        },
        async (req) => ({ user: auth.updateUser(req.params.id, req.body) }),
      );

      staff.delete('/admin/api/users/:id', { schema: { params: idParams } }, async (req) => {
        auth.deleteUser(req.params.id, req.user.id);
        return { ok: true };
      });
    });

    if (library) await api.register(docsRoutes, { library, brand, db, scenarioSource, media });
    if (mediaplans) await api.register(mediaplanRoutes, { mediaplans, brand });
    if (crm) await api.register(crmRoutes, { crm, auth, db, scenarioSource, kb, files, money });

    // ---------- уведомления (колокольчик) ----------
    // after — только новые (для всплывающих окон): опрос раз в 20 секунд
    api.get('/admin/api/notifications', { schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0 } } } } }, async (req) => ({
      items: req.query.after != null ? notify.after(req.user.id, req.query.after) : notify.list(req.user.id),
      unread: notify.unread(req.user.id),
      last: notify.lastId(req.user.id),
    }));
    // проверка настроек: тестовое уведомление себе
    api.post('/admin/api/notifications/test', async (req) => {
      notify.add(req.user.id, { kind: 'test', text: 'Проверка: так выглядят уведомления кабинета', href: '#/notify-settings' });
      return { unread: notify.unread(req.user.id) };
    });
    api.post(
      '/admin/api/notifications/read',
      { schema: { body: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' } } } } },
      async (req) => {
        notify.read(req.user.id, req.body?.id ?? null);
        return { unread: notify.unread(req.user.id) };
      },
    );

    // ---------- «Мой день»: всё на сегодня одним запросом ----------
    // «Главная»: сводка дня — горящие задачи, встречи, свежие заявки, уведомления, нагрузка команды
    const home = {
      doneWeek: db.raw.prepare("SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status = 'done' AND done_at >= datetime('now', '-7 days')"),
      delegated: db.raw.prepare(
        `SELECT t.id, t.title, t.due, t.due_time, t.client_id, t.priority, t.assignee_id, u.name AS assignee_name,
                (t.due IS NOT NULL AND ${OVERDUE_SQL}) AS overdue
         FROM tasks t JOIN admin_users u ON u.id = t.assignee_id
         WHERE t.created_by_id = ? AND t.assignee_id != t.created_by_id AND t.status != 'done'
         ORDER BY overdue DESC, t.due IS NULL, t.due, t.id DESC LIMIT 6`,
      ),
      team: db.raw.prepare(
        `SELECT u.id, u.name, u.position,
                COUNT(t.id) AS open,
                COALESCE(SUM(t.due IS NOT NULL AND ${OVERDUE_SQL}), 0) AS overdue,
                (SELECT COUNT(*) FROM tasks d WHERE d.assignee_id = u.id AND d.status = 'done' AND d.done_at >= datetime('now', '-7 days')) AS done_week
         FROM admin_users u LEFT JOIN tasks t ON t.assignee_id = u.id AND t.status != 'done'
         WHERE u.disabled = 0 GROUP BY u.id ORDER BY overdue DESC, open DESC, u.name`,
      ),
    };
    api.get('/admin/api/home', async (req) => {
      const msk = new Date(Date.now() + 3 * 3600e3);
      const today = msk.toISOString().slice(0, 10);
      const nowMsk = msk.toISOString().slice(0, 16).replace('T', ' ');
      const plus = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
      const open = crm ? crm.listTasks({ mine: req.user.id, open: true }) : [];
      const late = (t) => t.due && `${t.due} ${t.due_time ?? '23:59'}` < nowMsk;
      const tasks = {
        overdue: open.filter(late),
        today: open.filter((t) => t.due === today && !late(t)),
        week: open.filter((t) => t.due > today && t.due <= plus(7)),
        nodue: open.filter((t) => !t.due).length,
      };
      // «Горит»: просрочено, на сегодня, важное на ближайшие три дня и критичное без срока
      const hot = open
        .filter((t) => late(t) || t.due === today || (t.priority >= 3 && t.due && t.due <= plus(3)) || (t.priority === 4 && !t.due))
        .sort((x, y) => Number(!!late(y)) - Number(!!late(x)) || (x.due ?? '9999').localeCompare(y.due ?? '9999') || (x.due_time ?? '99').localeCompare(y.due_time ?? '99') || y.priority - x.priority)
        .slice(0, 12);
      const meetings = calendar
        ? calendar
            .list({ from: `${today}T00:00:00+03:00`, to: `${plus(2)}T00:00:00+03:00`, userId: req.user.id })
            .filter((m) => !m.cancelled)
            .map((m) => ({ id: m.id, title: m.title, starts_at: `${m.starts_at.replace(' ', 'T')}Z`, duration: m.duration, client_name: m.client_name, link: m.link, format: m.format }))
        : [];
      // свежие заявки за 3 дня, ещё никем не взятые
      const leads = reports
        .allLeads({ from: plus(-2) }, 50)
        .filter((l) => l.status === 'new' && !l.meta?.test)
        .sort((a, b) => b.rating - a.rating || b.id - a.id)
        .slice(0, 6)
        .map((l) => ({ id: l.id, rating: l.rating, company: l.answers?.company?.raw ?? l.answers?.company ?? null, created_at: l.created_at, channel: l.channel }));
      // «Продолжить работу»: документы и медиапланы, которые человек правил последними
      const mineWork = (rows, kind) => rows.filter((r) => r.updated_by === req.user.name || r.created_by === req.user.name).slice(0, 4).map((r) => ({ kind, id: r.id, title: r.title, updated_at: r.updated_at }));
      const recent = [...(library ? mineWork(library.listDocuments(), 'doc') : []), ...(mediaplans ? mineWork(mediaplans.list(), 'plan') : [])]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 5);
      return {
        today,
        stats: { open: open.length, overdue: tasks.overdue.length, doneWeek: home.doneWeek.get(req.user.id).n, meetings: meetings.filter((m) => new Date(Date.parse(m.starts_at) + 3 * 3600e3).toISOString().slice(0, 10) === today).length, leads: leads.length },
        hot,
        tasks,
        meetings,
        leads,
        recent,
        delegated: home.delegated.all(req.user.id).map((t) => ({ ...t, overdue: !!t.overdue })),
        team: req.user.role === 'admin' ? home.team.all().filter((u) => u.open || u.done_week) : null,
        notifications: notify.list(req.user.id, 6).filter((n) => !n.read_at),
        news: news.list(req.user.id, { limit: 3 }).posts.map((p) => ({ id: p.id, kind: p.kind, title: p.title, body: p.body.slice(0, 220), author: p.author, author_id: p.author_id, created_at: p.created_at, pinned: p.pinned, comments: p.comments, image: p.files.find((f) => f.kind === 'image')?.id ?? null, files: p.files.length })),
        newsUnseen: news.unseen(req.user.id),
        money: money ? (({ overdue, expected, received, debtors, soon }) => ({ overdue, expected, received, debtors: debtors.slice(0, 5), soon: soon.slice(0, 5) }))(money.summary(req.user)) : null,
      };
    });
    if (calendar) await api.register(calendarRoutes, { calendar, video, config, notify, crm, auth });
    await api.register(newsRoutes, { news, files });
    await api.register(chatRoutes, { chat });
    if (library && ai) await api.register(aiRoutes, { ai, library, db, scenarioSource });

    // ИИ-ассистент в боковой панели: поручения, помощь по регламентам, поиск в интернете
    {
      const search = createSearch(config.search);
      const log = db.raw.prepare('INSERT INTO ai_log (user_id, action, provider, model, chars_in, chars_out, replaced, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const assistant = createAssistant({ db: db.raw, crm, calendar, auth, ai, search, kb, log, mediaplans, library, leads: db, reports, notify, news, money, chat });
      await api.register(assistantRoutes, { assistant, kb, ai, search });
    }

    api.get('/admin/api/stats', { schema: { querystring: leadQuery } }, async (req) => reports.stats(toFilter(req.query)));

    api.get('/admin/api/leads.csv', { schema: { querystring: leadQuery } }, async (req, reply) => {
      const csv = leadsToCsv(reports.allLeads(toFilter(req.query)), scenarioSource.get());
      const date = new Date().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="leads-${date}.csv"`)
        .send(csv);
    });
  });
}
