import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createAuth } from '../src/admin/auth.js';
import { createCrm } from '../src/crm/store.js';
import { createNotifications } from '../src/notify/store.js';
import { createMoney } from '../src/crm/money.js';

const msk = (s) => new Date(Date.parse(`${s}T12:00:00+03:00`));

function setup() {
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  const anna = auth.addUser('anna', 'Анна', { password: 'correct-horse-battery', role: 'admin' }).user;
  const oleg = auth.addUser('oleg', 'Олег', { password: 'correct-horse-battery' }).user;
  const ira = auth.addUser('ira', 'Ира', { password: 'correct-horse-battery' }).user;
  const crm = createCrm({ db: db.raw });
  const notify = createNotifications({ db: db.raw });
  const money = createMoney({ db: db.raw, notify });
  const talle = crm.createClient({ name: 'Таллер', managerId: oleg.id }, anna);
  const romashka = crm.createClient({ name: 'Ромашка', managerId: ira.id }, anna);
  return { crm, money, notify, anna, oleg, ira, talle, romashka };
}

test('деньги: счёт за ведение каждый месяц, оплаты, долг, права менеджера', () => {
  const { crm, money, anna, oleg, ira, talle, romashka } = setup();
  money.setBilling(talle.id, { fee: 80000, payDay: 10 }, oleg);
  assert.throws(() => money.setBilling(talle.id, { fee: 1 }, ira), /менеджер и администратор/, 'чужой клиент');

  let list = money.list(oleg, { clientId: talle.id, now: msk('2026-10-05') });
  assert.deepEqual(list.map((p) => [p.label, p.amount, p.due, p.status, p.auto]), [['Ведение за октябрь 2026', 80000, '2026-10-10', 'open', true]]);
  money.list(oleg, { clientId: talle.id, now: msk('2026-10-20') });
  assert.equal(money.list(oleg, { clientId: talle.id, now: msk('2026-10-20') }).length, 1, 'один счёт на месяц');
  assert.equal(money.list(oleg, { clientId: talle.id, now: msk('2026-10-20') })[0].status, 'overdue');

  // бюджет на рекламу и разовая работа
  const budget = money.add(talle.id, { kind: 'budget', amount: 300000, due: '2026-10-25' }, oleg, msk('2026-10-20'));
  money.add(romashka.id, { kind: 'other', title: 'Аудит РК', amount: 40000, due: '2026-10-15', paid: true }, ira, msk('2026-10-20'));
  assert.throws(() => money.add(romashka.id, { amount: 10 }, oleg), /менеджер/);
  assert.throws(() => money.add(talle.id, { amount: -5 }, oleg), /положительное/);

  let sum = money.summary(anna, msk('2026-10-20'));
  assert.deepEqual([sum.overdue.sum, sum.expected.sum, sum.received.sum], [80000, 300000, 40000]);
  assert.deepEqual(sum.debtors.map((d) => [d.client_name, d.sum, d.days]), [['Таллер', 80000, 10]]);
  assert.equal(money.summary(ira, msk('2026-10-20')).overdue.sum, 0, 'Ира видит только своих клиентов');
  assert.equal(crm.listClients().find((c) => c.id === talle.id).debt > 0, true, 'долг — в списке клиентов');

  const paid = money.update(list[0].id, { paid: true }, oleg, msk('2026-10-21'));
  assert.deepEqual([paid.status, paid.paid_at], ['paid', '2026-10-21']);
  sum = money.summary(anna, msk('2026-10-21'));
  assert.deepEqual([sum.overdue.sum, sum.received.sum], [0, 120000]);
  money.remove(budget.id, anna);
  assert.equal(money.list(anna, { clientId: talle.id, now: msk('2026-10-21') }).length, 1);
});

test('деньги: напоминания менеджеру за 3 дня и при просрочке — по одному разу', () => {
  const { money, notify, oleg, anna, talle } = setup();
  money.add(talle.id, { kind: 'budget', amount: 150000, due: '2026-10-15' }, oleg, msk('2026-10-10'));
  assert.equal(money.remind(msk('2026-10-10')), 0, 'рано');
  assert.equal(money.remind(msk('2026-10-12')), 1);
  assert.match(notify.list(oleg.id)[0].text, /^Скоро оплата: Таллер — 150\s000 ₽, рекламный бюджет/);
  assert.equal(money.remind(msk('2026-10-13')), 0, 'повторно не напоминаем');
  assert.equal(money.remind(msk('2026-10-16')), 1);
  assert.match(notify.list(oleg.id)[0].text, /^Просрочена оплата: Таллер/);
  assert.equal(money.remind(msk('2026-10-17')), 0);
  assert.equal(notify.list(anna.id).length, 0, 'у клиента есть менеджер — администратора не дёргаем');
});
