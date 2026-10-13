// Мессенджер: список чатов слева, переписка справа. Личные чаты и группы (в том числе по проекту
// клиента), файлы и скриншоты, правка и удаление своих сообщений. Новые сообщения в открытом чате
// подтягиваются каждые 3 секунды; в остальное время — всплывающим окном и счётчиком в меню.

import { h, api, app, shell, toast, confirmDialog, navigate, ctx, icon, userAvatar, plural } from './admin.js';
import { fill, formDialog } from './docs.js';
import { uploadFile, filesView, lightbox, fileSize, ACCEPT_ANY } from './files.js';

const TZ = 'Europe/Moscow';
const utc = (s) => new Date(`${String(s).replace(' ', 'T')}Z`);
const timeOf = (s) => utc(s).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayKey = (s) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(utc(s));
function dayLabel(key) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() - 864e5));
  if (key === today) return 'Сегодня';
  if (key === yesterday) return 'Вчера';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}
const shortTime = (s) => (dayKey(s) === new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()) ? timeOf(s) : utc(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: TZ }));

let openChatId = null;
/** Какой чат сейчас на экране — чтобы не показывать всплывающее окно о нём же. */
export const currentChat = () => (location.hash.startsWith('#/chat') && document.visibilityState === 'visible' ? openChatId : null);

let team = null;
const loadTeam = async () => (team ??= (await api('/admin/api/team')).team);

function chatAvatar(c) {
  if (c.kind === 'direct' && c.peer) return userAvatar(c.peer);
  return h('span', { class: `avatar chat-group-avatar${c.client_id ? ' is-client' : ''}` }, icon(c.client_id ? 'tasks' : 'staff'));
}

export async function renderChat(params) {
  const want = Number(params.get('id')) || null;
  const listBox = h('nav', { class: 'chat-list', 'aria-label': 'Чаты' }, h('p', { class: 'muted small' }, 'Загружаю…'));
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Найти чат', 'aria-label': 'Найти чат' });
  const pane = h('section', { class: 'chat-pane' });
  const root = h('div', { class: `chat${want ? ' has-open' : ''}` },
    h('aside', { class: 'chat-side' },
      h('div', { class: 'chat-side-head' }, h('h1', {}, 'Сообщения'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn btn-s btn-primary', onclick: newChatDialog }, '+ Чат')),
      search,
      listBox,
    ),
    pane,
  );
  fill(app, shell('chat', root));
  await loadTeam().catch(() => {});

  let chats = [];
  async function loadList() {
    try {
      chats = (await api('/admin/api/chats')).chats;
    } catch (err) {
      if (err.status !== 401) fill(listBox, h('p', { class: 'error' }, err.message));
      return;
    }
    drawList();
  }
  function drawList() {
    const q = search.value.trim().toLowerCase();
    const shown = chats.filter((c) => !q || c.title.toLowerCase().includes(q) || c.members.some((m) => m.name.toLowerCase().includes(q)));
    fill(
      listBox,
      shown.length
        ? shown.map((c) =>
            h('a', { class: `chat-item${c.unread ? ' has-unread' : ''}`, href: `#/chat?id=${c.id}`, 'aria-current': c.id === openChatId ? 'page' : null },
              chatAvatar(c),
              h('span', { class: 'chat-item-main' },
                h('span', { class: 'chat-item-top' }, h('strong', {}, c.title), c.last ? h('span', { class: 'muted small' }, shortTime(c.last.at)) : null),
                h('span', { class: 'chat-item-bottom' },
                  h('span', { class: 'muted small chat-preview' }, c.last ? `${c.last.author_id === ctx.me.id ? 'Вы: ' : c.kind !== 'direct' && c.last.author_id ? `${c.last.author.split(' ')[0]}: ` : ''}${c.last.text || (c.last.files ? '📎 Файл' : '')}` : 'Пока нет сообщений'),
                  c.unread ? h('span', { class: 'nav-badge num' }, c.unread > 99 ? '99+' : c.unread) : null),
              ),
            ),
          )
        : h('div', { class: 'chat-empty-list' }, h('p', { class: 'muted' }, q ? 'Ничего не нашлось.' : 'Чатов пока нет.'), q ? null : h('button', { type: 'button', class: 'btn btn-s', onclick: newChatDialog }, 'Написать коллеге')),
    );
  }
  search.addEventListener('input', drawList);

  // ---------- новый чат ----------
  async function newChatDialog() {
    const people = (await loadTeam().catch(() => [])).filter((u) => u.id !== ctx.me.id);
    const picked = new Set();
    const titleInput = h('input', { class: 'input', id: 'nc-title', maxlength: 100, placeholder: 'Например: Таллер — запуск РК' });
    let clients = [];
    try {
      clients = (await api('/admin/api/clients')).clients;
    } catch {}
    const client = h('select', { class: 'select', id: 'nc-client' }, h('option', { value: '' }, 'Без проекта'), clients.map((c) => h('option', { value: c.id }, c.name)));
    const groupFields = h('div', { class: 'dialog-grid', hidden: true }, h('div', { class: 'field' }, h('label', { for: 'nc-title' }, 'Название группы'), titleInput), h('div', { class: 'field' }, h('label', { for: 'nc-client' }, 'Проект клиента'), client));
    const hint = h('p', { class: 'muted small' }, 'Выберите одного коллегу — будет личный чат, нескольких — группа.');
    const listEl = h('div', { class: 'chat-people' },
      people.map((u) =>
        h('label', { class: 'chat-person' },
          h('input', { type: 'checkbox', onchange: (e) => {
            if (e.target.checked) picked.add(u.id);
            else picked.delete(u.id);
            groupFields.hidden = picked.size < 2;
          } }),
          userAvatar(u), h('span', {}, u.name),
        ),
      ),
    );
    formDialog({
      title: 'Новый чат',
      submitLabel: 'Начать',
      body: [hint, listEl, groupFields],
      onSubmit: async () => {
        if (!picked.size) throw new Error('Выберите хотя бы одного коллегу');
        const body = picked.size === 1 ? { userId: [...picked][0] } : { memberIds: [...picked], title: titleInput.value.trim(), clientId: client.value ? Number(client.value) : null };
        if (picked.size > 1 && !body.title && !body.clientId) throw new Error('Назовите группу или выберите проект клиента');
        const { chat } = await api('/admin/api/chats', { method: 'POST', body });
        navigate('chat', new URLSearchParams({ id: String(chat.id) }));
      },
    });
  }

  // ---------- переписка ----------
  let poll = null;
  async function openChat(id) {
    clearInterval(poll);
    openChatId = id;
    if (!id) {
      fill(pane, h('div', { class: 'chat-placeholder' }, icon('chat'), h('p', {}, 'Выберите чат слева или начните новый.'), h('button', { type: 'button', class: 'btn btn-primary', onclick: newChatDialog }, 'Написать коллеге')));
      return;
    }
    let data;
    try {
      data = await api(`/admin/api/chats/${id}/messages`);
    } catch (err) {
      fill(pane, h('p', { class: 'error chat-placeholder' }, err.message));
      return;
    }
    let chat = data.chat;
    let lastId = data.messages.at(-1)?.id ?? 0;
    let firstId = data.messages[0]?.id ?? null;
    const scroller = h('div', { class: 'chat-messages', role: 'log', 'aria-live': 'polite' });
    const header = h('header', { class: 'chat-head' });
    let lastDay = null;
    let lastAuthor = null;

    function drawHeader() {
      const menu = chat.kind === 'direct'
        ? null
        : (() => {
            const det = h('details', { class: 'menu' }, h('summary', { class: 'icon-btn', 'aria-label': 'Действия с чатом', title: 'Действия' }, '⋮'), h('div', { class: 'menu-list', role: 'menu' },
              h('button', { type: 'button', role: 'menuitem', onclick: () => (det.removeAttribute('open'), rename()) }, 'Переименовать'),
              h('button', { type: 'button', role: 'menuitem', onclick: () => (det.removeAttribute('open'), addPeople()) }, 'Добавить участников'),
              h('button', { type: 'button', role: 'menuitem', class: 'danger', onclick: () => (det.removeAttribute('open'), leave()) }, 'Выйти из чата'),
            ));
            return det;
          })();
      fill(
        header,
        h('a', { class: 'chat-back icon-btn', href: '#/chat', 'aria-label': 'Ко всем чатам' }, '‹'),
        chatAvatar(chat),
        h('div', { class: 'chat-head-main' },
          h('strong', {}, chat.title),
          h('span', { class: 'muted small' }, chat.kind === 'direct' ? chat.peer?.position ?? 'Личный чат' : `${chat.members.length} ${plural(chat.members.length, 'участник', 'участника', 'участников')}${chat.client_name ? ` · проект «${chat.client_name}»` : ''}`),
        ),
        h('span', { class: 'spacer' }),
        chat.client_id ? h('a', { class: 'btn btn-s', href: `#/tasks?project=${chat.client_id}` }, 'Задачи проекта') : null,
        menu,
      );
    }
    const rename = () => {
      const input = h('input', { class: 'input', id: 'cr-title', maxlength: 100, value: chat.title });
      formDialog({ title: 'Название чата', submitLabel: 'Сохранить', body: [h('div', { class: 'field' }, h('label', { for: 'cr-title' }, 'Название'), input)], onSubmit: async () => {
        chat = (await api(`/admin/api/chats/${chat.id}`, { method: 'PATCH', body: { title: input.value } })).chat;
        drawHeader();
        loadList();
      } });
    };
    const addPeople = async () => {
      const people = (await loadTeam()).filter((u) => !chat.members.some((m) => m.id === u.id));
      if (!people.length) return toast('Все коллеги уже в чате');
      const picked = new Set();
      formDialog({
        title: 'Добавить участников',
        submitLabel: 'Добавить',
        body: [h('div', { class: 'chat-people' }, people.map((u) => h('label', { class: 'chat-person' }, h('input', { type: 'checkbox', onchange: (e) => (e.target.checked ? picked.add(u.id) : picked.delete(u.id)) }), userAvatar(u), h('span', {}, u.name))))],
        onSubmit: async () => {
          if (!picked.size) throw new Error('Выберите коллег');
          chat = (await api(`/admin/api/chats/${chat.id}`, { method: 'PATCH', body: { addIds: [...picked] } })).chat;
          drawHeader();
          fetchNew();
        },
      });
    };
    const leave = async () => {
      if (!(await confirmDialog(`Выйти из чата «${chat.title}»? Вернуть вас сможет только участник чата.`, { ok: 'Выйти' }))) return;
      await api(`/admin/api/chats/${chat.id}`, { method: 'PATCH', body: { removeIds: [ctx.me.id] } }).catch((err) => toast(err.message));
      navigate('chat');
    };

    function bubble(m) {
      if (!m.author_id) return h('div', { class: 'chat-system', dataset: { id: String(m.id) } }, m.body);
      const mine = m.author_id === ctx.me.id;
      const group = m.author_id === lastAuthor;
      lastAuthor = m.author_id;
      const actions = mine && !m.deleted
        ? h('span', { class: 'chat-msg-actions' },
            h('button', { type: 'button', class: 'linkish small', onclick: () => editMsg(m) }, 'изменить'),
            h('button', { type: 'button', class: 'linkish small', onclick: () => delMsg(m) }, 'удалить'))
        : null;
      return h('div', { class: `chat-msg${mine ? ' mine' : ''}${group ? ' grouped' : ''}${m.deleted ? ' deleted' : ''}`, dataset: { id: String(m.id) } },
        !mine ? (group ? h('span', { class: 'chat-avatar-gap' }) : userAvatar({ id: m.author_id, name: m.author })) : null,
        h('div', { class: 'chat-bubble' },
          !mine && !group && chat.kind !== 'direct' ? h('span', { class: 'chat-author' }, m.author) : null,
          m.deleted ? h('em', { class: 'muted' }, 'Сообщение удалено') : [
            m.body ? richText(m.body) : null,
            m.files?.length ? filesView(m.files, { onOpenImage: lightbox }) : null,
          ],
          h('span', { class: 'chat-meta' }, m.edited_at && !m.deleted ? 'изменено · ' : '', timeOf(m.created_at), mine ? readMark(m) : null),
        ),
        actions,
      );
    }
    const readMark = (m) => {
      const others = chat.members.filter((x) => x.id !== ctx.me.id);
      const seen = others.length && others.every((x) => x.last_read >= m.id);
      return h('span', { class: `chat-read${seen ? ' seen' : ''}`, title: seen ? 'Прочитано' : 'Доставлено' }, seen ? ' ✓✓' : ' ✓');
    };
    function append(list) {
      for (const m of list) {
        const day = dayKey(m.created_at);
        if (day !== lastDay) {
          scroller.append(h('div', { class: 'chat-day' }, h('span', {}, dayLabel(day))));
          lastDay = day;
          lastAuthor = null;
        }
        const old = scroller.querySelector(`[data-id="${m.id}"]`);
        if (old) old.replaceWith(bubble(m));
        else scroller.append(bubble(m));
      }
    }
    const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    const toBottom = () => (scroller.scrollTop = scroller.scrollHeight);
    async function markRead() {
      if (!lastId || document.visibilityState !== 'visible') return;
      try {
        const { unread } = await api(`/admin/api/chats/${chat.id}/read`, { method: 'POST', body: { lastId } });
        setChatBadge(unread);
        const item = chats.find((c) => c.id === chat.id);
        if (item && item.unread) ((item.unread = 0), drawList());
      } catch {}
    }
    async function fetchNew() {
      try {
        const res = await api(`/admin/api/chats/${chat.id}/messages?after=${lastId}`);
        // свежие отметки «прочитано» и участники
        chat = res.chat;
        if (res.messages.length) {
          const stick = nearBottom();
          append(res.messages);
          lastId = res.messages.at(-1).id;
          if (stick) toBottom();
          markRead();
          loadList();
        }
        for (const el of scroller.querySelectorAll('.chat-msg.mine .chat-read')) {
          const id = Number(el.closest('.chat-msg').dataset.id);
          const others = chat.members.filter((x) => x.id !== ctx.me.id);
          const seen = others.length && others.every((x) => x.last_read >= id);
          el.className = `chat-read${seen ? ' seen' : ''}`;
          el.textContent = seen ? ' ✓✓' : ' ✓';
        }
      } catch {}
    }
    async function loadOlder() {
      if (!firstId) return;
      const before = scroller.scrollHeight;
      const res = await api(`/admin/api/chats/${chat.id}/messages?before=${firstId}`).catch(() => null);
      if (!res?.messages.length) return (firstId = null);
      firstId = res.messages[0].id;
      const frag = h('div');
      const save = { lastDay, lastAuthor };
      lastDay = null;
      lastAuthor = null;
      for (const m of res.messages) {
        const day = dayKey(m.created_at);
        if (day !== lastDay) ((frag.append(h('div', { class: 'chat-day' }, h('span', {}, dayLabel(day))))), (lastDay = day), (lastAuthor = null));
        frag.append(bubble(m));
      }
      ({ lastDay, lastAuthor } = save);
      scroller.prepend(...frag.childNodes);
      scroller.scrollTop = scroller.scrollHeight - before;
    }
    scroller.addEventListener('scroll', () => scroller.scrollTop < 40 && loadOlder());

    async function editMsg(m) {
      const input = h('textarea', { class: 'textarea', id: 'ce-text', rows: 4, maxlength: 4000 }, m.body);
      formDialog({ title: 'Изменить сообщение', submitLabel: 'Сохранить', body: [h('div', { class: 'field' }, h('label', { for: 'ce-text', class: 'sr-only' }, 'Текст'), input)], onSubmit: async () => {
        const { message } = await api(`/admin/api/chat-messages/${m.id}`, { method: 'PATCH', body: { text: input.value } });
        scroller.querySelector(`[data-id="${m.id}"]`)?.replaceWith(bubble(message));
      } });
    }
    async function delMsg(m) {
      if (!(await confirmDialog('Удалить сообщение? Собеседники увидят «Сообщение удалено».'))) return;
      try {
        const { message } = await api(`/admin/api/chat-messages/${m.id}`, { method: 'DELETE' });
        scroller.querySelector(`[data-id="${m.id}"]`)?.replaceWith(bubble(message));
      } catch (err) {
        toast(err.message);
      }
    }

    // ---------- поле ввода ----------
    const pending = [];
    const chips = h('div', { class: 'news-attach' });
    const input = h('textarea', { class: 'textarea chat-input', rows: 1, maxlength: 4000, placeholder: 'Сообщение… Enter — отправить, Shift+Enter — новая строка', 'aria-label': 'Сообщение' });
    const picker = h('input', { type: 'file', multiple: true, hidden: true, accept: ACCEPT_ANY, onchange: (e) => attach(e.target.files) });
    const sendBtn = h('button', { type: 'button', class: 'btn btn-primary chat-send', 'aria-label': 'Отправить', onclick: send }, '↑');
    async function attach(list) {
      for (const file of [...(list ?? [])]) {
        if (pending.length >= 10) return toast('Не больше 10 файлов в сообщении');
        const bar = h('i');
        const chip = h('div', { class: 'attach-chip uploading' }, h('span', { class: 'attach-name' }, file.name), h('span', { class: 'attach-bar' }, bar));
        chips.append(chip);
        try {
          const f = await uploadFile(file, { onProgress: (x) => (bar.style.width = `${Math.round(x * 100)}%`) });
          pending.push(f);
          chip.replaceWith(h('div', { class: 'attach-chip' }, f.kind === 'image' ? h('img', { src: `/admin/api/files/${f.id}`, alt: '' }) : h('span', { class: 'attach-icon' }, icon('docs')), h('span', { class: 'attach-name' }, f.name, h('span', { class: 'muted small' }, ` · ${fileSize(f.bytes)}`)), h('button', { type: 'button', class: 'attach-remove', 'aria-label': `Убрать ${f.name}`, onclick: (e) => (pending.splice(pending.indexOf(f), 1), e.currentTarget.closest('.attach-chip').remove()) }, '×')));
        } catch (err) {
          chip.remove();
          toast(err.message);
        }
      }
      picker.value = '';
      input.focus();
    }
    async function send() {
      const text = input.value.trim();
      if (!text && !pending.length) return;
      if (chips.querySelector('.uploading')) return toast('Дождитесь, пока загрузятся файлы');
      sendBtn.disabled = true;
      try {
        await api(`/admin/api/chats/${chat.id}/messages`, { method: 'POST', body: { text, fileIds: pending.map((f) => f.id) } });
        input.value = '';
        input.style.height = 'auto';
        pending.length = 0;
        chips.replaceChildren();
        await fetchNew();
        toBottom();
      } catch (err) {
        toast(err.message);
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    });
    input.addEventListener('paste', (e) => {
      const list = [...(e.clipboardData?.files ?? [])];
      if (list.length) {
        e.preventDefault();
        attach(list);
      }
    });
    pane.addEventListener('dragover', (e) => (e.preventDefault(), pane.classList.add('drag')));
    pane.addEventListener('dragleave', (e) => !pane.contains(e.relatedTarget) && pane.classList.remove('drag'));
    pane.addEventListener('drop', (e) => {
      e.preventDefault();
      pane.classList.remove('drag');
      attach(e.dataTransfer.files);
    });

    drawHeader();
    if (!data.messages.length) scroller.append(h('p', { class: 'chat-system' }, chat.kind === 'direct' ? `Начните разговор с ${chat.title}.` : 'Здесь пока тихо — напишите первым.'));
    append(data.messages);
    fill(pane, header, scroller, h('div', { class: 'chat-compose' }, chips, h('div', { class: 'chat-compose-row' }, h('button', { type: 'button', class: 'icon-btn', title: 'Прикрепить файл', 'aria-label': 'Прикрепить файл', onclick: () => picker.click() }, icon('clip')), input, sendBtn), picker));
    toBottom();
    input.focus();
    markRead();
    poll = setInterval(() => {
      if (!pane.isConnected) return clearInterval(poll);
      if (document.visibilityState === 'visible') fetchNew();
    }, 3000);
  }

  await loadList();
  await openChat(want);
  drawList();
  // список чатов — раз в 10 секунд, пока страница открыта
  const listPoll = setInterval(() => {
    if (!root.isConnected) return clearInterval(listPoll);
    if (document.visibilityState === 'visible') loadList();
  }, 10e3);
}

/** Ссылки и переносы строк в тексте сообщения — только текстовыми узлами. */
function richText(text) {
  const p = h('p', { class: 'chat-text' });
  String(text).split('\n').forEach((line, i) => {
    if (i) p.append(h('br'));
    for (const part of line.split(/(https?:\/\/[^\s<>«»"]+|@[A-Za-zА-Яа-яЁё]{2,})/g)) {
      if (!part) continue;
      if (/^https?:\/\//.test(part)) p.append(h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' }, part));
      else if (part.startsWith('@')) p.append(h('span', { class: 'mention' }, part));
      else p.append(part);
    }
  });
  return p;
}

// ---------- счётчик непрочитанных у пункта «Сообщения» ----------
export function setChatBadge(n) {
  for (const a of document.querySelectorAll('.nav a[href="#/chat"]')) {
    let b = a.querySelector('.nav-badge');
    if (!n) {
      b?.remove();
      continue;
    }
    if (!b) a.append((b = h('span', { class: 'nav-badge num' })));
    b.textContent = n > 99 ? '99+' : String(n);
    b.title = `Непрочитанных сообщений: ${n}`;
  }
}

/** Счётчик после перерисовки меню — не ждать следующего опроса. */
export function refreshChatBadge() {
  api('/admin/api/chats/incoming').then((d) => setChatBadge(d.unread), () => {});
}
