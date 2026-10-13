// ИИ-ассистент кабинета. Три слоя, как в боте «Сара»:
//   1. правила — поручения по всем разделам разбираются сразу и работают без ИИ
//      (каталог фраз — src/assistant/phrases.js и commands.js, действия — actions.js);
//   2. модель — если фраза не подошла под правила, YandexGPT переписывает просьбу в фразы из каталога
//      («КОМАНДА: …»), и их выполняют те же правила; иначе — свободный разговор с опорой на регламенты;
//   3. поиск в интернете — Yandex Search API, ответ со ссылками на источники.
// Если подходят несколько задач, ассистент переспрашивает, а не угадывает: закрыть не ту хуже.
// В модель уходят только обезличенные тексты: почты и телефоны заменяются метками.

import { parseCommand, bestMatch } from './commands.js';
import { parsePhrase, normalize } from './phrases.js';
import { createActions } from './actions.js';
import { createMask } from '../ai/decks.js';

const MSK = 3 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');
const todayMsk = (now = new Date()) => new Date(now.getTime() + MSK).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const fmtDue = (t) => (t.due ? `${fmtDay(t.due)}${t.due_time ? ` к ${t.due_time}` : ''}` : 'без срока');
const mskTime = (dbTime) => {
  const d = new Date(`${String(dbTime).replace(' ', 'T')}Z`);
  const m = new Date(d.getTime() + MSK);
  return { date: m.toISOString().slice(0, 10), time: `${pad(m.getUTCHours())}:${pad(m.getUTCMinutes())}` };
};
const taskHref = (t) => `#/tasks?project=${t.client_id ?? 'none'}`;

export const DEFAULT_NAME = 'Ассистент';

// Образцы фраз для модели: просьбу своими словами она переписывает в одну из этих форм
const COMMAND_SAMPLES = [
  'поставь задачу <что сделать> для <клиент> на <когда> [в <время>] [срочно|критично] [каждый день|по будням|каждый понедельник|раз в две недели|ежемесячно 5 числа|каждый квартал]',
  'поручи <Имя> <что сделать> до <когда>',
  'закрой задачу <слова из названия>',
  'верни в работу задачу <слова из названия>',
  'перенеси задачу <слова из названия> на <когда> [в <время>]',
  'передай задачу <слова из названия> <Имя>',
  'сделай задачу <слова из названия> критичной|важной|средней|низкой',
  'комментарий к задаче <слова из названия>: <текст>',
  'удали задачу <слова из названия>',
  'открой задачу <слова из названия>',
  'что у меня сегодня | что у меня завтра | что у меня на неделе | что горит | что у <Имя> | загрузка команды',
  'добавь клиента <название>[, сайт <адрес>][, контакт <Имя>][, <телефон>]',
  'что по <клиент> | список клиентов | в архив клиента <клиент>',
  'создай доску <название> в проекте <клиент>',
  'встреча с <клиент> <когда> в <время> [в Телемосте|в Zoom|в офисе]',
  'перенеси встречу <слова> на <когда> в <время> | отмени встречу <слова> | встречи на неделе',
  'создай медиаплан для <клиент> на <N> месяца [для интернет-магазина] | открой медиаплан <слова>',
  'создай КП для <клиент> | создай стратегию для <клиент> | создай отчёт для <клиент> за <месяц> | открой документ <слова>',
  'новые заявки | горячие заявки за неделю | сколько заявок за месяц | открой заявку <номер>',
  'возьми заявку <номер> | заявка <номер> спам|отказ|сделка|кп отправлено | заведи клиента по заявке <номер>',
  'открой <раздел: главная, документы, шаблоны, медиапланы, нормативы, задачи, мои задачи, клиенты, календарь, квалификатор, воронка, сводка, регламенты, профиль, внешний вид>',
  'опубликуй в новости: <текст> | покажи новости',
  'запусти регламент <название> для <клиент> | открой регламент <слова> | что нового | включи тёмную тему | включи светлую тему',
  'найди в интернете <запрос>',
].map((x) => `— ${x}`).join('\n');

export function createAssistant({ db, crm, calendar, auth, ai, search, kb, log = null, mediaplans = null, library = null, leads = null, reports = null, notify = null, news = null }) {
  const q = {
    history: db.prepare('SELECT role, text, meta, created_at FROM assistant_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    add: db.prepare('INSERT INTO assistant_messages (user_id, role, text, meta) VALUES (?, ?, ?, ?)'),
    clear: db.prepare('DELETE FROM assistant_messages WHERE user_id = ?'),
    lastFocus: db.prepare("SELECT meta FROM assistant_messages WHERE user_id = ? AND role = 'assistant' AND meta LIKE '%\"focus\"%' ORDER BY id DESC LIMIT 1"),
  };

  const history = (userId, limit = 40) =>
    q
      .history.all(userId, limit)
      .reverse()
      .map((m) => ({ role: m.role, text: m.text, ...(m.meta ? JSON.parse(m.meta) : {}), created_at: m.created_at }));

  /** Последняя задача или встреча, о которой шла речь: «перенеси на пятницу» без названия. */
  const focus = (userId) => {
    const row = q.lastFocus.get(userId);
    return row ? JSON.parse(row.meta).focus ?? null : null;
  };

  const team = () => (auth ? auth.listUsers().filter((u) => !u.disabled) : []);
  const clients = () => (crm ? crm.listClients() : []);

  // ---------- поручения ----------

  function agenda(user, range, now = new Date(), only = null) {
    if (!crm) return { reply: 'Задачи недоступны.' };
    const today = todayMsk(now);
    const open = crm.listTasks({ mine: user.id, open: true });
    const until = { today, tomorrow: addDays(today, 1), week: addDays(today, 7), overdue: today, open: '9999-12-31' }[range];
    const from = range === 'tomorrow' ? addDays(today, 1) : null;
    const nowMsk = new Date(now.getTime() + MSK).toISOString().slice(0, 16).replace('T', ' ');
    let tasks = open.filter((t) => (range === 'open' ? true : t.due && t.due <= until && (!from || t.due >= from)));
    if (range === 'overdue') tasks = open.filter((t) => t.due && `${t.due} ${t.due_time ?? '23:59'}` < nowMsk);
    if (only === 'meetings') tasks = [];
    let meetings = [];
    if (calendar && range !== 'overdue' && range !== 'open') {
      const start = from ?? today;
      meetings = calendar
        .list({ from: `${start}T00:00:00+03:00`, to: `${addDays(until, 1)}T00:00:00+03:00`, userId: user.id })
        .filter((m) => !m.cancelled);
    }
    const title = only === 'meetings' ? { today: 'Встречи сегодня', tomorrow: 'Встречи завтра', week: 'Встречи на неделю' }[range] : { today: 'На сегодня', tomorrow: 'На завтра', week: 'На неделю', overdue: 'Просрочено', open: 'Ваши открытые задачи' }[range];
    if (!tasks.length && !meetings.length) {
      if (only === 'meetings') return { reply: `${title}: нет.` };
      return { reply: range === 'overdue' ? 'Просроченных задач нет.' : `${title}: ни задач, ни встреч. Можно взяться за то, что без срока.` };
    }
    const lines = [`${title}:`];
    for (const m of meetings) {
      const t = mskTime(m.starts_at);
      lines.push(`• ${range === 'today' || range === 'tomorrow' ? '' : `${fmtDay(t.date)}, `}${t.time} — встреча «${m.title}»${m.client_name ? ` (${m.client_name})` : ''}`);
    }
    for (const t of tasks) {
      const late = t.due && `${t.due} ${t.due_time ?? '23:59'}` < nowMsk;
      lines.push(`• ${late ? '🔴 ' : ''}${t.title}${t.client_name ? ` — ${t.client_name}` : ''}, ${fmtDue(t)}`);
    }
    return {
      reply: lines.join('\n'),
      actions: [
        ...meetings.slice(0, 8).map((m) => ({ type: 'meeting', id: m.id, title: m.title, href: `#/calendar?meeting=${m.id}` })),
        ...tasks.slice(0, 12).map((t) => ({ type: 'task', id: t.id, title: t.title, href: taskHref(t) })),
      ],
    };
  }

  function createTask(user, cmd) {
    const task = crm.createTask(
      { title: cmd.title, clientId: cmd.client?.id ?? null, assigneeId: cmd.assignee?.id ?? user.id, due: cmd.date, dueTime: cmd.date ? cmd.time : null, priority: cmd.priority, repeat: cmd.repeat ?? null },
      user,
    );
    const who = !cmd.assignee || cmd.assignee.id === user.id ? 'вы' : cmd.assignee.name;
    const parts = [`проект «${task.client_name ?? 'Общие задачи'}»`, `срок — ${fmtDue(task)}`, `ответственный — ${who}`];
    if (task.priority >= 3) parts.push(task.priority === 4 ? 'критично' : 'важно');
    if (task.repeat) parts.push(`повтор — ${{ daily: 'каждый день', weekdays: 'по будням', weekly: 'каждую неделю', biweekly: 'раз в две недели', monthly: 'каждый месяц', quarterly: 'каждый квартал' }[task.repeat]}`);
    return {
      reply: `Поставил задачу «${task.title}»: ${parts.join(', ')}.`,
      actions: [{ type: 'task', id: task.id, title: task.title, href: taskHref(task), client: task.client_name, created: true }],
      focus: { type: 'task', id: task.id },
    };
  }

  /** Задача по словам; если неоднозначно — варианты для уточнения. */
  function findTask(user, query) {
    const ref = /#(\d+)/.exec(query ?? '');
    if (ref) {
      try {
        return { task: crm.getTask(Number(ref[1])) };
      } catch {
        return { error: `Задачи #${ref[1]} нет.` };
      }
    }
    const pronoun = !query || /^(е[её]|эту|ту|последнюю|её же)$/i.test(query.trim());
    if (pronoun) {
      const f = focus(user.id);
      if (f?.type === 'task') return { task: crm.getTask(f.id) };
      return { error: 'Уточните, какую задачу — назовите пару слов из названия.' };
    }
    const text = (t) => `${t.title} ${t.client_name ?? ''}`;
    const mine = crm.listTasks({ mine: user.id, open: true });
    let m = bestMatch(query, mine, text);
    if (!m.item && !m.candidates.length) m = bestMatch(query, crm.listTasks({ open: true }), text);
    if (m.item) return { task: m.item };
    if (m.candidates.length) return { ambiguous: m.candidates };
    return { error: `Не нашёл задачу «${query}». Назовите иначе или откройте раздел «Задачи».` };
  }

  const choose = (candidates, verb) => ({
    reply: `Нашёл несколько похожих — какую ${verb}?`,
    options: candidates.map((t) => ({ label: `${t.title}${t.client_name ? ` — ${t.client_name}` : ''}`, command: `${verb === 'закрыть' ? 'закрой задачу' : 'перенеси задачу'} #${t.id}` })),
  });

  function taskDone(user, cmd) {
    const r = findTask(user, cmd.query);
    if (r.error) return { reply: r.error };
    if (r.ambiguous) return choose(r.ambiguous, 'закрыть');
    const t = crm.updateTask(r.task.id, { done: true }, user);
    return { reply: `Готово: «${t.title}» отмечена выполненной.`, actions: [{ type: 'task', id: t.id, title: t.title, href: taskHref(t) }], focus: { type: 'task', id: t.id } };
  }

  function taskMove(user, cmd, now = new Date()) {
    if (!cmd.date && !cmd.time) return { reply: 'На когда перенести? Например: «перенеси отчёт на пятницу в 12».' };
    const r = findTask(user, cmd.query);
    if (r.error) return { reply: r.error };
    if (r.ambiguous) {
      const when = [cmd.date ? fmtDay(cmd.date) : '', cmd.time ? `в ${cmd.time}` : ''].join(' ').trim();
      return { reply: `Нашёл несколько похожих — какую перенести на ${when}?`, options: r.ambiguous.map((t) => ({ label: `${t.title}${t.client_name ? ` — ${t.client_name}` : ''}`, command: `перенеси задачу #${t.id} ${cmd.date ? cmd.date.split('-').reverse().slice(0, 2).join('.') : ''} ${cmd.time ? `в ${cmd.time}` : ''}`.trim() })) };
    }
    const due = cmd.date ?? r.task.due ?? todayMsk(now);
    const t = crm.updateTask(r.task.id, { due, dueTime: cmd.time ?? r.task.due_time ?? null }, user);
    return { reply: `Перенёс «${t.title}» на ${fmtDue(t)}.`, actions: [{ type: 'task', id: t.id, title: t.title, href: taskHref(t) }], focus: { type: 'task', id: t.id } };
  }

  function createMeeting(user, cmd) {
    if (!calendar) return { reply: 'Календарь недоступен.' };
    if (!cmd.date || !cmd.time) return { reply: 'Когда встреча? Например: «встреча с Таллером в четверг в 15».' };
    const m = calendar.create(
      { title: cmd.title, startsAt: `${cmd.date}T${cmd.time}:00+03:00`, clientId: cmd.client?.id ?? null, format: cmd.format, provider: cmd.provider, participants: [user.id] },
      user,
    );
    const video = cmd.provider ? ` Ссылку ${cmd.provider === 'telemost' ? 'Телемоста' : 'Zoom'} создайте кнопкой в карточке встречи.` : '';
    return {
      reply: `Запланировал «${m.title}» на ${fmtDay(cmd.date)} в ${cmd.time} (по Москве), напомню в Telegram за сутки и за 15 минут.${video}`,
      actions: [{ type: 'meeting', id: m.id, title: m.title, href: `#/calendar?meeting=${m.id}` }],
      focus: { type: 'meeting', id: m.id },
    };
  }

  function moveMeeting(user, cmd, now = new Date()) {
    if (!calendar) return { reply: 'Календарь недоступен.' };
    const today = todayMsk(now);
    const upcoming = calendar
      .list({ from: `${today}T00:00:00+03:00`, to: `${addDays(today, 60)}T00:00:00+03:00`, userId: user.id })
      .filter((m) => !m.cancelled);
    const f = focus(user.id);
    let m = !cmd.query && f?.type === 'meeting' ? upcoming.find((x) => x.id === f.id) : null;
    if (!m) {
      const r = bestMatch(cmd.query, upcoming, (x) => `${x.title} ${x.client_name ?? ''}`);
      if (r.candidates.length > 1) return { reply: 'Какую встречу перенести?', options: r.candidates.map((x) => ({ label: `${x.title} — ${fmtDay(mskTime(x.starts_at).date)} ${mskTime(x.starts_at).time}`, command: `открыть встречу #${x.id}` })) };
      m = r.item;
    }
    if (!m) return { reply: `Не нашёл встречу «${cmd.query}» в ближайшие два месяца.` };
    const cur = mskTime(m.starts_at);
    const date = cmd.date ?? cur.date;
    const time = cmd.time ?? cur.time;
    const moved = calendar.update(m.id, { startsAt: `${date}T${time}:00+03:00` });
    return { reply: `Перенёс «${moved.title}» на ${fmtDay(date)} в ${time}. Участникам придут напоминания по новому времени.`, actions: [{ type: 'meeting', id: m.id, title: moved.title, href: `#/calendar?meeting=${m.id}` }], focus: { type: 'meeting', id: m.id } };
  }

  // ---------- поиск и разговор ----------

  async function webSearch(user, query, prefs) {
    if (prefs?.webSearch === 'off') return { reply: 'Поиск в интернете выключен в настройках ассистента («Внешний вид» → «Ассистент»).' };
    if (!search?.enabled) return { reply: 'Поиск в интернете пока не подключён. Администратор включает его на странице «Сотрудники» → «Подключения».' };
    const { results } = await search.search(query, { count: 5 });
    if (!results.length) return { reply: `По запросу «${query}» ничего не нашлось.` };
    const sources = results.map((r) => ({ title: r.title, url: r.url }));
    if (!ai?.enabled) {
      return { reply: `Нашёл по запросу «${query}»:\n${results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join('\n')}`, sources };
    }
    const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
    const { text } = await ai.complete({
      system: `${systemPrompt(user, prefs)}\nНиже — результаты поиска в интернете. Ответь на вопрос по ним, кратко; после утверждений ставь номер источника в квадратных скобках, например [2]. Если в результатах ответа нет — так и скажи.`,
      user: `Вопрос: ${query}\n\nРезультаты поиска:\n${context}`,
      maxTokens: 1500,
    });
    track(user, 'assistant_search', query, text);
    return { reply: text.trim(), sources };
  }

  function systemPrompt(user, prefs = {}) {
    const name = prefs.assistantName || DEFAULT_NAME;
    const you = prefs.address === 'ty' ? 'Обращайся к собеседнику на «ты».' : 'Обращайся к собеседнику на «вы».';
    return [
      `Ты — ${name}, рабочий ИИ-ассистент сотрудников агентства интернет-маркетинга Soroka Marketing (контекстная и таргетированная реклама, SEO, аналитика, маркетплейсы).`,
      'Помогаешь с задачами: разложить задачу на шаги, подсказать порядок работы по регламентам агентства, составить текст, ТЗ, письмо клиенту, идеи для рекламы.',
      'Отвечай по-русски, коротко и по делу, списками, где это удобно. Не выдумывай цифры, ставки, сроки и факты о клиентах; если данных нет — скажи прямо и предложи, где их взять.',
      'Регламенты агентства (если приведены ниже) — главный источник о том, как в агентстве принято работать; ссылайся на них по названию.',
      'В кабинете есть разделы: Документы (КП, стратегии, отчёты по шаблонам), Медиапланы (калькулятор с Excel), Задачи (проекты по клиентам), Календарь (встречи с Zoom и Телемостом), Квалификатор (заявки с сайта). Если задачу удобнее решить в разделе — подскажи, в каком.',
      'Метки вида {{email_1}} или {{phone_1}} — скрытые контакты; используй их как есть.',
      `Сегодня ${new Date(Date.now() + MSK).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.`,
      'Ты умеешь выполнять действия в кабинете. Если сотрудник просит что-то сделать (создать, добавить, поручить, перенести, закрыть, назначить, отменить, открыть, показать данные), НЕ объясняй, как это сделать вручную, а ответь только строками вида «КОМАНДА: <фраза>» — по строке на действие, не больше пяти. Фразы строй строго по образцам:',
      COMMAND_SAMPLES,
      'Имена клиентов, сотрудников, названия задач и сроки бери из просьбы как есть. Если для действия не хватает данных — спроси коротко, без КОМАНДА.',
      you,
      prefs.webSearch !== 'off' && search?.enabled
        ? 'Если для ответа нужны свежие данные из интернета (правила и требования площадок, цены, новости, сведения о компании), ответь ровно одной строкой без пояснений: ПОИСК: <поисковый запрос>.'
        : 'Поиска в интернете нет — отвечай по своим знаниям и предупреждай, если сведения могли устареть.',
    ].join('\n');
  }

  function track(user, action, input, output, error = null) {
    log?.run(user.id, action, ai?.provider ?? null, ai?.model ?? null, String(input ?? '').length, String(output ?? '').length, 0, error ? 0 : 1, error);
  }

  async function chat(user, message, context, prefs) {
    if (!ai?.enabled) {
      return { reply: `Этого я пока не понял. Свободный разговор заработает, когда администратор подключит YandexGPT («Сотрудники» → «Подключения»).\n\n${act.help()}` };
    }
    const mask = createMask({});
    const kbParts = kb ? kb.search(`${message} ${context?.task?.title ?? ''}`) : [];
    const kbText = kbParts.length ? `\n\nРегламенты агентства (фрагменты):\n${kbParts.map((c) => `— «${c.title}», раздел «${c.section}»:\n${c.text}`).join('\n\n')}` : '';
    const ctxText = context?.task
      ? `\n\nСотрудник сейчас смотрит задачу «${context.task.title}»${context.task.client ? ` (клиент «${context.task.client}»)` : ''}${context.task.description ? `. Описание: ${context.task.description}` : ''}.`
      : context?.page
        ? `\n\nСотрудник сейчас в разделе «${context.page}».`
        : '';
    // прошлые реплики без только что записанного вопроса — он уходит отдельно
    const past = history(user.id, 13).slice(0, -1).map((m) => ({ role: m.role, text: mask.maskText(m.text) }));
    const system = systemPrompt(user, prefs) + mask.maskText(kbText + ctxText);
    let { text } = await ai.complete({ system, user: mask.maskText(message), history: past, maxTokens: 2000 });
    track(user, 'assistant', message, text);
    const commands = [...mask.restore(text).matchAll(/^\s*КОМАНДА:\s*(.+)$/gim)].map((m) => m[1].trim().replace(/^[«"]|[»"]$/g, '')).slice(0, 5);
    if (commands.length) return runCommands(user, commands, { context, prefs, now: new Date() });
    const wantSearch = /^\s*ПОИСК:\s*(.+)$/im.exec(text);
    if (wantSearch && search?.enabled && prefs?.webSearch !== 'off') {
      const found = await webSearch(user, wantSearch[1].trim(), prefs);
      return { ...found, searched: wantSearch[1].trim(), kb: kbParts.map((c) => c.title) };
    }
    text = mask.restore(text.replace(/^\s*ПОИСК:.*$/im, '').trim());
    return { reply: text, kb: [...new Set(kbParts.map((c) => c.title))] };
  }

  const act = createActions({ crm, calendar, auth, mediaplans, library, leads, reports, notify, kb, news, findTask, choose });

  /** Разбор фразы правилами: каталог phrases.js, затем commands.js. */
  const parse = (text, now) => {
    const ctx = { clients: clients(), team: team(), now };
    const t = normalize(text);
    return parsePhrase(t, ctx) ?? parseCommand(t, ctx);
  };

  /** Выполнить разобранное поручение. null — правилами не разобрано. */
  async function run(user, cmd, text, { context, prefs, now }) {
    switch (cmd.intent) {
      case 'help':
        return { reply: act.help() };
      case 'agenda':
        return agenda(user, cmd.range, now, cmd.only);
      case 'task_create':
        return crm ? createTask(user, cmd) : { reply: 'Задачи недоступны.' };
      case 'task_done':
        return taskDone(user, cmd);
      case 'task_move':
        return taskMove(user, cmd, now);
      case 'meeting':
        return createMeeting(user, cmd);
      case 'meeting_move':
        return moveMeeting(user, cmd, now);
      case 'search':
        return webSearch(user, cmd.query, prefs);
      default:
        return typeof act[cmd.intent] === 'function' ? act[cmd.intent](user, cmd, { now, context }) : null;
    }
  }

  /** Фразы, в которые модель переписала просьбу, — выполняем по очереди теми же правилами. */
  async function runCommands(user, commands, opts) {
    const done = [];
    for (const c of commands) {
      const cmd = parse(c, opts.now);
      const out = cmd.intent === 'chat' || cmd.intent === 'search' ? null : await run(user, cmd, c, opts);
      if (out) done.push(out);
    }
    if (!done.length) return { reply: `Не понял, что именно сделать. Попробуйте сказать иначе — например, так:\n\n${act.help()}` };
    if (done.length === 1) return { ...done[0], via: 'ai' };
    return {
      reply: done.map((o) => o.reply).join('\n\n'),
      actions: done.flatMap((o) => o.actions ?? []),
      options: done.flatMap((o) => o.options ?? []),
      navigate: done.findLast((o) => o.navigate)?.navigate,
      prefs: done.findLast((o) => o.prefs)?.prefs,
      focus: done.findLast((o) => o.focus)?.focus,
      via: 'ai',
    };
  }

  return {
    history: (userId) => history(userId),
    clear: (userId) => q.clear.run(userId),
    /**
     * Сообщение сотрудника. context — где он сейчас: { page, task: { id, title, client, description } }.
     * Ответ: { reply, actions?, options?, sources?, kb? }.
     */
    async handle(user, message, { context = {}, prefs = {}, now = new Date() } = {}) {
      const text = String(message ?? '').trim().slice(0, 4000);
      if (!text) return { reply: 'Напишите, что нужно сделать.' };
      q.add.run(user.id, 'user', text, null);
      let out;
      try {
        const open = /^открыть встречу #(\d+)$/i.exec(text);
        if (open) out = { reply: 'Открываю встречу.', actions: [{ type: 'meeting', id: Number(open[1]), title: 'Встреча', href: `#/calendar?meeting=${open[1]}` }], navigate: `#/calendar?meeting=${open[1]}` };
        else {
          const cmd = parse(text, now);
          out = cmd.intent === 'chat' ? null : await run(user, cmd, text, { context, prefs, now });
          // широкие правила («отчёт готов») могли зацепить не то — тогда пусть разберётся модель
          if (out?.notFound && ai?.enabled && cmd.loose !== false) out = (await chat(user, text, context, prefs)) ?? out;
          out ??= await chat(user, text, context, prefs);
        }
      } catch (err) {
        track(user, 'assistant', text, '', err.message);
        out = { reply: `Не получилось: ${err.message}`, error: true };
      }
      const { reply, ...meta } = out;
      q.add.run(user.id, 'assistant', reply, Object.keys(meta).length ? JSON.stringify(meta) : null);
      return out;
    },
  };
}
