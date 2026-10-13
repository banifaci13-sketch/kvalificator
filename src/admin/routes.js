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
import { AuthError, ROLES } from './auth.js';
import { docsRoutes } from './docs-routes.js';
import { mediaplanRoutes } from './mediaplan-routes.js';
import { crmRoutes } from './crm-routes.js';

const SESSION_COOKIE = 'kval_admin';
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

export async function adminRoutes(app, { config, auth, reports, db, scenarioSource, library, brand, mediaplans, crm }) {
  const secure = config.publicUrl?.startsWith('https://') ?? false;
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

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/admin')) {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('referrer-policy', 'same-origin');
      // Превью и выгрузки документов задают свою политику (встроенные стили документа)
      if (!reply.getHeader('content-security-policy')) {
        reply.header('x-frame-options', 'DENY');
        reply.header(
          'content-security-policy',
          "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self' https://oauth.yandex.ru",
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
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (req, reply) => {
      const token = auth.login(req.body.login, req.body.password);
      if (!token) return reply.code(401).send({ error: 'Неверный логин или пароль' });
      setSession(reply, token);
      return { ok: true };
    },
  );

  app.get('/admin/auth/yandex', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
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
    api.addHook('preHandler', requireUser);
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
        config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
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
                role: { type: 'string', enum: Object.keys(ROLES) },
                disabled: { type: 'boolean' },
              },
            },
          },
        },
        async (req) => ({ user: auth.updateUser(req.params.id, req.body) }),
      );
    });

    if (library) await api.register(docsRoutes, { library, brand, db, scenarioSource });
    if (mediaplans) await api.register(mediaplanRoutes, { mediaplans });
    if (crm) await api.register(crmRoutes, { crm, auth, db, scenarioSource });

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
