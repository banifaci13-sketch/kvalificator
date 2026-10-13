// Деньги по клиентам: абонентская плата за ведение, счета, оплаты и долги.
// Вкладка «Оплаты» в «Задачах» и блок «Деньги» в карточке клиента.

import { h, api, app, shell, toast, confirmDialog, navigate, ctx, icon } from './admin.js';
import { fill, formDialog } from './docs.js';

const STATUS = { overdue: 'Просрочено', open: 'Ждём', paid: 'Оплачено' };
const KINDS = { fee: 'Ведение', budget: 'Рекламный бюджет', other: 'Разовые работы' };
export const rub = (v) => `${Math.round(Number(v) || 0).toLocaleString('ru-RU')} ₽`;
const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
const todayIso = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const parseSum = (s) => Number(String(s ?? '').replace(/[\s ₽]/g, '').replace(',', '.'));

/** Окно «Новый счёт / оплата»; clients — для выбора клиента, если он не задан. */
function paymentDialog({ clientId = null, clients = [], payment = null, onSaved }) {
  const client = clientId ? null : h('select', { class: 'select', id: 'pm-client', required: true }, h('option', { value: '' }, 'Выберите клиента'), clients.map((c) => h('option', { value: c.id }, c.name)));
  const kind = h('select', { class: 'select', id: 'pm-kind' }, Object.entries(KINDS).map(([k, l]) => h('option', { value: k, selected: k === (payment?.kind ?? 'other') }, l)));
  const amount = h('input', { class: 'input num', id: 'pm-amount', inputmode: 'decimal', required: true, value: payment ? String(payment.amount) : '', placeholder: '50 000' });
  const due = h('input', { class: 'input', id: 'pm-due', type: 'date', value: payment?.due ?? '' });
  const title = h('input', { class: 'input', id: 'pm-title', maxlength: 200, value: payment?.title ?? '', placeholder: 'Например: Ведение за октябрь' });
  const invoice = h('input', { class: 'input', id: 'pm-invoice', maxlength: 100, value: payment?.invoice ?? '', placeholder: '№ счёта' });
  const paid = h('input', { type: 'checkbox', checked: Boolean(payment?.paid_at) });
  const row = (id, label, el) => h('div', { class: 'field' }, h('label', { for: id }, label), el);
  formDialog({
    title: payment ? 'Изменить оплату' : 'Новый счёт',
    submitLabel: 'Сохранить',
    body: [
      h('div', { class: 'dialog-grid' },
        client ? row('pm-client', 'Клиент', client) : null,
        row('pm-kind', 'За что', kind),
        row('pm-amount', 'Сумма, ₽', amount),
        row('pm-due', 'Срок оплаты', due),
        row('pm-title', 'Название', title),
        row('pm-invoice', 'Счёт', invoice),
      ),
      h('label', { class: 'check' }, paid, 'Уже оплачено'),
    ],
    onSubmit: async () => {
      const sum = parseSum(amount.value);
      if (!(sum > 0)) throw new Error('Укажите сумму');
      const body = { kind: kind.value, amount: sum, due: due.value || null, title: title.value.trim() || null, invoice: invoice.value.trim() || null, paid: paid.checked };
      if (payment) await api(`/admin/api/payments/${payment.id}`, { method: 'PATCH', body });
      else {
        const cid = clientId ?? Number(client.value);
        if (!cid) throw new Error('Выберите клиента');
        await api(`/admin/api/clients/${cid}/payments`, { method: 'POST', body });
      }
      toast('Сохранено');
      onSaved();
    },
  });
}

function paymentRows(list, { reload, showClient = false }) {
  const pay = async (p, value) => {
    try {
      await api(`/admin/api/payments/${p.id}`, { method: 'PATCH', body: { paid: value } });
      toast(value ? `Оплата ${rub(p.amount)} отмечена` : 'Отметка об оплате снята');
      reload();
    } catch (err) {
      toast(err.message);
    }
  };
  return h(
    'ul',
    { class: 'pay-list' },
    list.map((p) =>
      h(
        'li',
        { class: `pay-row s-${p.status}` },
        h('span', { class: `pay-status s-${p.status}` }, STATUS[p.status]),
        h(
          'div',
          { class: 'pay-main' },
          h('strong', {}, showClient ? h('a', { href: `#/client?id=${p.client_id}` }, p.client_name) : p.label),
          h('span', { class: 'muted small' }, [showClient ? p.label : null, p.invoice ? `счёт ${p.invoice}` : null, p.paid_at ? `оплачено ${day(p.paid_at)}` : p.due ? `срок ${day(p.due)}` : 'без срока'].filter(Boolean).join(' · ')),
        ),
        h('b', { class: 'pay-sum num' }, rub(p.amount)),
        p.status === 'paid'
          ? h('button', { type: 'button', class: 'btn btn-s', onclick: () => pay(p, false) }, 'Снять оплату')
          : h('button', { type: 'button', class: 'btn btn-s btn-primary', onclick: () => pay(p, true) }, 'Оплачено'),
        h('details', { class: 'menu' },
          h('summary', { class: 'icon-btn', 'aria-label': 'Действия', title: 'Действия' }, '⋮'),
          h('div', { class: 'menu-list', role: 'menu' },
            h('button', { type: 'button', role: 'menuitem', onclick: (e) => (e.target.closest('details').removeAttribute('open'), paymentDialog({ clientId: p.client_id, payment: p, onSaved: reload })) }, 'Изменить'),
            h('button', {
              type: 'button', role: 'menuitem', class: 'danger',
              onclick: async (e) => {
                e.target.closest('details').removeAttribute('open');
                if (!(await confirmDialog(`Удалить «${p.label}» на ${rub(p.amount)}?`))) return;
                await api(`/admin/api/payments/${p.id}`, { method: 'DELETE' }).catch((err) => toast(err.message));
                reload();
              },
            }, 'Удалить'),
          ),
        ),
      ),
    ),
  );
}

/** Блок «Деньги» в карточке клиента. */
export function clientMoney(client) {
  const box = h('div', { class: 'client-money' }, h('h2', {}, 'Деньги'), h('p', { class: 'muted small' }, 'Загружаю…'));
  async function load() {
    let data;
    try {
      data = await api(`/admin/api/money?client=${client.id}`);
    } catch (err) {
      // деньги клиента видит его менеджер и администратор — остальным блок не показываем
      if (err.status === 400) return box.remove();
      return fill(box, h('h2', {}, 'Деньги'), h('p', { class: 'error' }, err.message));
    }
    const fee = h('input', { class: 'input num', id: 'cm-fee', inputmode: 'decimal', value: client.fee ? String(client.fee) : '', placeholder: 'нет' });
    const payDay = h('input', { class: 'input num', id: 'cm-day', type: 'number', min: 1, max: 31, value: client.pay_day ?? '', placeholder: '10' });
    const saveBilling = async () => {
      const f = fee.value.trim() ? parseSum(fee.value) : null;
      const d = payDay.value ? Number(payDay.value) : null;
      if (f != null && !(f >= 0)) return toast('Абонентская плата — число');
      try {
        const res = await api(`/admin/api/clients/${client.id}/billing`, { method: 'PATCH', body: { fee: f, payDay: d } });
        Object.assign(client, res.client);
        toast(f && d ? `Счёт за ведение будет появляться каждый месяц ${d} числа` : 'Сохранено');
        load();
      } catch (err) {
        toast(err.message);
      }
    };
    fee.addEventListener('change', saveBilling);
    payDay.addEventListener('change', saveBilling);
    const debt = data.payments.filter((p) => p.status === 'overdue').reduce((a, p) => a + Number(p.amount), 0);
    fill(
      box,
      h('div', { class: 'checklist-head' }, h('h2', {}, 'Деньги'), debt ? h('span', { class: 'chip due overdue' }, `долг ${rub(debt)}`) : null, h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn btn-s', onclick: () => paymentDialog({ clientId: client.id, onSaved: load }) }, '+ Счёт')),
      h('div', { class: 'money-billing' },
        h('div', { class: 'field' }, h('label', { for: 'cm-fee' }, 'Ведение, ₽ в месяц'), fee),
        h('div', { class: 'field' }, h('label', { for: 'cm-day' }, 'Оплата до, число'), payDay),
      ),
      data.payments.length ? paymentRows(data.payments.slice(0, 12), { reload: load }) : h('p', { class: 'muted small' }, 'Счетов пока нет. Укажите абонентскую плату — счёт за ведение будет появляться каждый месяц сам.'),
    );
  }
  load();
  return box;
}

/** Вкладка «Оплаты»: кто должен, чего ждём, что пришло. */
export async function renderMoney(params) {
  const filter = params.get('status') ?? '';
  const body = h('div', { class: 'money' }, h('p', { class: 'muted' }, 'Загружаю…'));
  const addBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Новый счёт');
  fill(app, shell('money', [h('div', { class: 'page-head' }, h('h1', {}, 'Оплаты'), h('span', { class: 'spacer' }), addBtn), body]));
  let clients = [];
  api('/admin/api/clients').then((d) => (clients = d.clients ?? [])).catch(() => {});
  addBtn.addEventListener('click', () => paymentDialog({ clients, onSaved: load }));
  async function load() {
    let data;
    try {
      data = await api('/admin/api/money');
    } catch (err) {
      if (err.status !== 401) fill(body, h('p', { class: 'error' }, err.message));
      return;
    }
    const s = data.summary;
    const tile = (label, v, tone, status) => h('a', { class: `home-stat ${tone}`, href: `#/money${status ? `?status=${status}` : ''}`, 'aria-current': status === filter && filter ? 'true' : null }, h('b', { class: 'num' }, rub(v.sum)), h('span', {}, `${label} · ${v.count}`));
    const list = filter ? data.payments.filter((p) => p.status === filter) : data.payments;
    fill(
      body,
      h('div', { class: 'home-stats money-stats' }, tile('просрочено', s.overdue, s.overdue.sum ? 'bad' : '', 'overdue'), tile('ждём в этом месяце', s.expected, 'accent', 'open'), tile('получено в этом месяце', s.received, 'good', 'paid')),
      s.debtors.length
        ? h('section', { class: 'panel home-card' }, h('div', { class: 'home-card-head' }, h('h2', {}, 'Должники')), h('ul', { class: 'home-list' }, s.debtors.map((d) => h('li', { class: 'home-recent' }, icon('person'), h('a', { class: 'task-link', href: `#/client?id=${d.client_id}` }, d.client_name), h('span', { class: 'due overdue num' }, `${rub(d.sum)} · ${d.days} дн.`)))))
        : null,
      h(
        'section',
        { class: 'panel home-card' },
        h('div', { class: 'home-card-head' }, h('h2', {}, filter ? STATUS[filter] : 'Все счета'), h('span', { class: 'spacer' }),
          h('div', { class: 'rating-filter', role: 'group', 'aria-label': 'Статус' }, [['', 'Все'], ['overdue', 'Просрочено'], ['open', 'Ждём'], ['paid', 'Оплачено']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(k === filter), onclick: () => navigate('money', k ? new URLSearchParams({ status: k }) : undefined) }, l)))),
        list.length ? paymentRows(list, { reload: load, showClient: true }) : h('p', { class: 'home-quiet' }, filter ? 'Здесь пусто.' : 'Счетов пока нет. Укажите в карточке клиента абонентскую плату — счёт за ведение будет появляться каждый месяц сам, — или добавьте счёт кнопкой «Новый счёт».'),
      ),
    );
  }
  load();
}

export { todayIso };
