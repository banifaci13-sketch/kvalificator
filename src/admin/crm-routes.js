// API раздела «Задачи»: проекты (клиенты агентства и «Общие задачи»), их доски и колонки,
// задачи команды и комментарии.
// Подключается внутри авторизованной части админки (req.user уже есть).

import { outline, KbError } from '../assistant/kb.js';
import { REPEATS, CrmError, PRIORITIES, COLUMN_COLORS, LINK_KINDS } from '../crm/store.js';
import { leadValues } from '../docs/library.js';

const idParams = { type: 'object', properties: { id: { type: 'integer' } } };
const nullableId = { type: ['integer', 'null'] };
const clientBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 200 },
    contact: { type: ['string', 'null'], maxLength: 200 },
    phone: { type: ['string', 'null'], maxLength: 60 },
    email: { type: ['string', 'null'], maxLength: 200 },
    site: { type: ['string', 'null'], maxLength: 300 },
    notes: { type: ['string', 'null'], maxLength: 5000 },
    managerId: nullableId,
    archived: { type: 'boolean' },
    fromLead: { type: 'integer' },
  },
};
const taskBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 300 },
    description: { type: ['string', 'null'], maxLength: 10000 },
    done: { type: 'boolean' },
    columnId: { type: 'integer' },
    boardId: { type: 'integer' },
    priority: { type: 'integer', enum: [0, 1, 2, 3, 4] },
    assigneeId: nullableId,
    clientId: nullableId,
    due: { type: ['string', 'null'], maxLength: 10 },
    dueTime: { type: ['string', 'null'], maxLength: 5 },
    repeat: { type: ['string', 'null'], enum: [...Object.keys(REPEATS), null] },
  },
};
const projectParams = { type: 'object', properties: { key: { type: 'string', pattern: '^(\\d+|none)$' } } };
const columnBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 60 },
    color: { type: 'string', enum: Object.keys(COLUMN_COLORS) },
    isDone: { type: 'boolean' },
    move: { type: 'integer', enum: [-1, 1] },
  },
};

export async function crmRoutes(api, { crm, auth, db, scenarioSource, kb = null, files = null, money = null }) {
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof CrmError) return reply.code(400).send({ error: err.message });
    if (err instanceof KbError) return reply.code(404).send({ error: err.message });
    throw err;
  });

  // Команда — для выбора исполнителя и ответственного (без логинов и ролей)
  api.get('/admin/api/team', async () => ({
    team: auth.listUsers().filter((u) => !u.disabled).map((u) => ({ id: u.id, name: u.name })),
    priorities: PRIORITIES,
    repeats: REPEATS,
    colors: COLUMN_COLORS,
  }));

  // ---------- проекты, доски, колонки (как в YouGile) ----------

  // Проекты: клиенты в работе и «Общие задачи»
  api.get('/admin/api/projects', async (req) => ({ projects: crm.projects(req.user.id) }));

  api.get('/admin/api/projects/:key/boards', { schema: { params: projectParams } }, async (req) => {
    const key = req.params.key;
    const project = key === 'none' ? { id: 'none', name: 'Общие задачи', internal: true } : crm.getClient(key);
    return { project, boards: crm.projectBoards(key) };
  });

  api.post(
    '/admin/api/boards',
    { schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 100 }, clientId: nullableId } } } },
    async (req) => ({ board: crm.createBoard(req.body) }),
  );

  api.patch(
    '/admin/api/boards/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 100 }, move: { type: 'integer', enum: [-1, 1] } } } } },
    async (req) => ({ board: crm.updateBoard(req.params.id, req.body) }),
  );

  api.delete('/admin/api/boards/:id', { schema: { params: idParams } }, async (req) => {
    crm.deleteBoard(req.params.id);
    return { ok: true };
  });

  api.post('/admin/api/boards/:id/columns', { schema: { params: idParams, body: { ...columnBody, required: ['name'] } } }, async (req) => ({
    column: crm.createColumn(req.params.id, req.body),
  }));

  api.patch('/admin/api/columns/:id', { schema: { params: idParams, body: columnBody } }, async (req) => ({ column: crm.updateColumn(req.params.id, req.body) }));

  api.delete('/admin/api/columns/:id', { schema: { params: idParams } }, async (req) => {
    crm.deleteColumn(req.params.id);
    return { ok: true };
  });

  // ---------- клиенты ----------

  api.get('/admin/api/clients', { schema: { querystring: { type: 'object', properties: { archived: { type: 'boolean' } } } } }, async (req) => ({
    clients: crm.listClients({ archived: req.query.archived }),
  }));

  api.post('/admin/api/clients', { schema: { body: clientBody } }, async (req) => {
    const { fromLead, ...v } = req.body;
    if (fromLead) {
      // клиент из заявки квалификатора: название, контакт и телефон/почта из ответов
      const lead = db.getLead(fromLead);
      if (!lead) throw new CrmError('Заявка не найдена');
      const vals = leadValues(lead, scenarioSource.get(), req.user);
      const raw = lead.answers.contact?.raw ?? lead.answers.contact ?? '';
      const contact = String(raw);
      Object.assign(v, {
        name: v.name || vals.client || `Заявка #${lead.id}`,
        contact: v.contact ?? (vals.contact_name || null),
        phone: v.phone ?? (contact && !contact.includes('@') ? contact : null),
        email: v.email ?? (contact.includes('@') ? contact : null),
        managerId: v.managerId ?? req.user.id,
        leadId: lead.id,
      });
    }
    return { client: crm.createClient(v, req.user) };
  });

  api.get('/admin/api/clients/:id', { schema: { params: idParams } }, async (req) => ({
    client: crm.getClient(req.params.id),
    tasks: crm.clientTasks(req.params.id),
    files: crm.clientFiles(req.params.id),
  }));
  // файлы клиента: договор, брифы, доступы, макеты
  api.post('/admin/api/clients/:id/files', {
    schema: { params: idParams, body: { type: 'object', required: ['fileIds'], additionalProperties: false, properties: { fileIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'integer' } } } } },
  }, async (req) => ({ files: crm.attachClientFiles(req.params.id, req.body.fileIds, req.user) }));
  api.delete('/admin/api/clients/:id/files/:fileId', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer' }, fileId: { type: 'integer' } } } },
  }, async (req) => {
    const list = crm.detachClientFile(req.params.id, req.params.fileId);
    files?.removeIfUnused(req.params.fileId);
    return { files: list };
  });

  api.put('/admin/api/clients/:id', { schema: { params: idParams, body: clientBody } }, async (req) => {
    const { fromLead: _, ...patch } = req.body;
    return { client: crm.updateClient(req.params.id, patch) };
  });

  api.delete('/admin/api/clients/:id', { schema: { params: idParams } }, async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Удалить клиента может администратор — остальные могут перенести его в архив' });
    crm.deleteClient(req.params.id);
    return { ok: true };
  });

  // ---------- деньги по клиентам ----------
  if (money) {
    const payBody = {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: Object.keys(money.kinds) },
        title: { type: ['string', 'null'], maxLength: 200 },
        amount: { type: 'number', exclusiveMinimum: 0 },
        due: { type: ['string', 'null'], format: 'date' },
        period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        invoice: { type: ['string', 'null'], maxLength: 100 },
        note: { type: ['string', 'null'], maxLength: 1000 },
        paid: { type: 'boolean' },
      },
    };
    api.get('/admin/api/money', { schema: { querystring: { type: 'object', properties: { client: { type: 'integer' } } } } }, async (req) => ({
      payments: money.list(req.user, { clientId: req.query.client ?? null }),
      summary: req.query.client ? null : money.summary(req.user),
      kinds: money.kinds,
    }));
    api.post('/admin/api/clients/:id/payments', { schema: { params: idParams, body: { ...payBody, required: ['amount'] } } }, async (req) => ({ payment: money.add(req.params.id, req.body, req.user) }));
    api.patch('/admin/api/payments/:id', { schema: { params: idParams, body: { ...payBody, minProperties: 1 } } }, async (req) => ({ payment: money.update(req.params.id, req.body, req.user) }));
    api.delete('/admin/api/payments/:id', { schema: { params: idParams } }, async (req) => {
      money.remove(req.params.id, req.user);
      return { ok: true };
    });
    api.patch('/admin/api/clients/:id/billing', {
      schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { fee: { type: ['number', 'null'], minimum: 0 }, payDay: { type: ['integer', 'null'], minimum: 1, maximum: 31 } } } },
    }, async (req) => ({ client: money.setBilling(req.params.id, req.body, req.user), payments: money.list(req.user, { clientId: req.params.id }) }));
  }

  // ---------- вложения к задаче ----------
  api.post('/admin/api/tasks/:id/files', {
    schema: { params: idParams, body: { type: 'object', required: ['fileIds'], additionalProperties: false, properties: { fileIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'integer' } } } } },
  }, async (req) => ({ files: crm.attachFiles(req.params.id, req.body.fileIds, req.user) }));
  api.delete('/admin/api/tasks/:id/files/:fileId', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer' }, fileId: { type: 'integer' } } } },
  }, async (req) => {
    const list = crm.detachFile(req.params.id, req.params.fileId, req.user);
    files?.removeIfUnused(req.params.fileId);
    return { files: list };
  });

  // ---------- чек-лист задачи и процессы из регламентов ----------
  api.post('/admin/api/tasks/:id/checklist', {
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 300 } }, docId: { type: 'integer' } } } },
  }, async (req) => {
    if (req.body.docId) {
      if (!kb) throw new CrmError('Регламенты недоступны');
      const doc = kb.get(req.body.docId);
      const items = outline(doc).flatMap((st) => (st.items.length ? st.items : st.title !== doc.title ? [st.title] : []));
      if (!items.length) throw new CrmError('В регламенте нет пунктов-списков — добавьте строки «- пункт»');
      return { checklist: crm.addChecklist(req.params.id, items, req.user, { source: doc.title }) };
    }
    if (!req.body.items) throw new CrmError('Нет пунктов');
    return { checklist: crm.addChecklist(req.params.id, req.body.items, req.user) };
  });
  api.patch('/admin/api/checklist/:id', {
    schema: { params: idParams, body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { text: { type: 'string', maxLength: 300 }, done: { type: 'boolean' } } } },
  }, async (req) => ({ checklist: crm.updateCheck(req.params.id, req.body, req.user) }));
  api.delete('/admin/api/checklist/:id', { schema: { params: idParams } }, async (req) => ({ checklist: crm.removeCheck(req.params.id) }));

  // Регламент → задачи проекта: шаг — задача, пункты — чек-лист
  api.get('/admin/api/kb/:id/outline', { schema: { params: idParams } }, async (req) => {
    if (!kb) throw new CrmError('Регламенты недоступны');
    const doc = kb.get(req.params.id);
    return { title: doc.title, steps: outline(doc) };
  });
  api.post('/admin/api/kb/:id/apply', {
    schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { clientId: nullableId, boardId: nullableId, assigneeId: nullableId } } },
  }, async (req) => {
    if (!kb) throw new CrmError('Регламенты недоступны');
    const doc = kb.get(req.params.id);
    return crm.tasksFromSteps({ clientId: req.body.clientId ?? null, boardId: req.body.boardId ?? null, assigneeId: req.body.assigneeId ?? null, steps: outline(doc), source: doc.title }, req.user);
  });

  // ---------- задачи ----------

  api.get(
    '/admin/api/tasks',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { board: { type: 'integer' }, client: { type: 'string', pattern: '^(\\d+|none)$' }, assignee: { type: 'string', maxLength: 12 }, mine: { type: 'boolean' }, q: { type: 'string', maxLength: 100 } },
        },
      },
    },
    async (req) => ({
      tasks: crm.listTasks({ boardId: req.query.board, clientId: req.query.client, assigneeId: req.query.assignee, mine: req.query.mine ? req.user.id : null, q: req.query.q?.trim() }),
    }),
  );

  api.post('/admin/api/tasks', { schema: { body: { ...taskBody, required: ['title'] } } }, async (req) => ({ task: crm.createTask(req.body, req.user) }));

  api.get('/admin/api/tasks/:id', { schema: { params: idParams } }, async (req) => ({ task: crm.getTask(req.params.id) }));

  api.patch('/admin/api/tasks/:id', { schema: { params: idParams, body: taskBody } }, async (req) => {
    crm.updateTask(req.params.id, req.body, req.user);
    return { task: crm.getTask(req.params.id) };
  });

  api.delete('/admin/api/tasks/:id', { schema: { params: idParams } }, async (req) => {
    crm.deleteTask(req.params.id, req.user);
    return { ok: true };
  });

  // связи задачи с медиапланом, документом, встречей
  api.post(
    '/admin/api/tasks/:id/links',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['kind', 'refId'], additionalProperties: false, properties: { kind: { type: 'string', enum: Object.keys(LINK_KINDS) }, refId: { type: 'integer' } } },
      },
    },
    async (req) => ({ links: crm.linkTask(req.params.id, req.body, req.user) }),
  );

  api.delete(
    '/admin/api/tasks/:id/links/:linkId',
    { schema: { params: { type: 'object', properties: { id: { type: 'integer' }, linkId: { type: 'integer' } } } } },
    async (req) => ({ links: crm.unlinkTask(req.params.id, req.params.linkId) }),
  );

  // обратная связь: к каким задачам относится медиаплан, документ или встреча
  api.get(
    '/admin/api/linked-tasks',
    { schema: { querystring: { type: 'object', required: ['kind', 'ref'], properties: { kind: { type: 'string', enum: Object.keys(LINK_KINDS) }, ref: { type: 'integer' } } } } },
    async (req) => ({ tasks: crm.linkedTasks(req.query.kind, req.query.ref) }),
  );

  api.post(
    '/admin/api/tasks/:id/comments',
    { schema: { params: idParams, body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 5000 } } } } },
    async (req) => ({ comments: crm.addComment(req.params.id, req.body.text, req.user) }),
  );
}
