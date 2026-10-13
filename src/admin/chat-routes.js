// API мессенджера: чаты, сообщения, прочитанное. Новые сообщения клиент забирает опросом:
// в открытом чате — раз в несколько секунд, в остальное время — вместе с уведомлениями.

import { ChatError } from '../chat/store.js';

const idParams = { type: 'object', properties: { id: { type: 'integer' } } };
const ids = { type: 'array', maxItems: 100, items: { type: 'integer' } };

export async function chatRoutes(api, { chat }) {
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof ChatError) return reply.code(400).send({ error: err.message });
    throw err;
  });

  api.get('/admin/api/chats', async (req) => ({ chats: chat.list(req.user) }));
  api.get('/admin/api/chats/incoming', { schema: { querystring: { type: 'object', properties: { after: { type: 'integer', minimum: 0 } } } } }, async (req) => chat.incoming(req.user, req.query.after ?? null));

  // личный чат — { userId }; группа — { title, memberIds, clientId }
  api.post('/admin/api/chats', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { userId: { type: 'integer' }, title: { type: 'string', maxLength: 100 }, memberIds: ids, clientId: { type: ['integer', 'null'] } } } },
  }, async (req) => ({ chat: req.body.userId ? chat.direct(req.user, req.body.userId) : chat.group(req.user, req.body) }));

  api.patch('/admin/api/chats/:id', {
    schema: { params: idParams, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { title: { type: 'string', maxLength: 100 }, addIds: ids, removeIds: ids } } },
  }, async (req) => ({ chat: chat.update(req.params.id, req.user, req.body) }));

  api.get('/admin/api/chats/:id/messages', {
    schema: { params: idParams, querystring: { type: 'object', properties: { before: { type: 'integer' }, after: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  }, async (req) => chat.messages(req.params.id, req.user, req.query));

  api.post('/admin/api/chats/:id/messages', {
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: 4000 }, fileIds: { type: 'array', maxItems: 10, items: { type: 'integer' } } } } },
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req) => ({ message: chat.send(req.params.id, req.user, req.body) }));

  api.patch('/admin/api/chat-messages/:id', {
    schema: { params: idParams, body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } } } },
  }, async (req) => ({ message: chat.edit(req.params.id, req.user, req.body.text) }));
  api.delete('/admin/api/chat-messages/:id', { schema: { params: idParams } }, async (req) => ({ message: chat.remove(req.params.id, req.user) }));

  api.post('/admin/api/chats/:id/read', {
    schema: { params: idParams, body: { type: 'object', required: ['lastId'], additionalProperties: false, properties: { lastId: { type: 'integer', minimum: 0 } } } },
  }, async (req) => ({ unread: chat.markRead(req.params.id, req.user, req.body.lastId) }));
}
