import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createAuth } from '../src/admin/auth.js';
import { createCrm } from '../src/crm/store.js';
import { createNotifications } from '../src/notify/store.js';
import { createHotLeads, replyDeadline } from '../src/crm/hot-leads.js';

// время по Москве → момент UTC
const msk = (s) => new Date(Date.parse(`${s}:00+03:00`));

test('срок ответа на горячую заявку: 15 минут в рабочее время, иначе утро рабочего дня', () => {
  assert.deepEqual(replyDeadline(msk('2026-10-14T12:00')), { due: '2026-10-14', dueTime: '12:15' }, 'среда, день');
  assert.deepEqual(replyDeadline(msk('2026-10-14T19:50')), { due: '2026-10-15', dueTime: '09:15' }, 'вечер — следующее утро');
  assert.deepEqual(replyDeadline(msk('2026-10-14T07:30')), { due: '2026-10-14', dueTime: '09:15' }, 'раннее утро — сегодня в 9:15');
  assert.deepEqual(replyDeadline(msk('2026-10-16T22:00')), { due: '2026-10-19', dueTime: '09:15' }, 'пятница вечер — понедельник');
  assert.deepEqual(replyDeadline(msk('2026-10-17T12:00')), { due: '2026-10-19', dueTime: '09:15' }, 'суббота — понедельник');
});

test('горячая заявка: задача «Связаться», критичная, менеджеру с наименьшей загрузкой, с уведомлением', () => {
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  const anna = auth.addUser('anna', 'Анна', { password: 'correct-horse-battery', role: 'admin' }).user;
  const oleg = auth.addUser('oleg', 'Олег', { password: 'correct-horse-battery' }).user;
  const ira = auth.addUser('ira', 'Ира', { password: 'correct-horse-battery' }).user;
  const crm = createCrm({ db: db.raw });
  const notify = createNotifications({ db: db.raw });
  crm.useNotify(notify);
  crm.createTask({ title: 'Уже занят', assigneeId: oleg.id }, anna);
  const hot = createHotLeads({ db: db.raw, crm });

  const lead = { id: 7, rating: 5, answers: { company: { raw: 'Глобал Стекло' }, name: { raw: 'Мария' }, contact: { raw: '+7 900 000-00-00' } }, meta: {} };
  const t = hot.onLead(lead, msk('2026-10-14T12:00'));
  assert.equal(t.title, 'Связаться: горячая заявка №7 — Глобал Стекло');
  assert.deepEqual([t.priority, t.due, t.due_time, t.assignee_id], [4, '2026-10-14', '12:15', ira.id], 'Ира свободнее Олега');
  assert.match(t.description, /#\/leads\?lead=7/);
  assert.match(t.description, /Мария, \+7 900/);
  assert.match(notify.list(ira.id)[0].text, /^Вам поручена задача «Связаться: горячая заявка №7/);

  assert.equal(hot.onLead({ ...lead, id: 8, rating: 3 }), null, 'тёплая — без задачи');
  assert.equal(hot.onLead({ ...lead, id: 9, is_test: 1 }), null, 'тестовая — без задачи');
  assert.equal(hot.onLead({ ...lead, id: 10 }, msk('2026-10-14T12:05')).assignee_id, oleg.id, 'следующая — тому, кто теперь свободнее');
});
