// API раздела «Задачи»: клиенты агентства, задачи команды, комментарии.
// Подключается внутри авторизованной части админки (req.user уже есть).

import { CrmError, TASK_STATUSES, PRIORITIES } from '../crm/store.js';
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
    status: { type: 'string', enum: Object.keys(TASK_STATUSES) },
    priority: { type: 'integer', enum: [0, 1] },
    assigneeId: nullableId,
    clientId: nullableId,
    due: { type: ['string', 'null'], maxLength: 10 },
  },
};

export async function crmRoutes(api, { crm, auth, db, scenarioSource }) {
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof CrmError) return reply.code(400).send({ error: err.message });
    throw err;
  });

  // Команда — для выбора исполнителя и ответственного (без логинов и ролей)
  api.get('/admin/api/team', async () => ({
    team: auth.listUsers().filter((u) => !u.disabled).map((u) => ({ id: u.id, name: u.name })),
    statuses: TASK_STATUSES,
    priorities: PRIORITIES,
  }));

  // Доски задач: клиенты в работе и «Внутренние»
  api.get('/admin/api/boards', async (req) => ({ boards: crm.boards(req.user.id), statuses: TASK_STATUSES }));

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
  }));

  api.put('/admin/api/clients/:id', { schema: { params: idParams, body: clientBody } }, async (req) => {
    const { fromLead: _, ...patch } = req.body;
    return { client: crm.updateClient(req.params.id, patch) };
  });

  api.delete('/admin/api/clients/:id', { schema: { params: idParams } }, async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Удалить клиента может администратор — остальные могут перенести его в архив' });
    crm.deleteClient(req.params.id);
    return { ok: true };
  });

  // ---------- задачи ----------

  api.get(
    '/admin/api/tasks',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { client: { type: 'string', pattern: '^(\\d+|none)$' }, assignee: { type: 'string', maxLength: 12 }, mine: { type: 'boolean' }, q: { type: 'string', maxLength: 100 } },
        },
      },
    },
    async (req) => ({
      tasks: crm.listTasks({ clientId: req.query.client, assigneeId: req.query.assignee, mine: req.query.mine ? req.user.id : null, q: req.query.q?.trim() }),
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

  api.post(
    '/admin/api/tasks/:id/comments',
    { schema: { params: idParams, body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', maxLength: 5000 } } } } },
    async (req) => ({ comments: crm.addComment(req.params.id, req.body.text, req.user) }),
  );
}
