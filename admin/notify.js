// Уведомления кабинета «вживую»: раз в 20 секунд спрашиваем сервер о новых и показываем их
// всплывающим окном в углу, системным уведомлением браузера (если вкладка свёрнута) и звуком.
// Тихие часы и отключённые категории — в «Учётная запись» → «Уведомления».
// Сторонних сервисов нет: всё идёт с нашего сервера прямо в браузер сотрудника.

import { h, api, app, shell, toast, ctx, icon, userAvatar } from './admin.js';
import { fill } from './docs.js';

const POLL_MS = 20e3;
// значок системного уведомления — тот же, что у вкладки
const NOTE_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2320252a'/%3E%3Crect x='8' y='14' width='16' height='4' rx='2' fill='%2312c9d6'/%3E%3C/svg%3E";
const KIND_ICON = { task_assigned: 'tasks', task_done: 'tasks', task_file: 'clip', comment: 'news', mention: 'person', meeting: 'calendar', payment: 'plans', news: 'news', test: 'bell' };
let lastId = null;
let timer = null;
let onCount = () => {};

const prefs = () => ctx.me?.prefs ?? {};
/** Сейчас тихие часы? Значение вида «22-9» — с 22:00 до 9:00 по времени компьютера. */
export function inQuiet(value = prefs().notifyQuiet, now = new Date()) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(value ?? '');
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const hour = now.getHours();
  return from > to ? hour >= from || hour < to : hour >= from && hour < to;
}

// ---------- звук: короткий сигнал без файлов ----------
let audio = null;
function ding() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    for (const [freq, at] of [[880, 0], [1320, 0.12]]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.25);
      osc.connect(gain).connect(audio.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.3);
    }
  } catch {
    /* браузер не дал проиграть звук до первого клика — не страшно */
  }
}

const markRead = (n) => api('/admin/api/notifications/read', { method: 'POST', body: { id: n.id } }).then((d) => onCount(d.unread), () => {});
const open = (n) => {
  markRead(n);
  if (n.href) location.hash = n.href.replace(/^#?/, '#');
};

// ---------- всплывающее окно в углу ----------
function popup(n) {
  let stack = document.querySelector('.notif-toasts');
  if (!stack) {
    stack = h('div', { class: 'notif-toasts', role: 'region', 'aria-label': 'Новые уведомления', 'aria-live': 'polite' });
    document.body.append(stack);
  }
  let hideTimer = null;
  const close = () => {
    clearTimeout(hideTimer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  const el = h(
    'div',
    { class: `notif-toast k-${n.kind}` },
    n.actor ? userAvatar({ id: n.actor_id, name: n.actor }) : h('span', { class: 'notif-toast-icon' }, icon(KIND_ICON[n.kind] ?? 'bell')),
    h('div', { class: 'notif-toast-body' }, h('p', {}, n.text), h('span', { class: 'muted small' }, n.actor ? `${n.actor} · только что` : 'только что')),
    h('div', { class: 'notif-toast-actions' },
      n.href ? h('button', { type: 'button', class: 'btn btn-s btn-primary', onclick: () => (open(n), close()) }, 'Открыть') : null,
      h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Закрыть', onclick: close }, '×'),
    ),
  );
  const arm = () => (hideTimer = setTimeout(close, 10e3));
  el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  el.addEventListener('mouseleave', arm);
  stack.append(el);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  arm();
}

// ---------- системное уведомление браузера ----------
export const browserSupported = () => 'Notification' in window;
function system(n) {
  try {
    const note = new Notification('Ассистент Soroka', { body: n.text, tag: `soroka-${n.id}`, icon: NOTE_ICON, lang: 'ru' });
    note.onclick = () => {
      window.focus();
      open(n);
      note.close();
    };
  } catch {
    /* браузер без системных уведомлений */
  }
}

function deliver(items) {
  if (!items.length) return;
  const p = prefs();
  if (inQuiet(p.notifyQuiet)) return;
  const visible = document.visibilityState === 'visible' && document.hasFocus();
  const canSystem = p.notifyBrowser === 'on' && browserSupported() && Notification.permission === 'granted';
  for (const n of items.slice(-4)) {
    if (visible || !canSystem) {
      if (p.notifyPopup !== 'off') popup(n);
    } else system(n);
  }
  if (p.notifySound !== 'off') ding();
}

async function poll() {
  if (!ctx.me) return;
  try {
    const d = await api(`/admin/api/notifications${lastId != null ? `?after=${lastId}` : ''}`);
    onCount(d.unread);
    if (lastId == null) lastId = d.last; // при входе старые не показываем
    else if (d.items.length) {
      lastId = Math.max(lastId, ...d.items.map((n) => n.id));
      deliver(d.items);
    }
  } catch {
    /* сеть пропала — попробуем в следующий раз */
  }
}

/** Запустить слежение за новыми уведомлениями; countCb(unread) — обновить колокольчик. */
export function watchNotifications(countCb) {
  onCount = countCb;
  if (timer) return poll();
  poll();
  timer = setInterval(poll, POLL_MS);
  // вернулись во вкладку — проверить сразу
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && poll());
}
export const checkNow = poll;

/** Плашка на «Главной»: один раз предложить уведомления браузера (если ещё не решали). */
export function permissionBanner() {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('soroka-notify-ask') === 'no';
  } catch {}
  if (dismissed || !browserSupported() || Notification.permission !== 'default') return null;
  const el = h(
    'div',
    { class: 'notify-ask' },
    h('span', { class: 'notif-toast-icon' }, icon('bell')),
    h('span', {}, h('strong', {}, 'Включить уведомления браузера?'), h('span', { class: 'muted small' }, ' Поручения, упоминания и встречи придут, даже если вкладка свёрнута.')),
    h('span', { class: 'spacer' }),
    h('button', {
      type: 'button', class: 'btn btn-primary btn-s',
      onclick: async () => {
        const res = await Notification.requestPermission();
        if (res === 'granted') {
          const r = await api('/admin/api/me/prefs', { method: 'PATCH', body: { notifyBrowser: 'on' } }).catch(() => null);
          if (r) ctx.me.prefs = r.prefs;
          toast('Готово: уведомления браузера включены');
        }
        el.remove();
      },
    }, 'Включить'),
    h('button', {
      type: 'button', class: 'btn btn-s',
      onclick: () => {
        try {
          localStorage.setItem('soroka-notify-ask', 'no');
        } catch {}
        el.remove();
      },
    }, 'Не сейчас'),
  );
  return el;
}

// ---------- страница настроек ----------

const CATEGORIES = [
  ['tasks', 'Поручения и задачи', 'Вам поручили задачу, ваша задача выполнена, новые файлы в задаче'],
  ['mentions', 'Упоминания', 'Кто-то написал @ваше имя в задаче, новостях или обсуждении'],
  ['comments', 'Комментарии', 'Новые комментарии к вашим задачам и записям'],
  ['meetings', 'Встречи', 'Приглашения на встречи и итоги встреч'],
  ['payments', 'Оплаты', 'Скоро срок оплаты клиента и просроченные оплаты'],
  ['news', 'Новости', 'Закреплённые важные записи в «Новостях»'],
];
const QUIET = [['off', 'Без тихих часов'], ['22-9', 'С 22:00 до 9:00'], ['21-9', 'С 21:00 до 9:00'], ['20-8', 'С 20:00 до 8:00'], ['23-8', 'С 23:00 до 8:00'], ['19-9', 'С 19:00 до 9:00']];

export function renderNotifySettings() {
  const p = { ...prefs() };
  const box = h('div', { class: 'notify-settings' });
  const save = async (patch) => {
    Object.assign(p, patch);
    try {
      const res = await api('/admin/api/me/prefs', { method: 'PATCH', body: patch });
      ctx.me.prefs = res.prefs;
      draw();
    } catch (err) {
      toast(err.message);
    }
  };
  const toggle = (key, label, hint) =>
    h('label', { class: 'notify-row' },
      h('span', { class: 'notify-text' }, h('strong', {}, label), hint ? h('span', { class: 'muted small' }, hint) : null),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: p[key] !== 'off', onchange: (e) => save({ [key]: e.target.checked ? 'on' : 'off' }) }), h('span', {})),
    );

  function browserRow() {
    if (!browserSupported()) return h('div', { class: 'notify-row' }, h('span', { class: 'notify-text' }, h('strong', {}, 'Уведомления браузера'), h('span', { class: 'muted small' }, 'Этот браузер не умеет показывать системные уведомления.')));
    const perm = Notification.permission;
    if (perm === 'denied') {
      return h('div', { class: 'notify-row' }, h('span', { class: 'notify-text' }, h('strong', {}, 'Уведомления браузера запрещены'), h('span', { class: 'muted small' }, 'Нажмите на значок замка слева от адреса сайта → «Уведомления» → «Разрешить», затем обновите страницу.')));
    }
    if (perm !== 'granted') {
      return h('div', { class: 'notify-row' },
        h('span', { class: 'notify-text' }, h('strong', {}, 'Уведомления браузера'), h('span', { class: 'muted small' }, 'Придут, даже если вкладка свёрнута или вы в другой программе. Браузер должен быть открыт.')),
        h('button', {
          type: 'button', class: 'btn btn-primary btn-s',
          onclick: async () => {
            const res = await Notification.requestPermission();
            if (res === 'granted') {
              await save({ notifyBrowser: 'on' });
              toast('Готово: уведомления браузера включены');
            } else draw();
          },
        }, 'Разрешить'),
      );
    }
    return h('label', { class: 'notify-row' },
      h('span', { class: 'notify-text' }, h('strong', {}, 'Уведомления браузера'), h('span', { class: 'muted small' }, 'Когда вкладка свёрнута или вы в другой программе — системное окно в углу экрана.')),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: p.notifyBrowser === 'on', onchange: (e) => save({ notifyBrowser: e.target.checked ? 'on' : 'off' }) }), h('span', {})),
    );
  }

  function draw() {
    const muted = new Set(String(p.notifyMute ?? '').split(',').filter(Boolean));
    fill(
      box,
      h(
        'section',
        { class: 'panel account-form' },
        h('h2', {}, 'Как получать'),
        h('p', { class: 'muted' }, 'Все уведомления всегда остаются в колокольчике. Здесь — как о них сообщать сразу.'),
        toggle('notifyPopup', 'Всплывающие окна в кабинете', 'Карточка в правом верхнем углу: кто, что и кнопка «Открыть».'),
        browserRow(),
        toggle('notifySound', 'Звук', 'Короткий сигнал при новом уведомлении.'),
        h('div', { class: 'notify-row' },
          h('span', { class: 'notify-text' }, h('strong', {}, 'Тихие часы'), h('span', { class: 'muted small' }, inQuiet(p.notifyQuiet) ? 'Сейчас тихие часы: без окон и звука, только колокольчик.' : 'Без окон и звука в это время — только колокольчик.')),
          h('select', { class: 'select', 'aria-label': 'Тихие часы', onchange: (e) => save({ notifyQuiet: e.target.value }) }, QUIET.map(([v, l]) => h('option', { value: v, selected: v === p.notifyQuiet }, l))),
        ),
        h('div', { class: 'work-actions' },
          h('button', {
            type: 'button', class: 'btn',
            onclick: async () => {
              await api('/admin/api/notifications/test', { method: 'POST', body: {} }).catch((err) => toast(err.message));
              checkNow();
            },
          }, 'Проверить'),
          h('span', { class: 'muted small' }, 'Пришлёт тестовое уведомление вам — так вы увидите, как оно выглядит.'),
        ),
      ),
      h(
        'section',
        { class: 'panel account-form' },
        h('h2', {}, 'Что присылать'),
        h('p', { class: 'muted' }, 'Отключённое не появится ни в колокольчике, ни во всплывающих окнах.'),
        CATEGORIES.map(([id, label, hint]) =>
          h('label', { class: 'notify-row' },
            h('span', { class: 'notify-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, hint)),
            h('span', { class: 'switch' }, h('input', {
              type: 'checkbox', checked: !muted.has(id),
              onchange: (e) => {
                if (e.target.checked) muted.delete(id);
                else muted.add(id);
                save({ notifyMute: [...muted].join(',') });
              },
            }), h('span', {})),
          ),
        ),
      ),
      h('p', { class: 'muted small' }, 'Напоминания о встречах в Telegram и подписка на календарь — на вкладке «Учётная запись».'),
    );
  }
  fill(app, shell('notify-settings', [h('div', { class: 'page-head' }, h('h1', {}, 'Уведомления')), box]));
  draw();
}

