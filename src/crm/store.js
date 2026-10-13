// Клиенты агентства и задачи команды по ним. Смена статуса, исполнителя и срока
// записывается в ленту задачи — видно, кто что сделал, без отдельного журнала.

export class CrmError extends Error {}

export const TASK_STATUSES = {
  todo: 'К выполнению',
  doing: 'В работе',
  review: 'На проверке',
  done: 'Готово',
};
export const PRIORITIES = { 0: 'Обычная', 1: 'Срочная' };

// Готовые задачи на доске — только недавние, чтобы колонка не разрасталась
const DONE_DAYS = 14;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const text = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

export function createCrm({ db }) {
  const q = {
    clients: db.prepare(
      `SELECT c.*, u.name AS manager_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done') AS open_tasks,
              (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done' AND t.due < date('now', '+3 hours')) AS overdue
       FROM clients c LEFT JOIN admin_users u ON u.id = c.manager_id
       WHERE c.archived = ? ORDER BY c.name COLLATE NOCASE`,
    ),
    client: db.prepare('SELECT c.*, u.name AS manager_name FROM clients c LEFT JOIN admin_users u ON u.id = c.manager_id WHERE c.id = ?'),
    clientByLead: db.prepare('SELECT id FROM clients WHERE lead_id = ?'),
    insertClient: db.prepare('INSERT INTO clients (name, contact, phone, email, site, notes, manager_id, lead_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateClient: db.prepare("UPDATE clients SET name = ?, contact = ?, phone = ?, email = ?, site = ?, notes = ?, manager_id = ?, archived = ?, updated_at = datetime('now') WHERE id = ?"),
    deleteClient: db.prepare('DELETE FROM clients WHERE id = ?'),
    user: db.prepare('SELECT id, name FROM admin_users WHERE id = ? AND disabled = 0'),
    task: db.prepare(
      `SELECT t.*, c.name AS client_name, u.name AS assignee_name
       FROM tasks t LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN admin_users u ON u.id = t.assignee_id WHERE t.id = ?`,
    ),
    insertTask: db.prepare('INSERT INTO tasks (client_id, title, description, status, priority, assignee_id, due, created_by, created_by_id, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateTask: db.prepare(
      "UPDATE tasks SET client_id = ?, title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, due = ?, done_at = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
    comments: db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY id'),
    addComment: db.prepare('INSERT INTO task_comments (task_id, kind, text, author) VALUES (?, ?, ?, ?)'),
  };

  // ---------- клиенты ----------

  function getClient(id) {
    const c = q.client.get(Number(id));
    if (!c) throw new CrmError('Клиент не найден');
    return c;
  }

  function checkUser(id) {
    if (id == null) return null;
    if (!q.user.get(Number(id))) throw new CrmError('Сотрудник не найден или отключён');
    return Number(id);
  }

  function clientFields(v) {
    const name = text(v.name, 200);
    if (!name) throw new CrmError('Укажите название клиента');
    return [name, text(v.contact, 200), text(v.phone, 60), text(v.email, 200), text(v.site, 300), text(v.notes, 5000), checkUser(v.managerId)];
  }

  function createClient(v, user) {
    if (v.leadId && q.clientByLead.get(v.leadId)) throw new CrmError('По этой заявке клиент уже заведён');
    const { lastInsertRowid } = q.insertClient.run(...clientFields(v), v.leadId ?? null, user.name);
    return getClient(lastInsertRowid);
  }

  function updateClient(id, patch) {
    const c = getClient(id);
    const merged = {
      name: patch.name ?? c.name,
      contact: patch.contact !== undefined ? patch.contact : c.contact,
      phone: patch.phone !== undefined ? patch.phone : c.phone,
      email: patch.email !== undefined ? patch.email : c.email,
      site: patch.site !== undefined ? patch.site : c.site,
      notes: patch.notes !== undefined ? patch.notes : c.notes,
      managerId: patch.managerId !== undefined ? patch.managerId : c.manager_id,
    };
    q.updateClient.run(...clientFields(merged), patch.archived !== undefined ? Number(Boolean(patch.archived)) : c.archived, c.id);
    return getClient(id);
  }

  // ---------- задачи ----------

  function getTask(id) {
    const t = q.task.get(Number(id));
    if (!t) throw new CrmError('Задача не найдена');
    return t;
  }

  function checkTask(v) {
    const title = text(v.title, 300);
    if (!title) throw new CrmError('Напишите, что нужно сделать');
    if (!(v.status in TASK_STATUSES)) throw new CrmError('Неизвестный статус');
    if (v.due != null && !DATE_RE.test(v.due)) throw new CrmError('Срок — дата в формате ГГГГ-ММ-ДД');
    if (v.clientId != null) getClient(v.clientId);
    return {
      clientId: v.clientId == null ? null : Number(v.clientId),
      title,
      description: text(v.description, 10000),
      status: v.status,
      priority: v.priority ? 1 : 0,
      assigneeId: checkUser(v.assigneeId),
      due: v.due ?? null,
    };
  }

  function createTask(v, user) {
    const t = checkTask({ status: 'todo', ...v });
    const { lastInsertRowid } = q.insertTask.run(
      t.clientId, t.title, t.description, t.status, t.priority, t.assigneeId, t.due, user.name, user.id, t.status === 'done' ? now() : null,
    );
    return getTask(lastInsertRowid);
  }

  function updateTask(id, patch, user) {
    const cur = getTask(id);
    const next = checkTask({
      clientId: patch.clientId !== undefined ? patch.clientId : cur.client_id,
      title: patch.title ?? cur.title,
      description: patch.description !== undefined ? patch.description : cur.description,
      status: patch.status ?? cur.status,
      priority: patch.priority !== undefined ? patch.priority : cur.priority,
      assigneeId: patch.assigneeId !== undefined ? patch.assigneeId : cur.assignee_id,
      due: patch.due !== undefined ? patch.due : cur.due,
    });
    const doneAt = next.status === 'done' ? (cur.status === 'done' ? cur.done_at : now()) : null;
    db.exec('BEGIN');
    try {
      q.updateTask.run(next.clientId, next.title, next.description, next.status, next.priority, next.assigneeId, next.due, doneAt, cur.id);
      // лента изменений: статус, исполнитель, срок
      if (next.status !== cur.status) q.addComment.run(cur.id, 'event', `${TASK_STATUSES[cur.status]} → ${TASK_STATUSES[next.status]}`, user.name);
      if (next.assigneeId !== cur.assignee_id) {
        const who = next.assigneeId ? q.user.get(next.assigneeId).name : null;
        q.addComment.run(cur.id, 'event', who ? `Исполнитель: ${who}` : 'Исполнитель снят', user.name);
      }
      if (next.due !== cur.due) q.addComment.run(cur.id, 'event', next.due ? `Срок: ${fmtDate(next.due)}` : 'Срок снят', user.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return getTask(id);
  }

  function listTasks({ clientId = null, assigneeId = null, mine = null, q: search = '' } = {}) {
    const where = [`(t.status != 'done' OR t.done_at >= datetime('now', '-${DONE_DAYS} days'))`];
    const params = [];
    if (clientId === 'none') where.push('t.client_id IS NULL');
    else if (clientId) {
      where.push('t.client_id = ?');
      params.push(Number(clientId));
    }
    if (assigneeId === 'none') where.push('t.assignee_id IS NULL');
    else if (assigneeId) {
      where.push('t.assignee_id = ?');
      params.push(Number(assigneeId));
    }
    if (mine) {
      where.push('t.assignee_id = ?');
      params.push(Number(mine));
    }
    if (search) {
      where.push('(t.title LIKE ? OR t.description LIKE ? OR c.name LIKE ?)');
      const like = `%${search.replace(/[%_]/g, '')}%`;
      params.push(like, like, like);
    }
    return db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, t.due, t.client_id, t.assignee_id, t.updated_at, t.done_at,
                c.name AS client_name, u.name AS assignee_name,
                (SELECT COUNT(*) FROM task_comments k WHERE k.task_id = t.id AND k.kind = 'comment') AS comments
         FROM tasks t LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN admin_users u ON u.id = t.assignee_id
         WHERE ${where.join(' AND ')}
         ORDER BY t.priority DESC, t.due IS NULL, t.due, t.id DESC LIMIT 500`,
      )
      .all(...params);
  }

  /** Доски: клиенты в работе и «Внутренние» (задачи без клиента) — со счётчиками по статусам. */
  function boards(userId) {
    const stats = db
      .prepare(
        `SELECT client_id, status, COUNT(*) AS n,
                SUM(CASE WHEN status != 'done' AND due < date('now', '+3 hours') THEN 1 ELSE 0 END) AS overdue,
                SUM(CASE WHEN status != 'done' AND assignee_id = ? THEN 1 ELSE 0 END) AS mine
         FROM tasks WHERE status != 'done' OR done_at >= datetime('now', '-${DONE_DAYS} days')
         GROUP BY client_id, status`,
      )
      .all(userId);
    const empty = () => ({ counts: Object.fromEntries(Object.keys(TASK_STATUSES).map((s) => [s, 0])), overdue: 0, mine: 0 });
    const byClient = new Map();
    for (const r of stats) {
      const key = r.client_id ?? 'none';
      if (!byClient.has(key)) byClient.set(key, empty());
      const b = byClient.get(key);
      b.counts[r.status] = r.n;
      b.overdue += r.overdue;
      b.mine += r.mine;
    }
    const list = q.clients.all(0).map((c) => ({ id: c.id, name: c.name, manager_name: c.manager_name, lead_id: c.lead_id, ...(byClient.get(c.id) ?? empty()) }));
    return [...list, { id: 'none', name: 'Внутренние задачи', internal: true, manager_name: null, ...(byClient.get('none') ?? empty()) }];
  }

  return {
    boards,
    listClients: ({ archived = false } = {}) => q.clients.all(Number(archived)),
    getClient,
    createClient,
    updateClient,
    deleteClient: (id) => {
      getClient(id);
      q.deleteClient.run(Number(id));
    },
    clientTasks: (id) => listTasks({ clientId: id }),
    listTasks,
    getTask: (id) => ({ ...getTask(id), comments: q.comments.all(Number(id)) }),
    createTask,
    updateTask,
    deleteTask: (id, user) => {
      const t = getTask(id);
      if (user.role !== 'admin' && t.created_by_id !== user.id) throw new CrmError('Удалить задачу может её автор или администратор');
      q.deleteTask.run(t.id);
    },
    addComment: (id, body, user) => {
      getTask(id);
      const msg = text(body, 5000);
      if (!msg) throw new CrmError('Пустой комментарий');
      q.addComment.run(Number(id), 'comment', msg, user.name);
      return q.comments.all(Number(id));
    },
  };
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const fmtDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
