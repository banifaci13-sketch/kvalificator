// API ИИ-ассистента и регламентов агентства (база знаний ассистента).
// Подключается внутри авторизованной части админки (req.user уже есть).

import { KbError } from '../assistant/kb.js';
import { DEFAULT_NAME } from '../assistant/index.js';

const idParams = { type: 'object', properties: { id: { type: 'integer' } } };
const kbBody = {
  type: 'object',
  additionalProperties: false,
  properties: { title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 100_000 } },
};

export async function assistantRoutes(api, { assistant, kb, ai, search }) {
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof KbError) return reply.code(400).send({ error: err.message });
    throw err;
  });

  api.get('/admin/api/assistant', async (req) => ({
    name: req.user.prefs?.assistantName || DEFAULT_NAME,
    ai: Boolean(ai?.enabled),
    search: Boolean(search?.enabled),
    kb: kb.list().length,
    history: assistant.history(req.user.id),
  }));

  api.post(
    '/admin/api/assistant',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      bodyLimit: 64 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['message'],
          additionalProperties: false,
          properties: {
            message: { type: 'string', minLength: 1, maxLength: 4000 },
            // где сотрудник сейчас: раздел и открытая задача — чтобы «помоги с этой задачей» работало
            context: {
              type: 'object',
              additionalProperties: false,
              properties: {
                page: { type: 'string', maxLength: 60 },
                task: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { id: { type: 'integer' }, title: { type: 'string', maxLength: 300 }, client: { type: ['string', 'null'], maxLength: 200 }, description: { type: ['string', 'null'], maxLength: 4000 } },
                },
              },
            },
          },
        },
      },
    },
    async (req) => assistant.handle(req.user, req.body.message, { context: req.body.context ?? {}, prefs: req.user.prefs ?? {} }),
  );

  api.delete('/admin/api/assistant/history', async (req) => {
    assistant.clear(req.user.id);
    return { ok: true };
  });

  // ---------- регламенты: читают все, правит администратор ----------

  const adminOnly = async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Регламенты правит администратор' });
  };

  api.get('/admin/api/kb', async () => ({ docs: kb.list() }));
  api.get('/admin/api/kb/:id', { schema: { params: idParams } }, async (req) => ({ doc: kb.get(req.params.id) }));
  api.post('/admin/api/kb', { preHandler: adminOnly, bodyLimit: 256 * 1024, schema: { body: { ...kbBody, required: ['title', 'body'] } } }, async (req) => ({ doc: kb.create(req.body, req.user) }));
  api.put('/admin/api/kb/:id', { preHandler: adminOnly, bodyLimit: 256 * 1024, schema: { params: idParams, body: kbBody } }, async (req) => ({ doc: kb.update(req.params.id, req.body, req.user) }));
  api.delete('/admin/api/kb/:id', { preHandler: adminOnly, schema: { params: idParams } }, async (req) => {
    kb.remove(req.params.id);
    return { ok: true };
  });
}
