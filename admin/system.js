// «Состояние» (только администратор): резервные копии и проверка восстановления, место на диске,
// фоновые задачи, недоставленные заявки, обращения к ИИ, последние ошибки сервера.

import { h, api, app, shell, navigate, ctx } from './admin.js';
import { fill } from './docs.js';

const BACKUP = 'cd /opt/kvalificator && docker compose exec -T app npm run backup';

const mb = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} ГБ` : `${(b / 1048576).toFixed(1)} МБ`);
const when = (iso) =>
  iso ? new Date(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const badge = (state, text) => h('span', { class: 'status', dataset: { s: state === 'ok' ? 'won' : state === 'warn' ? 'new' : 'lost' } }, text);

function card(title, state, stateText, ...body) {
  return h(
    'section',
    { class: `panel integration sys-card${state === 'ok' ? ' on' : state === 'bad' ? ' bad' : ''}` },
    h('div', { class: 'integration-head' }, h('h2', {}, title), badge(state, stateText)),
    ...body,
  );
}
const rows = (pairs) => h('dl', { class: 'sys-rows' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

export async function renderSystem() {
  if (ctx.me.role !== 'admin') return navigate('home');
  const grid = h('div', { class: 'integrations' }, h('p', { class: 'muted' }, 'Проверяю…'));
  const refresh = h('button', { type: 'button', class: 'btn btn-s', onclick: () => load() }, 'Обновить');
  fill(
    app,
    shell('system', [
      h('div', { class: 'page-head' }, h('h1', {}, 'Состояние'), h('span', { class: 'spacer' }), refresh),
      h('p', { class: 'lead-text' }, 'Резервные копии, фоновые задачи и ошибки сервера. Ключей и личных данных здесь нет.'),
      grid,
    ]),
  );

  async function load() {
    let s;
    try {
      s = await api('/admin/api/system');
    } catch (err) {
      if (err.status !== 401) fill(grid, h('p', { class: 'error' }, err.message));
      return;
    }
    fill(grid, backupCard(s.backup), storageCard(s), jobsCard(s.jobs, s.startedAt), leadsCard(s.leads), aiCard(s.ai), errorsCard(s.errors));
  }
  await load();
}

function backupCard(b) {
  const check = b.check;
  const files = b.result?.files;
  const state = !b.last ? 'bad' : !b.fresh || (check && !check.ok) ? 'bad' : !check ? 'warn' : 'ok';
  const text = !b.last ? 'Копий нет' : !b.fresh ? 'Копия устарела' : check && !check.ok ? 'Проверка не пройдена' : !check ? 'Не проверялась' : 'В порядке';
  return card(
    'Резервные копии',
    state,
    text,
    rows([
      ['Последняя копия', b.last ? `${when(b.result?.createdAt)} · ${b.ageHours != null ? `${b.ageHours} ч назад` : ''}` : 'нет'],
      ['Копий базы', String(b.copies)],
      files ? ['Файлы в копии', `${files.total} (${mb(files.totalBytes)})`] : null,
      ['Проверка восстановления', check ? `${check.ok ? 'пройдена' : 'не пройдена'} · ${when(check.checkedAt)}` : 'ещё не было'],
    ]),
    ...(check?.errors ?? []).map((e) => h('p', { class: 'error' }, e)),
    ...(check?.warnings ?? []).map((w) => h('p', { class: 'muted' }, w)),
    b.result?.files ? null : h('p', { class: 'muted' }, 'Копии старого образца содержат только базу. После обновления сервера ночной бэкап будет копировать и файлы.'),
    h('p', { class: 'muted' }, 'Сделать копию вручную на сервере: ', h('code', {}, BACKUP)),
    h('p', { class: 'muted' }, 'Копии лежат на этом же сервере. Копия в другом месте — после согласования, где её хранить.'),
  );
}

function storageCard(s) {
  const st = s.storage;
  return card(
    'Место на диске',
    'ok',
    mb(st.db.bytes + st.db.wal + st.files.bytes + st.media.bytes + st.documents.bytes),
    rows([
      ['База', mb(st.db.bytes + st.db.wal)],
      ['Вложения (задачи, клиенты, новости, чаты)', `${st.files.count} · ${mb(st.files.bytes)}`],
      ['Медиатека документов', `${st.media.count} · ${mb(st.media.bytes)}`],
      ['Выгрузки документов', `${st.documents.count} · ${mb(st.documents.bytes)}`],
      ['Резервные копии', mb(st.backups.bytes)],
      ['Память сервера', `${s.memoryMb} МБ · Node ${s.node}`],
      ['Запущен', when(s.startedAt)],
    ]),
  );
}

function jobsCard(jobs, startedAt) {
  const bad = jobs.filter((j) => j.stale || (j.lastErrorAt && (!j.lastOk || j.lastErrorAt > j.lastOk)));
  return card(
    'Фоновые задачи',
    !jobs.length ? 'warn' : bad.length ? 'bad' : 'ok',
    !jobs.length ? 'Нет данных' : bad.length ? `Сбоев: ${bad.length}` : 'Работают',
    jobs.length
      ? h(
          'ul',
          { class: 'sys-list' },
          jobs.map((j) =>
            h(
              'li',
              {},
              h('b', {}, j.label),
              h('span', { class: 'muted' }, j.lastRun ? `последний запуск ${when(j.lastRun)}, всего ${j.runs}${j.fails ? `, ошибок ${j.fails}` : ''}` : `ещё не запускалась (сервер запущен ${when(startedAt)})`),
              j.stale ? h('span', { class: 'error' }, 'Давно не запускалась') : null,
              j.lastError ? h('span', { class: 'error' }, `${when(j.lastErrorAt)}: ${j.lastError}`) : null,
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'Сведения появятся через минуту после запуска сервера. Напоминания о встречах работают, только если подключён Telegram-бот.'),
  );
}

function leadsCard(l) {
  const state = !l.recipients ? 'warn' : l.undelivered ? 'bad' : 'ok';
  return card(
    'Доставка заявок',
    state,
    !l.recipients ? 'Получатели не настроены' : l.undelivered ? `Не доставлено: ${l.undelivered}` : 'Все доставлены',
    l.recipients
      ? h('p', { class: 'muted' }, l.undelivered ? `Самая старая — ${when(l.oldest)}. Сервер повторяет отправку каждые 5 минут; проверьте Telegram-бота или адрес CRM.` : 'Карточки заявок уходят менеджерам в Telegram и (или) в CRM.')
      : h('p', { class: 'muted' }, 'Заявки сохраняются в кабинете, но в Telegram и CRM не уходят: не заданы TELEGRAM_MANAGER_CHAT_ID или LEAD_WEBHOOK_URL.'),
  );
}

function aiCard(ai) {
  const w = ai.week;
  return card(
    'ИИ за 7 дней',
    'ok',
    `${w.n} ${w.n % 10 === 1 && w.n % 100 !== 11 ? 'запрос' : [2, 3, 4].includes(w.n % 10) && ![12, 13, 14].includes(w.n % 100) ? 'запроса' : 'запросов'}`,
    rows([
      ['Отправлено', `${Math.round(w.chars_in / 1000)} тыс. символов`],
      ['Получено', `${Math.round(w.chars_out / 1000)} тыс. символов`],
      ...ai.byAction.map((a) => [a.action, String(a.n)]),
    ]),
    h('p', { class: 'muted' }, 'Тексты запросов не хранятся — только объём. Личные данные перед отправкой заменяются метками.'),
  );
}

function errorsCard(errors) {
  return card(
    'Ошибки сервера',
    errors.length ? 'warn' : 'ok',
    errors.length ? `${errors.length} с запуска` : 'Нет',
    errors.length
      ? h('ul', { class: 'sys-list' }, errors.slice(0, 15).map((e) => h('li', {}, h('b', {}, e.where), h('span', { class: 'muted' }, `${when(e.at)}: ${e.message}`))))
      : h('p', { class: 'muted' }, 'С момента запуска сервера ошибок не было.'),
  );
}
