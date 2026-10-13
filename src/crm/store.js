// Клиенты агентства и задачи команды — по логике YouGile: проект (клиент или «Общие задачи")
// → доски проекта → колонки доски (свои названия и цвета) → задачи. Перенос между колонками,
// смена исполнителя и срока, отметка «выполнено» записываются в ленту задачи.

export class CrmError extends Error {}

// Важность — стикер на карточке, как в YouGile; 0 — не задана
export const PRIORITIES = { 0: 'Не задана', 1: 'Низкая', 2: 'Средняя', 3: 'Высокая', 4: 'Критичная' };
// Цвета колонок — ключи, а не произвольные значения: цвет задаёт CSS по ключу
export const COLUMN_COLORS = {
  gray: 'Серый',
  cyan: 'Бирюзовый',
  teal: 'Морской',
  green: 'Зелёный',
  amber: 'Жёлтый',
  orange: 'Оранжевый',
  red: 'Красный',
  violet: 'Фиолетовый',
};
export const DEFAULT_COLUMNS = [
  { name: 'К выполнению', color: 'gray', isDone: false },
  { name: 'В работе', color: 'orange', isDone: false },
  { name: 'На проверке', color: 'violet', isDone: false },
  { name: 'Готово', color: 'green', isDone: true },
];
const LIMITS = { boards: 20, columns: 12 };
// что можно привязать к задаче — результат работы по ней
export const LINK_KINDS = { mediaplan: 'Медиаплан', document: 'Документ', meeting: 'Встреча' };

// Выполненные задачи на доске — только недавние, чтобы колонки не разрастались
const DONE_DAYS = 14;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Просрочено: срок с временем прошёл по Москве; без времени — срок до конца дня
const OVERDUE = "(due || ' ' || COALESCE(due_time, '23:59')) < strftime('%Y-%m-%d %H:%M', 'now', '+3 hours')";

const text = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

export function createCrm({ db }) {
  const TASK_COLS = `t.*, c.name AS client_name, u.name AS assignee_name,
                     col.name AS column_name, col.color AS column_color, col.is_done AS column_done,
                     col.board_id AS board_id, b.name AS board_name`;
  const TASK_JOINS = `FROM tasks t
       LEFT JOIN clients c ON c.id = t.client_id
       LEFT JOIN admin_users u ON u.id = t.assignee_id
       LEFT JOIN task_columns col ON col.id = t.column_id
       LEFT JOIN task_boards b ON b.id = col.board_id`;
  const q = {
    clients: db.prepare(
      `SELECT c.*, u.name AS manager_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done') AS open_tasks,
              (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done' AND ${OVERDUE.replace(/due/g, 't.due')}) AS overdue
       FROM clients c LEFT JOIN admin_users u ON u.id = c.manager_id
       WHERE c.archived = ? ORDER BY c.name COLLATE NOCASE`,
    ),
    client: db.prepare('SELECT c.*, u.name AS manager_name FROM clients c LEFT JOIN admin_users u ON u.id = c.manager_id WHERE c.id = ?'),
    clientByLead: db.prepare('SELECT id FROM clients WHERE lead_id = ?'),
    insertClient: db.prepare('INSERT INTO clients (name, contact, phone, email, site, notes, manager_id, lead_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateClient: db.prepare("UPDATE clients SET name = ?, contact = ?, phone = ?, email = ?, site = ?, notes = ?, manager_id = ?, archived = ?, updated_at = datetime('now') WHERE id = ?"),
    deleteClient: db.prepare('DELETE FROM clients WHERE id = ?'),
    user: db.prepare('SELECT id, name FROM admin_users WHERE id = ? AND disabled = 0'),
    team: db.prepare('SELECT id, name FROM admin_users WHERE disabled = 0'),
    // доски и колонки
    boards: db.prepare('SELECT * FROM task_boards WHERE client_id IS ? ORDER BY position, id'),
    board: db.prepare('SELECT * FROM task_boards WHERE id = ?'),
    insertBoard: db.prepare('INSERT INTO task_boards (client_id, name, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM task_boards WHERE client_id IS ?))'),
    renameBoard: db.prepare('UPDATE task_boards SET name = ? WHERE id = ?'),
    setBoardPos: db.prepare('UPDATE task_boards SET position = ? WHERE id = ?'),
    deleteBoard: db.prepare('DELETE FROM task_boards WHERE id = ?'),
    columns: db.prepare(
      `SELECT col.*, (SELECT COUNT(*) FROM tasks t WHERE t.column_id = col.id) AS tasks
       FROM task_columns col WHERE col.board_id = ? ORDER BY col.position, col.id`,
    ),
    column: db.prepare('SELECT col.*, b.client_id, b.name AS board_name FROM task_columns col JOIN task_boards b ON b.id = col.board_id WHERE col.id = ?'),
    insertColumn: db.prepare('INSERT INTO task_columns (board_id, name, color, is_done, position) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM task_columns WHERE board_id = ?))'),
    updateColumn: db.prepare('UPDATE task_columns SET name = ?, color = ?, is_done = ? WHERE id = ?'),
    setColumnPos: db.prepare('UPDATE task_columns SET position = ? WHERE id = ?'),
    deleteColumn: db.prepare('DELETE FROM task_columns WHERE id = ?'),
    columnTasks: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE column_id = ?'),
    boardTasks: db.prepare('SELECT COUNT(*) AS n FROM tasks t JOIN task_columns col ON col.id = t.column_id WHERE col.board_id = ?'),
    adopt: db.prepare('UPDATE tasks SET column_id = ? WHERE column_id IS NULL AND client_id IS ?'),
    markColumn: db.prepare(
      "UPDATE tasks SET status = ?, done_at = CASE WHEN ? = 'done' THEN COALESCE(done_at, datetime('now')) ELSE NULL END, updated_at = datetime('now') WHERE column_id = ? AND status != ?",
    ),
    // задачи
    task: db.prepare(`SELECT ${TASK_COLS} ${TASK_JOINS} WHERE t.id = ?`),
    insertTask: db.prepare('INSERT INTO tasks (client_id, column_id, title, description, status, priority, assignee_id, due, due_time, created_by, created_by_id, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    updateTask: db.prepare(
      "UPDATE tasks SET client_id = ?, column_id = ?, title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, due = ?, due_time = ?, done_at = ?, updated_at = datetime('now') WHERE id = ?",
    ),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
    comments: db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY id'),
    // связи задачи: название берётся из самого медиаплана, документа или встречи; удалённые не показываются
    links: db.prepare(
      `SELECT l.id, l.kind, l.ref_id,
              COALESCE(mp.title, d.title, m.title) AS title, m.starts_at AS starts_at
       FROM task_links l
       LEFT JOIN mediaplans mp ON l.kind = 'mediaplan' AND mp.id = l.ref_id
       LEFT JOIN documents d ON l.kind = 'document' AND d.id = l.ref_id
       LEFT JOIN meetings m ON l.kind = 'meeting' AND m.id = l.ref_id
       WHERE l.task_id = ? AND COALESCE(mp.id, d.id, m.id) IS NOT NULL ORDER BY l.id`,
    ),
    addLink: db.prepare('INSERT OR IGNORE INTO task_links (task_id, kind, ref_id) VALUES (?, ?, ?)'),
    link: db.prepare('SELECT * FROM task_links WHERE id = ? AND task_id = ?'),
    deleteLink: db.prepare('DELETE FROM task_links WHERE id = ?'),
    linkedTasks: db.prepare(
      `SELECT t.id, t.title, t.status, t.due, t.due_time, t.client_id, c.name AS client_name, u.name AS assignee_name
       FROM task_links l JOIN tasks t ON t.id = l.task_id
       LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN admin_users u ON u.id = t.assignee_id
       WHERE l.kind = ? AND l.ref_id = ? ORDER BY t.id`,
    ),
    refExists: {
      mediaplan: db.prepare('SELECT title FROM mediaplans WHERE id = ?'),
      document: db.prepare('SELECT title FROM documents WHERE id = ?'),
      meeting: db.prepare('SELECT title FROM meetings WHERE id = ?'),
    },
    addComment: db.prepare('INSERT INTO task_comments (task_id, kind, text, author) VALUES (?, ?, ?, ?)'),
  };

  // уведомления в кабинете подключаются снаружи (crm.useNotify) — без них задачи работают как раньше
  let notify = null;
  const taskHref = (t) => `#/tasks?project=${t.client_id ?? 'none'}&task=${t.id}`;
  const label = (t) => `«${t.title}»${t.client_name ? ` — ${t.client_name}` : ''}`;
  const tell = (userId, t, kind, text, user) => notify?.add(userId, { kind, text, href: taskHref(t), actor: user.name, actorId: user.id });

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

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

  // ---------- проекты, доски, колонки ----------

  /** id проекта: число — клиент, null — «Общие задачи». */
  const projectId = (v) => (v == null || v === 'none' ? null : Number(v));

  function checkProject(clientId) {
    if (clientId != null) getClient(clientId);
    return clientId;
  }

  function addBoard(clientId, name) {
    const { lastInsertRowid } = q.insertBoard.run(clientId, name, clientId);
    for (const c of DEFAULT_COLUMNS) q.insertColumn.run(lastInsertRowid, c.name, c.color, Number(c.isDone), lastInsertRowid);
    return Number(lastInsertRowid);
  }

  /** Доски проекта; у проекта всегда есть хотя бы одна. Задачи без колонки (клиента удалили,
   *  задачу перенесли из другого места) попадают в первую колонку первой доски. */
  function ensureBoards(clientId) {
    let list = q.boards.all(clientId);
    if (!list.length) {
      addBoard(clientId, 'Задачи');
      list = q.boards.all(clientId);
    }
    const first = q.columns.all(list[0].id)[0];
    if (first) q.adopt.run(first.id, clientId);
    return list;
  }

  function getBoard(id) {
    const b = q.board.get(Number(id));
    if (!b) throw new CrmError('Доска не найдена');
    return b;
  }

  function getColumn(id) {
    const c = q.column.get(Number(id));
    if (!c) throw new CrmError('Колонка не найдена');
    return c;
  }

  const boardWithColumns = (b) => ({ id: b.id, client_id: b.client_id, name: b.name, columns: q.columns.all(b.id) });

  function projectBoards(key) {
    const clientId = checkProject(projectId(key));
    return tx(() => ensureBoards(clientId)).map(boardWithColumns);
  }

  /** Список проектов: клиенты в работе и «Общие задачи» — со счётчиками открытых, просроченных и моих. */
  function projects(userId) {
    const stats = db
      .prepare(
        `SELECT client_id, COUNT(*) AS open,
                SUM(CASE WHEN ${OVERDUE} THEN 1 ELSE 0 END) AS overdue,
                SUM(CASE WHEN assignee_id = ? THEN 1 ELSE 0 END) AS mine
         FROM tasks WHERE status != 'done' GROUP BY client_id`,
      )
      .all(userId);
    const by = new Map(stats.map((r) => [r.client_id ?? 'none', r]));
    const counts = (key) => {
      const r = by.get(key);
      return { open: r?.open ?? 0, overdue: r?.overdue ?? 0, mine: r?.mine ?? 0 };
    };
    return [
      ...q.clients.all(0).map((c) => ({ id: c.id, name: c.name, manager_name: c.manager_name, lead_id: c.lead_id, ...counts(c.id) })),
      { id: 'none', name: 'Общие задачи', internal: true, manager_name: null, ...counts('none') },
    ];
  }

  function createBoard({ clientId, name }) {
    const cid = checkProject(projectId(clientId));
    const title = text(name, 100);
    if (!title) throw new CrmError('Назовите доску');
    if (q.boards.all(cid).length >= LIMITS.boards) throw new CrmError(`В проекте не больше ${LIMITS.boards} досок`);
    return boardWithColumns(getBoard(tx(() => addBoard(cid, title))));
  }

  /** Сдвиг доски или колонки на одно место: меняемся позициями с соседом. */
  function shift(list, id, dir, setPos) {
    const i = list.findIndex((x) => x.id === id);
    const j = i + Math.sign(dir);
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, k) => setPos.run(k, x.id));
  }

  function updateBoard(id, { name, move }) {
    const b = getBoard(id);
    tx(() => {
      if (name !== undefined) {
        const title = text(name, 100);
        if (!title) throw new CrmError('Назовите доску');
        q.renameBoard.run(title, b.id);
      }
      if (move) shift(q.boards.all(b.client_id), b.id, move, q.setBoardPos);
    });
    return boardWithColumns(getBoard(id));
  }

  function deleteBoard(id) {
    const b = getBoard(id);
    if (q.boards.all(b.client_id).length <= 1) throw new CrmError('Это единственная доска проекта');
    if (q.boardTasks.get(b.id).n) throw new CrmError('На доске есть задачи — перенесите или удалите их');
    q.deleteBoard.run(b.id);
  }

  function columnFields(v, cur = {}) {
    const name = text(v.name ?? cur.name, 60);
    if (!name) throw new CrmError('Назовите колонку');
    const color = v.color ?? cur.color ?? 'gray';
    if (!(color in COLUMN_COLORS)) throw new CrmError('Неизвестный цвет');
    const isDone = v.isDone !== undefined ? Boolean(v.isDone) : Boolean(cur.is_done);
    return { name, color, isDone };
  }

  function createColumn(boardId, v) {
    const b = getBoard(boardId);
    if (q.columns.all(b.id).length >= LIMITS.columns) throw new CrmError(`На доске не больше ${LIMITS.columns} колонок`);
    const c = columnFields(v);
    const { lastInsertRowid } = q.insertColumn.run(b.id, c.name, c.color, Number(c.isDone), b.id);
    return q.columns.all(b.id).find((x) => x.id === Number(lastInsertRowid));
  }

  function updateColumn(id, v) {
    const cur = getColumn(id);
    const c = columnFields(v, cur);
    tx(() => {
      q.updateColumn.run(c.name, c.color, Number(c.isDone), cur.id);
      // «Задачи здесь выполнены»: отметка колонки переносится на её задачи
      if (c.isDone !== Boolean(cur.is_done)) {
        const status = c.isDone ? 'done' : 'todo';
        q.markColumn.run(status, status, cur.id, status);
      }
      if (v.move) shift(q.columns.all(cur.board_id), cur.id, v.move, q.setColumnPos);
    });
    return q.columns.all(cur.board_id).find((x) => x.id === cur.id);
  }

  function deleteColumn(id) {
    const c = getColumn(id);
    if (q.columns.all(c.board_id).length <= 1) throw new CrmError('Это единственная колонка доски');
    if (q.columnTasks.get(c.id).n) throw new CrmError('В колонке есть задачи — перенесите их в другую');
    q.deleteColumn.run(c.id);
  }

  // ---------- задачи ----------

  function getTask(id) {
    const t = q.task.get(Number(id));
    if (!t) throw new CrmError('Задача не найдена');
    return t;
  }

  /** Куда положить задачу: колонка, доска (её первая колонка) или проект (первая колонка первой доски). */
  function placeTask({ columnId, boardId, clientId }) {
    if (columnId != null) return getColumn(columnId);
    if (boardId != null) {
      const first = q.columns.all(getBoard(boardId).id)[0];
      if (!first) throw new CrmError('На доске нет колонок');
      return getColumn(first.id);
    }
    const cid = checkProject(projectId(clientId));
    const board = ensureBoards(cid)[0];
    return getColumn(q.columns.all(board.id)[0].id);
  }

  function checkTask(v) {
    const title = text(v.title, 300);
    if (!title) throw new CrmError('Напишите, что нужно сделать');
    if (v.due != null && !DATE_RE.test(v.due)) throw new CrmError('Срок — дата в формате ГГГГ-ММ-ДД');
    if (v.dueTime != null && !TIME_RE.test(v.dueTime)) throw new CrmError('Время срока — ЧЧ:ММ');
    if (v.dueTime != null && v.due == null) throw new CrmError('Время срока задаётся вместе с датой');
    if (v.priority != null && !(v.priority in PRIORITIES)) throw new CrmError('Неизвестная важность');
    return {
      title,
      description: text(v.description, 10000),
      priority: Number(v.priority ?? 0),
      assigneeId: checkUser(v.assigneeId),
      due: v.due ?? null,
      dueTime: v.due == null ? null : v.dueTime ?? null,
    };
  }

  function createTask(v, user) {
    const t = checkTask(v);
    return tx(() => {
      const col = placeTask(v);
      const done = Boolean(col.is_done || v.done);
      const { lastInsertRowid } = q.insertTask.run(
        col.client_id, col.id, t.title, t.description, done ? 'done' : 'todo', t.priority, t.assigneeId, t.due, t.dueTime, user.name, user.id, done ? now() : null,
      );
      const created = getTask(lastInsertRowid);
      if (created.assignee_id) tell(created.assignee_id, created, 'task_assigned', `Вам поручена задача ${label(created)}`, user);
      return created;
    });
  }

  function updateTask(id, patch, user) {
    const cur = getTask(id);
    const next = checkTask({
      title: patch.title ?? cur.title,
      description: patch.description !== undefined ? patch.description : cur.description,
      priority: patch.priority !== undefined ? patch.priority : cur.priority,
      assigneeId: patch.assigneeId !== undefined ? patch.assigneeId : cur.assignee_id,
      due: patch.due !== undefined ? patch.due : cur.due,
      // снятый срок снимает и время; новая дата без времени сохраняет прежнее время
      dueTime: patch.dueTime !== undefined ? patch.dueTime : patch.due === null ? null : cur.due_time,
    });
    tx(() => {
      // перенос: в колонку, на доску или в другой проект
      let col = cur.column_id ? getColumn(cur.column_id) : placeTask({ clientId: cur.client_id });
      const from = col;
      if (patch.columnId != null || patch.boardId != null) col = placeTask(patch);
      else if (patch.clientId !== undefined && projectId(patch.clientId) !== cur.client_id) col = placeTask({ clientId: patch.clientId });
      const moved = col.id !== from.id;

      let done = cur.status === 'done';
      if (moved && col.is_done) done = true;
      else if (moved && from.is_done) done = false;
      if (patch.done !== undefined) done = Boolean(patch.done);
      const wasDone = cur.status === 'done';
      const doneAt = done ? (wasDone ? cur.done_at : now()) : null;

      q.updateTask.run(col.client_id, col.id, next.title, next.description, done ? 'done' : 'todo', next.priority, next.assigneeId, next.due, next.dueTime, doneAt, cur.id);
      // лента изменений: перенос, выполнение, исполнитель, срок
      if (moved) {
        const where = col.board_id !== from.board_id || col.client_id !== from.client_id ? `${col.board_name}: ${col.name}` : col.name;
        q.addComment.run(cur.id, 'event', `${from.name} → ${where}`, user.name);
      }
      if (done !== wasDone) q.addComment.run(cur.id, 'event', done ? 'Выполнена' : 'Снова в работе', user.name);
      if (next.assigneeId !== cur.assignee_id) {
        const who = next.assigneeId ? q.user.get(next.assigneeId).name : null;
        q.addComment.run(cur.id, 'event', who ? `Исполнитель: ${who}` : 'Исполнитель снят', user.name);
      }
      if (next.due !== cur.due || next.dueTime !== cur.due_time) {
        q.addComment.run(cur.id, 'event', next.due ? `Срок: ${fmtDate(next.due)}${next.dueTime ? `, ${next.dueTime}` : ''}` : 'Срок снят', user.name);
      }
      if (next.priority !== cur.priority) q.addComment.run(cur.id, 'event', next.priority ? `Важность: ${PRIORITIES[next.priority]}` : 'Важность снята', user.name);
    });
    const t = getTask(id);
    if (next.assigneeId && next.assigneeId !== cur.assignee_id) tell(next.assigneeId, t, 'task_assigned', `Вам поручена задача ${label(t)}`, user);
    if (t.status === 'done' && cur.status !== 'done') {
      for (const uid of new Set([cur.created_by_id, cur.assignee_id])) tell(uid, t, 'task_done', `Выполнена задача ${label(t)}`, user);
    }
    return t;
  }

  /** Привязать к задаче медиаплан, документ или встречу; событие пишется в историю задачи. */
  function linkTask(taskId, { kind, refId }, user) {
    const t = getTask(taskId);
    if (!(kind in LINK_KINDS)) throw new CrmError('Неизвестный вид связи');
    const ref = q.refExists[kind].get(Number(refId));
    if (!ref) throw new CrmError(`${LINK_KINDS[kind]} не найден`);
    const { changes } = q.addLink.run(t.id, kind, Number(refId));
    if (changes) q.addComment.run(t.id, 'event', `${LINK_KINDS[kind]}: «${ref.title}»`, user.name);
    return q.links.all(t.id);
  }

  function listTasks({ boardId = null, clientId = null, assigneeId = null, mine = null, q: search = '', open = false } = {}) {
    const where = [open ? "t.status != 'done'" : `(t.status != 'done' OR t.done_at >= datetime('now', '-${DONE_DAYS} days'))`];
    const params = [];
    if (boardId) {
      where.push('col.board_id = ?');
      params.push(Number(boardId));
    }
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
        `SELECT t.id, t.title, t.status, t.priority, t.due, t.due_time, t.client_id, t.created_by_id, t.column_id, t.assignee_id, t.updated_at, t.done_at,
                c.name AS client_name, u.name AS assignee_name,
                col.name AS column_name, col.color AS column_color, col.board_id AS board_id, b.name AS board_name,
                (SELECT COUNT(*) FROM task_comments k WHERE k.task_id = t.id AND k.kind = 'comment') AS comments,
                (SELECT COUNT(*) FROM task_links l WHERE l.task_id = t.id) AS links
         ${TASK_JOINS}
         WHERE ${where.join(' AND ')}
         ORDER BY t.status = 'done', t.priority DESC, t.due IS NULL, t.due, t.due_time IS NULL, t.due_time, t.id DESC LIMIT 500`,
      )
      .all(...params);
  }

  return {
    projects,
    projectBoards,
    createBoard,
    updateBoard,
    deleteBoard,
    createColumn,
    updateColumn,
    deleteColumn,
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
    getTask: (id) => ({ ...getTask(id), comments: q.comments.all(Number(id)), links: q.links.all(Number(id)) }),
    linkTask,
    unlinkTask: (taskId, linkId) => {
      const l = q.link.get(Number(linkId), Number(taskId));
      if (!l) throw new CrmError('Связь не найдена');
      q.deleteLink.run(l.id);
      return q.links.all(Number(taskId));
    },
    /** Задачи, к которым привязан медиаплан, документ или встреча. */
    linkedTasks: (kind, refId) => {
      if (!(kind in LINK_KINDS)) throw new CrmError('Неизвестный вид связи');
      return q.linkedTasks.all(kind, Number(refId));
    },
    createTask,
    updateTask,
    deleteTask: (id, user) => {
      const t = getTask(id);
      if (user.role !== 'admin' && t.created_by_id !== user.id) throw new CrmError('Удалить задачу может её автор или администратор');
      q.deleteTask.run(t.id);
    },
    addComment: (id, body, user) => {
      const t = getTask(id);
      const msg = text(body, 5000);
      if (!msg) throw new CrmError('Пустой комментарий');
      q.addComment.run(Number(id), 'comment', msg, user.name);
      if (notify) {
        const short = msg.length > 140 ? `${msg.slice(0, 140)}…` : msg;
        // упоминания «@Даниил» — по имени сотрудника в любом падеже
        const mentioned = new Set();
        for (const m of msg.matchAll(/@([A-Za-zА-Яа-яЁё]{2,})/g)) {
          const word = m[1].toLowerCase();
          for (const u of q.team.all()) {
            const first = u.name.split(/\s+/)[0].toLowerCase();
            const base = first.length > 4 ? first.slice(0, -1) : first;
            if (word.startsWith(base)) mentioned.add(u.id);
          }
        }
        for (const uid of mentioned) tell(uid, t, 'mention', `Вас упомянули в задаче ${label(t)}: ${short}`, user);
        for (const uid of new Set([t.assignee_id, t.created_by_id])) if (uid && !mentioned.has(uid)) tell(uid, t, 'comment', `Комментарий к задаче ${label(t)}: ${short}`, user);
      }
      return q.comments.all(Number(id));
    },
    useNotify: (n) => {
      notify = n;
    },
  };
}

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const fmtDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
