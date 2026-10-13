// Деньги по клиентам: абонентская плата за ведение (счёт на каждый месяц появляется сам),
// рекламные бюджеты и разовые работы; кто оплатил, кто должен; напоминания менеджеру клиента
// за 3 дня до срока и в день просрочки. Цифры вводят люди — система только считает и напоминает.

import { CrmError } from './store.js';

export const PAYMENT_KINDS = { fee: 'Ведение', budget: 'Рекламный бюджет', other: 'Разовые работы' };
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayMsk = (now = new Date()) => new Date(now.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
export const rub = (v) => `${Math.round(Number(v) || 0).toLocaleString('ru-RU')} ₽`;
const periodLabel = (p) => (p ? `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}` : '');

export function createMoney({ db, notify = null }) {
  const q = {
    client: db.prepare('SELECT id, name, manager_id, fee, pay_day, archived FROM clients WHERE id = ?'),
    setBilling: db.prepare('UPDATE clients SET fee = ?, pay_day = ? WHERE id = ?'),
    feeClients: db.prepare('SELECT id, fee, pay_day FROM clients WHERE archived = 0 AND fee > 0 AND pay_day BETWEEN 1 AND 31'),
    autoInsert: db.prepare("INSERT OR IGNORE INTO client_payments (client_id, kind, title, amount, period, due, auto, created_by) VALUES (?, 'fee', ?, ?, ?, ?, 1, 'Ассистент')"),
    insert: db.prepare('INSERT INTO client_payments (client_id, kind, title, amount, period, due, invoice, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT p.*, c.name AS client_name, c.manager_id FROM client_payments p JOIN clients c ON c.id = p.client_id WHERE p.id = ?'),
    update: db.prepare('UPDATE client_payments SET kind = ?, title = ?, amount = ?, due = ?, paid_at = ?, invoice = ?, note = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM client_payments WHERE id = ?'),
    list: db.prepare(
      `SELECT p.*, c.name AS client_name, c.manager_id, u.name AS manager_name FROM client_payments p
       JOIN clients c ON c.id = p.client_id LEFT JOIN admin_users u ON u.id = c.manager_id
       WHERE (? IS NULL OR p.client_id = ?) AND (? IS NULL OR c.manager_id = ?)
       ORDER BY p.paid_at IS NOT NULL, p.due IS NULL, p.due, p.id DESC LIMIT 500`,
    ),
    unpaidDue: db.prepare(
      `SELECT p.*, c.name AS client_name, c.manager_id FROM client_payments p JOIN clients c ON c.id = p.client_id
       WHERE p.paid_at IS NULL AND p.due IS NOT NULL AND p.due <= ?`,
    ),
    remind: db.prepare('UPDATE client_payments SET reminded = ? WHERE id = ?'),
    admins: db.prepare("SELECT id FROM admin_users WHERE role = 'admin' AND disabled = 0"),
  };

  const status = (p, today) => (p.paid_at ? 'paid' : p.due && p.due < today ? 'overdue' : 'open');
  const titleOf = (p) => p.title || `${PAYMENT_KINDS[p.kind] ?? 'Оплата'}${p.period ? ` за ${periodLabel(p.period)}` : ''}`;
  const view = (p, today) => ({ ...p, auto: Boolean(p.auto), status: status(p, today), label: titleOf(p) });

  /** Права: администратор видит всё; менеджер — своих клиентов. */
  const scope = (user) => (user.role === 'admin' ? null : user.id);
  function client(id, user) {
    const c = q.client.get(Number(id));
    if (!c) throw new CrmError('Клиент не найден');
    if (user && user.role !== 'admin' && c.manager_id !== user.id) throw new CrmError('Деньги клиента видит его менеджер и администратор');
    return c;
  }

  /** Счёт за ведение на текущий месяц — для всех клиентов с абонентской платой. */
  function ensureMonthly(now = new Date()) {
    const today = todayMsk(now);
    const period = today.slice(0, 7);
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (const c of q.feeClients.all()) {
      const due = `${period}-${String(Math.min(c.pay_day, last)).padStart(2, '0')}`;
      q.autoInsert.run(c.id, `Ведение за ${periodLabel(period)}`, c.fee, period, due);
    }
  }

  function list(user, { clientId = null, now = new Date() } = {}) {
    ensureMonthly(now);
    if (clientId) client(clientId, user);
    const today = todayMsk(now);
    const sc = scope(user);
    return q.list.all(clientId, clientId, sc, sc).map((p) => view(p, today));
  }

  /** Итоги: просрочено, ждём в этом месяце, получено в этом месяце. */
  function summary(user, now = new Date()) {
    const today = todayMsk(now);
    const month = today.slice(0, 7);
    const all = list(user, { now });
    const overdue = all.filter((p) => p.status === 'overdue');
    const expected = all.filter((p) => p.status === 'open' && p.due && p.due.slice(0, 7) <= month);
    const received = all.filter((p) => p.paid_at && p.paid_at.slice(0, 7) === month);
    const sum = (l) => l.reduce((a, p) => a + Number(p.amount), 0);
    const debtors = new Map();
    for (const p of overdue) debtors.set(p.client_id, { client_id: p.client_id, client_name: p.client_name, sum: (debtors.get(p.client_id)?.sum ?? 0) + Number(p.amount), days: Math.max(debtors.get(p.client_id)?.days ?? 0, Math.round((Date.parse(today) - Date.parse(p.due)) / 864e5)) });
    return {
      overdue: { sum: sum(overdue), count: overdue.length },
      expected: { sum: sum(expected), count: expected.length },
      received: { sum: sum(received), count: received.length },
      debtors: [...debtors.values()].sort((a, b) => b.sum - a.sum),
      soon: all.filter((p) => p.status === 'open' && p.due && p.due <= addDays(today, 7)).slice(0, 8),
    };
  }

  function checkFields(v, cur = null) {
    const kind = v.kind ?? cur?.kind ?? 'other';
    if (!(kind in PAYMENT_KINDS)) throw new CrmError('Неизвестный вид оплаты');
    const amount = v.amount !== undefined ? Number(v.amount) : Number(cur?.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10) throw new CrmError('Сумма — положительное число');
    const due = v.due !== undefined ? v.due : cur?.due ?? null;
    if (due != null && !DATE_RE.test(due)) throw new CrmError('Срок оплаты — дата ГГГГ-ММ-ДД');
    const str = (x, max) => (x == null ? null : String(x).trim().slice(0, max) || null);
    return {
      kind,
      title: v.title !== undefined ? str(v.title, 200) : cur?.title ?? null,
      amount: Math.round(amount * 100) / 100,
      due,
      invoice: v.invoice !== undefined ? str(v.invoice, 100) : cur?.invoice ?? null,
      note: v.note !== undefined ? str(v.note, 1000) : cur?.note ?? null,
    };
  }

  function add(clientId, v, user, now = new Date()) {
    const c = client(clientId, user);
    const f = checkFields(v);
    const period = v.period ?? (f.due ? f.due.slice(0, 7) : todayMsk(now).slice(0, 7));
    const { lastInsertRowid } = q.insert.run(c.id, f.kind, f.title, f.amount, period, f.due, f.invoice, f.note, user.name);
    const p = q.get.get(lastInsertRowid);
    if (v.paid) return update(p.id, { paid: true }, user, now);
    return view(p, todayMsk(now));
  }

  function update(id, v, user, now = new Date()) {
    const cur = q.get.get(Number(id));
    if (!cur) throw new CrmError('Оплата не найдена');
    client(cur.client_id, user);
    const f = checkFields(v, cur);
    const paidAt = v.paid === undefined ? cur.paid_at : v.paid ? cur.paid_at ?? (v.paidAt ?? todayMsk(now)) : null;
    q.update.run(f.kind, f.title, f.amount, f.due, paidAt, f.invoice, f.note, cur.id);
    return view(q.get.get(cur.id), todayMsk(now));
  }

  function remove(id, user) {
    const cur = q.get.get(Number(id));
    if (!cur) throw new CrmError('Оплата не найдена');
    client(cur.client_id, user);
    q.remove.run(cur.id);
  }

  function setBilling(clientId, { fee = null, payDay = null }, user) {
    const c = client(clientId, user);
    if (fee != null && !(Number(fee) >= 0)) throw new CrmError('Абонентская плата — число');
    if (payDay != null && !(Number.isInteger(Number(payDay)) && payDay >= 1 && payDay <= 31)) throw new CrmError('День оплаты — число от 1 до 31');
    q.setBilling.run(fee ? Number(fee) : null, payDay ? Number(payDay) : null, c.id);
    return q.client.get(c.id);
  }

  /** Напоминания менеджеру клиента (или администраторам): за 3 дня до срока и в день просрочки. */
  function remind(now = new Date()) {
    if (!notify) return 0;
    ensureMonthly(now);
    const today = todayMsk(now);
    let sent = 0;
    for (const p of q.unpaidDue.all(addDays(today, 3))) {
      const flags = new Set(p.reminded.split(',').filter(Boolean));
      const late = p.due < today;
      const flag = late ? 'overdue' : 'before';
      if (flags.has(flag)) continue;
      const to = p.manager_id ? [p.manager_id] : q.admins.all().map((a) => a.id);
      const text = late
        ? `Просрочена оплата: ${p.client_name} — ${rub(p.amount)}, ${titleOf(p).toLowerCase()}`
        : `Скоро оплата: ${p.client_name} — ${rub(p.amount)}, ${titleOf(p).toLowerCase()}, срок ${new Date(`${p.due}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
      for (const uid of to) notify.add(uid, { kind: 'payment', text, href: `#/client?id=${p.client_id}` });
      flags.add(flag);
      if (late) flags.add('before');
      q.remind.run([...flags].join(','), p.id);
      sent += 1;
    }
    return sent;
  }

  return { list, summary, add, update, remove, setBilling, ensureMonthly, remind, kinds: PAYMENT_KINDS };
}
