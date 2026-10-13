// «Новости» агентства: лента записей сотрудников — новости, кейсы, ссылки, фото и видео.
// Под каждой записью — реакции и обсуждение. Закрепляет записи и подтверждает цифры кейсов администратор.

import { h, api, app, shell, toast, confirmDialog, navigate, fmtDateTime, plural, ctx, icon, userAvatar } from './admin.js';
import { fill, formDialog } from './docs.js';
import { uploadFile, filesView, lightbox, fileSize, ACCEPT_ANY, ACCEPT_MEDIA } from './files.js';

const KIND_LABEL = { news: 'Новость', case: 'Кейс', link: 'Ссылка' };
const FILTERS = [['', 'Все'], ['news', 'Новости'], ['case', 'Кейсы'], ['link', 'Ссылки']];
let REACTIONS = ['👍', '❤️', '🔥', '👏', '😂', '🎉'];

/** Текст записи: абзацы, ссылки кликабельны, @Имя выделено. Только текстовые узлы — без innerHTML. */
function richBody(text) {
  const box = h('div', { class: 'news-text' });
  for (const para of String(text ?? '').split(/\n{2,}/)) {
    if (!para.trim()) continue;
    const p = h('p');
    para.split('\n').forEach((line, li) => {
      if (li) p.append(h('br'));
      for (const part of line.split(/(https?:\/\/[^\s<>«»"]+|@[A-Za-zА-Яа-яЁё]{2,})/g)) {
        if (!part) continue;
        if (/^https?:\/\//.test(part)) {
          const url = part.replace(/[.,;:!?)]+$/, '');
          p.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url), part.slice(url.length));
        } else if (part.startsWith('@')) p.append(h('span', { class: 'mention' }, part));
        else p.append(part);
      }
    });
    box.append(p);
  }
  return box;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export async function renderNews(params) {
  const kind = params.get('kind') ?? '';
  const focusId = Number(params.get('post')) || null;
  const feed = h('div', { class: 'news-feed' }, h('p', { class: 'muted' }, 'Загружаю…'));
  const more = h('div', { class: 'news-more' });
  const filters = h(
    'div',
    { class: 'rating-filter', role: 'group', 'aria-label': 'Что показывать' },
    FILTERS.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(k === kind), onclick: () => navigate('news', k ? new URLSearchParams({ kind: k }) : undefined) }, l)),
  );
  const composerBox = h('div');
  fill(
    app,
    shell('news', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Новости'), h('span', { class: 'spacer' }), filters),
      h('div', { class: 'news' }, composerBox, feed, more),
    ]),
  );

  let clients = [];
  api('/admin/api/clients').then((d) => (clients = d.clients ?? [])).catch(() => {});

  let last = null;
  async function load(append = false) {
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    if (append && last) q.set('before', String(last));
    let data;
    try {
      data = await api(`/admin/api/news?${q}`);
    } catch (err) {
      if (err.status !== 401) fill(feed, h('p', { class: 'error' }, err.message));
      return;
    }
    REACTIONS = data.reactions ?? REACTIONS;
    Object.assign((ctx.avatars ??= {}), data.avatars ?? {});
    if (!append) {
      feed.replaceChildren();
      refreshNewsBadge(0);
    }
    if (!append && !data.posts.length) {
      fill(feed, h('div', { class: 'panel empty' }, h('strong', {}, kind ? 'Здесь пока пусто' : 'Лента пока пустая'), 'Поделитесь новостью, кейсом или полезной ссылкой — коллеги увидят и смогут обсудить.'));
    }
    for (const p of data.posts) feed.append(postCard(p, { onChange: () => load(), clients }));
    last = data.posts.at(-1)?.id ?? last;
    fill(more, data.more ? h('button', { type: 'button', class: 'btn', onclick: () => load(true) }, 'Показать ещё') : null);
    if (focusId && !append) {
      const el = feed.querySelector(`[data-id="${focusId}"]`);
      if (el) {
        el.classList.add('is-focus');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.querySelector('.news-comments-toggle')?.click();
      } else {
        api(`/admin/api/news/${focusId}`)
          .then(({ post }) => {
            const card = postCard(post, { onChange: () => load(), clients });
            card.classList.add('is-focus');
            feed.prepend(card);
            card.querySelector('.news-comments-toggle')?.click();
          })
          .catch(() => toast('Запись не найдена — возможно, её удалили'));
      }
    }
  }
  fill(composerBox, composer({ onPosted: () => load(), getClients: () => clients }));
  await load();
}

// ---------- новая запись ----------

function composer({ onPosted, getClients }) {
  let kind = 'news';
  const attached = [];
  const box = h('section', { class: 'panel news-compose' });
  const body = h('textarea', { class: 'textarea', rows: 3, maxlength: 10000, placeholder: 'Чем поделиться с командой? Новость, итог запуска, полезная находка. @Имя — позвать коллегу.', 'aria-label': 'Текст записи' });
  const title = h('input', { class: 'input', maxlength: 200, placeholder: 'Заголовок кейса, например: «Таллер: заявки ×2 за квартал»', 'aria-label': 'Заголовок' });
  const link = h('input', { class: 'input', type: 'url', maxlength: 1000, placeholder: 'https://…', 'aria-label': 'Ссылка' });
  const client = h('select', { class: 'select', 'aria-label': 'Клиент' }, h('option', { value: '' }, 'Клиент не указан'));
  const caseTask = h('textarea', { class: 'textarea', rows: 2, maxlength: 2000, placeholder: 'Какая была задача у клиента', 'aria-label': 'Задача клиента' });
  const caseResult = h('textarea', { class: 'textarea', rows: 2, maxlength: 2000, placeholder: 'Что сделали и какой результат — с цифрами и периодом', 'aria-label': 'Результат' });
  const pin = h('input', { type: 'checkbox' });
  const extra = h('div', { class: 'news-compose-extra' });
  const files = h('div', { class: 'news-attach' });
  const pickMedia = h('input', { type: 'file', accept: ACCEPT_MEDIA, multiple: true, hidden: true, onchange: (e) => add(e.target.files) });
  const pickAny = h('input', { type: 'file', accept: ACCEPT_ANY, multiple: true, hidden: true, onchange: (e) => add(e.target.files) });
  const submit = h('button', { type: 'button', class: 'btn btn-primary', onclick: publish }, 'Опубликовать');
  const kinds = h(
    'div',
    { class: 'news-kinds', role: 'radiogroup', 'aria-label': 'Вид записи' },
    Object.entries(KIND_LABEL).map(([k, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(k === kind), onclick: () => setKind(k) }, l)),
  );

  function setKind(k) {
    kind = k;
    for (const b of kinds.children) b.setAttribute('aria-checked', String(b.textContent === KIND_LABEL[k]));
    if (k === 'case' && client.options.length === 1) for (const c of getClients()) client.append(h('option', { value: c.id }, c.name));
    fill(
      extra,
      k === 'link' ? link : null,
      k === 'case'
        ? [
            title,
            h('div', { class: 'news-case-grid' }, client, h('span', { class: 'hint' }, 'Цифры кейса подтверждает администратор — после этого кейс можно брать в КП.')),
            caseTask,
            caseResult,
          ]
        : null,
    );
    body.placeholder = k === 'case' ? 'Подробности: как работали, что сработало, выводы' : k === 'link' ? 'Чем полезна ссылка' : 'Чем поделиться с командой? Новость, итог запуска, полезная находка. @Имя — позвать коллегу.';
    box.classList.add('open');
  }

  async function add(list) {
    for (const file of [...(list ?? [])]) {
      if (attached.length >= 10) return toast('Не больше 10 файлов в записи');
      const bar = h('i');
      const chip = h('div', { class: 'attach-chip uploading' }, h('span', { class: 'attach-name' }, file.name), h('span', { class: 'attach-bar' }, bar));
      files.append(chip);
      box.classList.add('open');
      try {
        const f = await uploadFile(file, { onProgress: (x) => (bar.style.width = `${Math.round(x * 100)}%`) });
        attached.push(f);
        const preview = f.kind === 'image' ? h('img', { src: `/admin/api/files/${f.id}`, alt: '' }) : f.kind === 'video' ? h('span', { class: 'attach-icon' }, '▶') : h('span', { class: 'attach-icon' }, icon('docs'));
        chip.replaceWith(
          h(
            'div',
            { class: 'attach-chip' },
            preview,
            h('span', { class: 'attach-name' }, f.name, h('span', { class: 'muted small' }, ` · ${fileSize(f.bytes)}`)),
            h('button', {
              type: 'button', class: 'attach-remove', 'aria-label': `Убрать ${f.name}`,
              onclick: (e) => {
                attached.splice(attached.indexOf(f), 1);
                e.currentTarget.closest('.attach-chip').remove();
              },
            }, '×'),
          ),
        );
      } catch (err) {
        chip.remove();
        toast(err.message);
      }
    }
    pickMedia.value = '';
    pickAny.value = '';
  }

  async function publish() {
    if (box.querySelector('.uploading')) return toast('Дождитесь, пока загрузятся файлы');
    const payload = { kind, body: body.value, fileIds: attached.map((f) => f.id) };
    if (kind === 'link') payload.link = link.value;
    if (kind === 'case') Object.assign(payload, { title: title.value, clientId: client.value ? Number(client.value) : null, caseTask: caseTask.value, caseResult: caseResult.value });
    if (pin.checked) payload.pinned = true;
    submit.disabled = true;
    try {
      await api('/admin/api/news', { method: 'POST', body: payload });
      for (const el of [body, title, link, caseTask, caseResult]) el.value = '';
      attached.length = 0;
      files.replaceChildren();
      pin.checked = false;
      box.classList.remove('open');
      setKind('news');
      box.classList.remove('open');
      toast('Опубликовано');
      onPosted();
    } catch (err) {
      toast(err.message);
    } finally {
      submit.disabled = false;
    }
  }

  body.addEventListener('focus', () => box.classList.add('open'));
  body.addEventListener('paste', (e) => {
    const list = [...(e.clipboardData?.files ?? [])];
    if (list.length) {
      e.preventDefault();
      add(list);
    }
  });
  box.addEventListener('dragover', (e) => (e.preventDefault(), box.classList.add('drag')));
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag');
    add(e.dataTransfer.files);
  });

  box.append(
    h('div', { class: 'news-compose-row' }, userAvatar(ctx.me), body),
    h('div', { class: 'news-compose-more' }, kinds, extra, files),
    h(
      'div',
      { class: 'news-compose-actions' },
      h('button', { type: 'button', class: 'btn btn-s', onclick: () => pickMedia.click() }, icon('image'), 'Фото или видео'),
      h('button', { type: 'button', class: 'btn btn-s', onclick: () => pickAny.click() }, icon('clip'), 'Файл'),
      pickMedia,
      pickAny,
      h('span', { class: 'spacer' }),
      ctx.me.role === 'admin' ? h('label', { class: 'check small' }, pin, 'Закрепить и уведомить всех') : null,
      submit,
    ),
    h('p', { class: 'hint news-hint' }, 'Видео до 100 МБ, фото и документы — до 20 МБ. Длинные ролики лучше дать ссылкой на Rutube, VK Видео или Яндекс Диск.'),
  );
  return box;
}

// ---------- запись в ленте ----------

export function postCard(p, { onChange, clients = [] }) {
  const mine = p.author_id === ctx.me.id;
  const admin = ctx.me.role === 'admin';
  const commentsBox = h('div', { class: 'news-comments', hidden: true });
  const commentsBtn = h('button', { type: 'button', class: 'linkish news-comments-toggle', 'aria-expanded': 'false', onclick: toggleComments }, p.comments ? `Комментарии (${p.comments})` : 'Обсудить');
  const reactionsBox = h('div', { class: 'news-reactions' });

  const actions = [];
  if (mine || admin) actions.push(h('button', { type: 'button', role: 'menuitem', onclick: () => edit() }, 'Изменить'));
  if (admin) actions.push(h('button', { type: 'button', role: 'menuitem', onclick: () => patch({ pinned: !p.pinned }, p.pinned ? 'Запись откреплена' : 'Запись закреплена — всем пришло уведомление') }, p.pinned ? 'Открепить' : 'Закрепить'));
  if (admin && p.kind === 'case') actions.push(h('button', { type: 'button', role: 'menuitem', onclick: () => patch({ verified: !p.verified }, p.verified ? 'Подтверждение снято' : 'Цифры кейса подтверждены') }, p.verified ? 'Снять подтверждение' : 'Подтвердить цифры'));
  if (mine || admin) actions.push(h('button', { type: 'button', role: 'menuitem', class: 'danger', onclick: remove }, 'Удалить'));
  const menu = actions.length
    ? (() => {
        const det = h('details', { class: 'menu' }, h('summary', { class: 'icon-btn', 'aria-label': 'Действия с записью', title: 'Действия' }, '⋮'), h('div', { class: 'menu-list', role: 'menu' }, actions));
        det.addEventListener('click', (e) => e.target.closest('button') && det.removeAttribute('open'));
        return det;
      })()
    : null;

  const card = h(
    'article',
    { class: `panel news-post kind-${p.kind}${p.pinned ? ' is-pinned' : ''}`, dataset: { id: String(p.id) } },
    h(
      'header',
      { class: 'news-head' },
      userAvatar({ id: p.author_id, name: p.author }),
      h('div', { class: 'news-who' }, h('strong', {}, p.author), h('span', { class: 'muted small' }, fmtDateTime(p.created_at), p.edited_at ? ' · изменено' : '')),
      h('span', { class: 'spacer' }),
      p.pinned ? h('span', { class: 'chip news-pin' }, '📌 Закреплено') : null,
      p.kind !== 'news' ? h('span', { class: `chip news-kind k-${p.kind}` }, KIND_LABEL[p.kind]) : null,
      menu,
    ),
    p.title ? h('h2', { class: 'news-title' }, p.title) : null,
    p.kind === 'case' ? caseBlock(p) : null,
    p.body ? richBody(p.body) : null,
    p.link ? h('a', { class: 'news-link', href: p.link, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'news-link-host' }, hostOf(p.link)), h('span', { class: 'news-link-url' }, p.link)) : null,
    p.files?.length ? filesView(p.files, { onOpenImage: lightbox }) : null,
    h('footer', { class: 'news-foot' }, reactionsBox, h('span', { class: 'spacer' }), commentsBtn),
    commentsBox,
  );
  drawReactions(p.reactions ?? {});
  return card;

  function drawReactions(r) {
    const picker = h('details', { class: 'react-picker' }, h('summary', { class: 'react-add', 'aria-label': 'Поставить реакцию', title: 'Реакция' }, '☺+'), h('div', { class: 'react-list' }, REACTIONS.map((e) => h('button', { type: 'button', onclick: () => react(e, picker) }, e))));
    fill(
      reactionsBox,
      Object.entries(r)
        .filter(([, v]) => v.count)
        .map(([e, v]) => h('button', { type: 'button', class: `react${v.mine ? ' mine' : ''}`, 'aria-pressed': String(v.mine), onclick: () => react(e) }, e, h('b', { class: 'num' }, v.count))),
      picker,
    );
  }
  async function react(emoji, picker = null) {
    picker?.removeAttribute('open');
    try {
      const { reactions } = await api(`/admin/api/news/${p.id}/react`, { method: 'POST', body: { emoji } });
      drawReactions(reactions);
    } catch (err) {
      toast(err.message);
    }
  }

  async function toggleComments() {
    const open = commentsBox.hidden;
    commentsBox.hidden = !open;
    commentsBtn.setAttribute('aria-expanded', String(open));
    if (open) await loadComments();
  }
  async function loadComments(list = null) {
    if (!list) {
      try {
        list = (await api(`/admin/api/news/${p.id}`)).comments;
      } catch (err) {
        return toast(err.message);
      }
    }
    commentsBtn.textContent = list.length ? `Комментарии (${list.length})` : 'Обсудить';
    const input = h('textarea', { class: 'textarea', rows: 1, maxlength: 3000, placeholder: 'Написать комментарий… @Имя — позвать коллегу', 'aria-label': 'Комментарий' });
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      try {
        const { comments } = await api(`/admin/api/news/${p.id}/comments`, { method: 'POST', body: { text } });
        await loadComments(comments);
        commentsBox.querySelector('textarea')?.focus();
      } catch (err) {
        toast(err.message);
        input.disabled = false;
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    });
    fill(
      commentsBox,
      list.map((c) =>
        h(
          'div',
          { class: 'news-comment' },
          userAvatar({ id: c.author_id, name: c.author }),
          h(
            'div',
            { class: 'news-comment-body' },
            h('div', { class: 'news-comment-head' }, h('strong', {}, c.author), h('span', { class: 'muted small' }, fmtDateTime(c.created_at)),
              c.author_id === ctx.me.id || ctx.me.role === 'admin'
                ? h('button', {
                    type: 'button', class: 'linkish small news-comment-del',
                    onclick: async () => {
                      if (!(await confirmDialog('Удалить комментарий?'))) return;
                      try {
                        loadComments((await api(`/admin/api/news/comments/${c.id}`, { method: 'DELETE' })).comments);
                      } catch (err) {
                        toast(err.message);
                      }
                    },
                  }, 'удалить')
                : null),
            richBody(c.body),
          ),
        ),
      ),
      h('div', { class: 'news-comment-new' }, userAvatar(ctx.me), input, h('button', { type: 'button', class: 'btn btn-s btn-primary', onclick: send }, 'Отправить')),
    );
  }

  async function patch(body, message) {
    try {
      await api(`/admin/api/news/${p.id}`, { method: 'PATCH', body });
      toast(message);
      onChange();
    } catch (err) {
      toast(err.message);
    }
  }
  async function remove() {
    if (!(await confirmDialog(`Удалить запись${p.title ? ` «${p.title}»` : ''} вместе с комментариями и файлами?`))) return;
    try {
      await api(`/admin/api/news/${p.id}`, { method: 'DELETE' });
      toast('Запись удалена');
      card.remove();
    } catch (err) {
      toast(err.message);
    }
  }
  function edit() {
    const f = {
      title: h('input', { class: 'input', id: 'ne-title', maxlength: 200, value: p.title ?? '' }),
      body: h('textarea', { class: 'textarea', id: 'ne-body', rows: 6, maxlength: 10000 }, p.body ?? ''),
      link: h('input', { class: 'input', id: 'ne-link', maxlength: 1000, value: p.link ?? '' }),
      client: h('select', { class: 'select', id: 'ne-client' }, h('option', { value: '' }, 'Клиент не указан'), clients.map((c) => h('option', { value: c.id, selected: c.id === p.client_id }, c.name))),
      caseTask: h('textarea', { class: 'textarea', id: 'ne-task', rows: 2, maxlength: 2000 }, p.case_task ?? ''),
      caseResult: h('textarea', { class: 'textarea', id: 'ne-result', rows: 2, maxlength: 2000 }, p.case_result ?? ''),
    };
    const keep = new Set((p.files ?? []).map((x) => x.id));
    const filesList = (p.files ?? []).length
      ? h('div', { class: 'field' }, h('span', { class: 'label' }, 'Файлы'), h('div', { class: 'news-attach' }, p.files.map((x) => h('label', { class: 'attach-chip check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? keep.add(x.id) : keep.delete(x.id)) }), h('span', { class: 'attach-name' }, x.name)))))
      : null;
    const row = (id, label, el) => h('div', { class: 'field' }, h('label', { for: id }, label), el);
    formDialog({
      title: 'Изменить запись',
      submitLabel: 'Сохранить',
      body: [
        p.kind === 'case' || p.title ? row('ne-title', 'Заголовок', f.title) : null,
        p.kind === 'case' ? [row('ne-client', 'Клиент', f.client), row('ne-task', 'Задача клиента', f.caseTask), row('ne-result', 'Результат', f.caseResult)] : null,
        row('ne-body', 'Текст', f.body),
        p.kind === 'link' ? row('ne-link', 'Ссылка', f.link) : null,
        filesList,
      ],
      onSubmit: async () => {
        const body = { body: f.body.value };
        if (p.kind === 'case' || p.title) body.title = f.title.value;
        if (p.kind === 'link') body.link = f.link.value;
        if (p.kind === 'case') Object.assign(body, { clientId: f.client.value ? Number(f.client.value) : null, caseTask: f.caseTask.value, caseResult: f.caseResult.value });
        if (keep.size !== (p.files ?? []).length) body.fileIds = (p.files ?? []).map((x) => x.id).filter((id) => keep.has(id));
        await api(`/admin/api/news/${p.id}`, { method: 'PATCH', body });
        toast('Сохранено');
        onChange();
      },
    });
  }
}

function caseBlock(p) {
  return h(
    'div',
    { class: 'news-case' },
    h(
      'div',
      { class: 'news-case-meta' },
      p.client_name ? h('a', { class: 'chip', href: `#/client?id=${p.client_id}` }, p.client_name) : null,
      h('span', { class: `chip ${p.verified ? 'case-ok' : 'case-wait'}` }, p.verified ? '✓ Цифры подтверждены' : 'Цифры не подтверждены'),
    ),
    p.case_task ? h('div', { class: 'news-case-row' }, h('span', { class: 'news-case-label' }, 'Задача'), richBody(p.case_task)) : null,
    p.case_result ? h('div', { class: 'news-case-row' }, h('span', { class: 'news-case-label' }, 'Результат'), richBody(p.case_result)) : null,
  );
}

// ---------- счётчик новых записей в меню ----------

let badgeTimer = null;
export function refreshNewsBadge(value = null) {
  const apply = (n) => {
    for (const a of document.querySelectorAll('.nav a[href="#/news"]')) {
      let b = a.querySelector('.nav-badge');
      if (!n) {
        b?.remove();
        continue;
      }
      if (!b) a.append((b = h('span', { class: 'nav-badge num' })));
      b.textContent = n > 99 ? '99+' : String(n);
      b.title = `${n} ${plural(n, 'новая запись', 'новые записи', 'новых записей')}`;
    }
  };
  if (value != null) return apply(value);
  api('/admin/api/news/unseen').then((d) => apply(d.unseen), () => {});
  if (!badgeTimer) badgeTimer = setInterval(() => document.visibilityState === 'visible' && ctx.me && refreshNewsBadge(), 120e3);
}
