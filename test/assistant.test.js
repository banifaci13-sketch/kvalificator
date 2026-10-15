import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/storage/db.js';
import { createAuth } from '../src/admin/auth.js';
import { createCrm } from '../src/crm/store.js';
import { createCalendar } from '../src/calendar/store.js';
import { createAi } from '../src/ai/client.js';
import { createAssistant } from '../src/assistant/index.js';
import { createKb, chunk } from '../src/assistant/kb.js';
import { createSearch, parseYandexXml } from '../src/assistant/search.js';
import { parseWhen } from '../src/assistant/when.js';
import { parseCommand, bestMatch } from '../src/assistant/commands.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadBrand } from '../src/brand/index.js';
import { createDocLibrary } from '../src/docs/library.js';
import { createMediaplans } from '../src/mediaplan/store.js';
import { createReports } from '../src/admin/reports.js';
import { createNotifications } from '../src/notify/store.js';
import { createMoney } from '../src/crm/money.js';

// вторник, 13 октября 2026, 12:00 по Москве
const NOW = new Date('2026-10-13T09:00:00Z');

test('сроки из речи: дни, даты, время, «через», дни недели', () => {
  const cases = [
    ['созвониться с Ромашкой завтра в 11', '2026-10-14', '11:00', 'созвониться с Ромашкой'],
    ['отчёт в пятницу', '2026-10-16', null, 'отчёт'],
    ['КП 14 октября к 18:00', '2026-10-14', '18:00', 'КП'],
    ['медиаплан через неделю', '2026-10-20', null, 'медиаплан'],
    ['позвонить в 3', '2026-10-13', '15:00', 'позвонить'],
    ['встреча послезавтра в 7 вечера', '2026-10-15', '19:00', 'встреча'],
    ['бриф 20.10 в 10:30', '2026-10-20', '10:30', 'бриф'],
    ['макеты на следующей неделе', '2026-10-19', null, 'макеты'],
    ['планёрка во вторник', '2026-10-20', null, 'планёрка'],
    ['отчёт 5 января', '2027-01-05', null, 'отчёт'],
    ['созвон завтра 11:30', '2026-10-14', '11:30', 'созвон'],
    ['просто задача', null, null, 'просто задача'],
  ];
  for (const [text, date, time, rest] of cases) assert.deepEqual(parseWhen(text, NOW), { date, time, rest }, text);
});

test('поручения: задача, исполнитель, клиент, важность, закрыть, перенести, встреча, сводка, поиск', () => {
  const clients = [{ id: 1, name: 'Таллер' }, { id: 2, name: 'ООО «Северный дом»' }, { id: 3, name: 'Ромашка' }];
  const team = [{ id: 1, name: 'Анна Сорокина' }, { id: 2, name: 'Даниил Карацапов' }];
  const p = (t) => parseCommand(t, { clients, team, now: NOW });

  const a = p('поставь задачу созвонится с Ромашкой завтра в 11');
  assert.deepEqual([a.intent, a.title, a.client.name, a.date, a.time], ['task_create', 'Созвониться с Ромашкой', 'Ромашка', '2026-10-14', '11:00'], 'имя клиента-собеседника остаётся в названии');
  const b = p('поручи Даниилу сделать медиаплан для Таллера до пятницы срочно');
  assert.deepEqual([b.title, b.client.name, b.assignee.name, b.date, b.priority], ['Сделать медиаплан', 'Таллер', 'Даниил Карацапов', '2026-10-16', 3], 'приписка «для Таллера» уходит в ярлык клиента');
  assert.equal(p('задача: подготовить КП для Северного дома 20.10').client.name, 'ООО «Северный дом»');
  assert.deepEqual(p('закрой задачу по лендингу'), { intent: 'task_done', query: 'по лендингу' });
  assert.deepEqual(p('перенеси отчёт на пятницу в 12'), { intent: 'task_move', query: 'отчёт', date: '2026-10-16', time: '12:00' });
  const m = p('встреча с Таллером в четверг в 15 в телемосте');
  assert.deepEqual([m.intent, m.client.name, m.date, m.time, m.provider], ['meeting', 'Таллер', '2026-10-15', '15:00', 'telemost']);
  assert.deepEqual(p('что у меня завтра'), { intent: 'agenda', range: 'tomorrow' });
  assert.deepEqual(p('найди в интернете требования SberAds к баннерам'), { intent: 'search', query: 'требования SberAds к баннерам' });
  assert.equal(p('как написать ТЗ на баннер?').intent, 'chat');

  const items = [{ title: 'Отчёт за сентябрь', client_name: 'Таллер' }, { title: 'Отчёт по РК', client_name: 'Ромашка' }];
  const text = (x) => `${x.title} ${x.client_name}`;
  assert.equal(bestMatch('отчёт', items, text).candidates.length, 2, 'одинаково подходят — переспросить, а не угадывать');
  assert.equal(bestMatch('отчёт таллеру', items, text).item.title, 'Отчёт за сентябрь');
});

test('выдача Яндекса: заголовки, ссылки, фрагменты без разметки; ошибка поиска', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><yandexsearch><response><results><grouping><group><doc id="1">
    <url>https://ads.example.ru/rules</url><title>Требования к <hlword>баннерам</hlword> &amp; форматы</title>
    <passages><passage>Размер файла — до 150 КБ.</passage><passage>Форматы JPG, PNG.</passage></passages></doc></group></grouping></results></response></yandexsearch>`;
  assert.deepEqual(parseYandexXml(xml), [{ title: 'Требования к баннерам & форматы', url: 'https://ads.example.ru/rules', snippet: 'Размер файла — до 150 КБ. … Форматы JPG, PNG.' }]);
  assert.throws(() => parseYandexXml('<yandexsearch><response><error code="32">Лимит запросов исчерпан</error></response></yandexsearch>'), /Лимит запросов/);
});

test('поиск: сначала API v2 (base64), при ошибке — XML-выдача', async () => {
  const xml = '<yandexsearch><doc><url>https://a.ru</url><title>Кириллица в ответе</title><headline>текст</headline></doc></yandexsearch>';
  const calls = [];
  const ok = createSearch({ apiKey: 'k', folderId: 'f' }, {
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ rawData: Buffer.from(xml).toString('base64') }), { status: 200 });
    },
  });
  assert.equal((await ok.search('тест')).results[0].title, 'Кириллица в ответе', 'base64 → UTF-8 без потери кириллицы');
  assert.match(calls[0], /searchapi\.api\.cloud\.yandex\.net\/v2\/web\/search/);

  const fallback = createSearch({ apiKey: 'k', folderId: 'f' }, {
    fetchImpl: async (url) => (String(url).includes('searchapi') ? new Response('{}', { status: 403 }) : new Response(xml, { status: 200 })),
  });
  assert.equal((await fallback.search('тест')).results.length, 1);
  assert.equal(createSearch({}).enabled, false);
});

test('регламенты: фрагменты по разделам, подбор к вопросу', () => {
  const db = openDb(':memory:');
  const kb = createKb({ db: db.raw });
  kb.create({ title: 'Подготовка КП', body: '# Сбор данных\nУточнить у клиента бюджет и регион.\n\n# Сроки\nКП отправляем клиенту в течение двух рабочих дней после брифа.' }, { name: 'Анна' });
  kb.create({ title: 'Запуск рекламы', body: 'Перед запуском проверить счётчик Метрики и цели.' }, { name: 'Анна' });
  assert.equal(chunk({ id: 1, title: 'X', body: '# A\nтекст\n\n# B\nещё' }).length, 2);
  const found = kb.search('за сколько дней отправляем КП клиенту?');
  assert.equal(found[0].title, 'Подготовка КП');
  assert.equal(found[0].section, 'Сроки');
  assert.equal(kb.search('метрика цели')[0].title, 'Запуск рекламы');
});

function setup({ ai = null, search = null, full = false } = {}) {
  const db = openDb(':memory:');
  const auth = createAuth(db.raw);
  const anna = auth.addUser('anna', 'Анна Сорокина', { password: 'correct-horse-battery', role: 'admin' }).user;
  const dan = auth.addUser('daniil', 'Даниил Карацапов', { password: 'correct-horse-battery' }).user;
  const crm = createCrm({ db: db.raw });
  const calendar = createCalendar({ db: db.raw });
  const kb = createKb({ db: db.raw });
  const talle = crm.createClient({ name: 'Таллер' }, anna);
  const extra = {};
  if (full) {
    extra.library = createDocLibrary({ db: db.raw, brand: loadBrand(), templatesDir: resolve(import.meta.dirname, '../templates/decks'), dataDir: mkdtempSync(join(tmpdir(), 'assist-')) });
    extra.mediaplans = createMediaplans({ db: db.raw, library: extra.library });
    extra.reports = createReports(db.raw);
    extra.leads = db;
    extra.notify = createNotifications({ db: db.raw });
    crm.useNotify(extra.notify);
    extra.money = createMoney({ db: db.raw, notify: extra.notify });
  }
  const assistant = createAssistant({ db: db.raw, crm, calendar, auth, ai, search, kb, ...extra });
  return { db, auth, crm, calendar, kb, assistant, anna, dan, talle, ...extra };
}

test('ассистент: ставит, закрывает и переносит задачи; переспрашивает, если похожих несколько', async () => {
  const { assistant, crm, anna, dan, talle } = setup();
  const r1 = await assistant.handle(anna, 'поручи Даниилу сделать медиаплан для Таллера до пятницы', { now: NOW });
  assert.match(r1.reply, /Поставил задачу «Сделать медиаплан»: проект «Таллер», срок — 16 октября, ответственный — Даниил Карацапов/);
  const task = crm.getTask(r1.actions[0].id);
  assert.deepEqual([task.client_id, task.assignee_id, task.due], [talle.id, dan.id, '2026-10-16']);

  // «перенеси на понедельник» сразу после постановки — без названия, по фокусу диалога
  await assistant.handle(anna, 'поставь задачу отчёт за сентябрь для Таллера', { now: NOW });
  const moved = await assistant.handle(anna, 'перенеси её на понедельник в 12', { now: NOW });
  assert.match(moved.reply, /Перенёс «Отчёт за сентябрь» на 19 октября к 12:00/);

  await assistant.handle(anna, 'поставь задачу отчёт по РК', { now: NOW });
  const amb = await assistant.handle(anna, 'закрой задачу отчёт', { now: NOW });
  assert.equal(amb.options.length, 2, 'две задачи с «отчётом» — переспросить');
  const picked = await assistant.handle(anna, amb.options[0].command, { now: NOW });
  assert.match(picked.reply, /отмечена выполненной/);

  const none = await assistant.handle(anna, 'закрой задачу про космос', { now: NOW });
  assert.match(none.reply, /Не нашёл задачу/);
  assert.ok(assistant.history(anna.id).length >= 10, 'диалог сохраняется');
});

test('ассистент: встреча и сводка «что у меня»', async () => {
  const { assistant, anna } = setup();
  const m = await assistant.handle(anna, 'встреча с Таллером завтра в 15', { now: NOW });
  assert.match(m.reply, /Запланировал «Встреча с Таллером» на 14 октября в 15:00/);
  const ask = await assistant.handle(anna, 'встреча с Таллером', { now: NOW });
  assert.match(ask.reply, /Когда встреча/);
  await assistant.handle(anna, 'поставь задачу проверить РК завтра в 10', { now: NOW });
  const agenda = await assistant.handle(anna, 'что у меня завтра', { now: NOW });
  assert.match(agenda.reply, /На завтра:/);
  assert.match(agenda.reply, /15:00 — встреча «Встреча с Таллером»/);
  assert.match(agenda.reply, /Проверить РК/);
});

test('ассистент без ИИ: подсказывает, что умеет; с ИИ — регламенты в контексте, почта скрыта, поиск по запросу модели', async () => {
  const plain = setup();
  const r = await plain.assistant.handle(plain.anna, 'как лучше написать ТЗ на баннер?', { now: NOW });
  assert.match(r.reply, /подключит YandexGPT/);
  assert.match(r.reply, /поставь задачу/);

  const sent = [];
  let step = 0;
  const ai = createAi(
    { provider: 'yandexgpt', yandexApiKey: 'k', yandexFolderId: 'f', yandexModel: 'yandexgpt/latest' },
    {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        sent.push(body);
        step += 1;
        const text = step === 2 ? 'ПОИСК: требования SberAds к баннерам 2026' : step === 3 ? 'Размер — до 150 КБ [1].' : 'Отправьте КП за два рабочих дня, ответ клиенту на {{email_1}}.';
        return new Response(JSON.stringify({ result: { alternatives: [{ message: { text } }], usage: {} } }), { status: 200 });
      },
    },
  );
  const search = { enabled: true, search: async () => ({ results: [{ title: 'Требования', url: 'https://ads.example.ru', snippet: 'до 150 КБ' }] }) };
  const s = setup({ ai, search });
  s.kb.create({ title: 'Подготовка КП', body: '# Сроки\nКП отправляем клиенту в течение двух рабочих дней после брифа.' }, s.anna);
  const answer = await s.assistant.handle(s.anna, 'когда отправлять КП? клиент пишет с ivan@romashka.ru', { now: NOW, context: { page: 'Задачи' } });
  const prompt = JSON.stringify(sent[0]);
  assert.match(prompt, /Подготовка КП/, 'фрагмент регламента — в контексте модели');
  assert.doesNotMatch(prompt, /ivan@romashka\.ru/, 'почта в модель не уходит');
  assert.match(answer.reply, /ivan@romashka\.ru/, 'в ответе почта восстановлена');
  assert.deepEqual(answer.kb, ['Подготовка КП']);

  const web = await s.assistant.handle(s.anna, 'какие сейчас требования SberAds к баннерам?', { now: NOW });
  assert.equal(web.reply, 'Размер — до 150 КБ [1].');
  assert.deepEqual(web.sources, [{ title: 'Требования', url: 'https://ads.example.ru' }]);
  assert.equal(sent[1].messages.length >= 3, true, 'прошлые реплики уходят в модель как история');

  const off = await s.assistant.handle(s.anna, 'найди ставки', { now: NOW, prefs: { webSearch: 'off' } });
  assert.match(off.reply, /выключен/);
});

test('ассистент выполняет действия по разделам без ИИ: клиент, доска, медиаплан, КП, заявки, исполнитель, тема', async () => {
  const s = setup({ full: true });
  const say = (t) => s.assistant.handle(s.anna, t, { now: NOW });

  const c = await say('добавь клиента Юнистрим, сайт unistream.ru');
  assert.match(c.reply, /Добавил клиента «Юнистрим» \(сайт unistream\.ru\)/);
  const client = s.crm.listClients().find((x) => x.name === 'Юнистрим');
  assert.equal(client.site, 'unistream.ru');
  assert.match((await say('создай клиента Юнистрим')).reply, /уже есть/, 'дубликат не заводим');

  const b = await say('создай доску Трафик в проекте Юнистрим');
  assert.match(b.reply, /Добавил доску «Трафик» в проект «Юнистрим»/);

  const mp = await say('создай медиаплан для Юнистрима на 6 месяцев');
  assert.match(mp.reply, /Создал медиаплан «Медиаплан — Юнистрим на 6 месяцев»/);
  assert.equal(s.mediaplans.get(mp.actions[0].id).spec.months, 6);
  assert.match(mp.navigate, /^#\/plan\?id=\d+$/);

  s.mediaplans.saveBenchmark({ channel: 'Яндекс Директ', model: 'cpc', cpc: 45, ctr: 5, cr: 3, note: 'Средние за 2026 год' }, 'Анна Сорокина');
  const mp2 = await say('сделай медиаплан для клиента таллер. источник яндекс директ и авито. бюджет 300000 и 100000 рублей');
  assert.match(mp2.reply, /Яндекс Директ — 300\s000 ₽ в месяц/);
  assert.match(mp2.reply, /«Авито» — в нормативах нет/);
  const rows = s.mediaplans.get(mp2.actions[0].id).spec.scenarios[0].rows;
  assert.deepEqual(rows.map((r) => [r.channel, r.budget, r.cpc]), [['Яндекс Директ', 300000, 45], ['Авито', 100000, null]]);

  const kp = await say('создай КП для Таллера');
  assert.match(kp.reply, /Создал «Коммерческое предложение — Таллер»/);
  const doc = s.library.getDocument(kp.actions[0].id);
  assert.ok(JSON.stringify(doc.spec).includes('Таллер'), 'клиент подставлен в шаблон');
  assert.ok(!JSON.stringify(doc.spec).includes('{{client}}'));

  // задача → передать, важность, комментарий с уведомлением
  await say('поставь задачу баннеры для Таллера на пятницу');
  assert.match((await say('передай задачу баннеры Даниилу')).reply, /теперь на Даниил Карацапов/);
  assert.match((await say('сделай задачу баннеры критичной')).reply, /критичная/);
  assert.match((await say('комментарий к задаче баннеры: макеты в папке')).reply, /Оставил комментарий/);
  const t = s.crm.listTasks({ open: true }).find((x) => x.title === 'Баннеры');
  assert.deepEqual([t.assignee_id, t.priority], [s.dan.id, 4]);
  assert.ok(s.notify.list(s.dan.id).some((n) => /Комментарий к задаче «Баннеры»/.test(n.text)));
  const del = await say('удали задачу баннеры');
  assert.match(del.reply, /Удалить задачу «Баннеры»/, 'удаление — только после подтверждения');
  await say(del.options[0].command);
  assert.ok(!s.crm.listTasks({}).some((x) => x.title === 'Баннеры'));

  // заявки
  const session = { id: 's1', channel: 'web', meta: {} };
  s.db.createSession({ id: 's1', token: 't', channel: 'web', state: {}, meta: {} });
  const lead = s.db.completeSession(session, { answers: { company: { raw: 'Глобал Стекло' } } }, { rating: 5, score: 90, reasons: [], tags: [] });
  const fresh = await say('новые заявки');
  assert.match(fresh.reply, /Новые заявки за неделю: 1/);
  assert.match(fresh.reply, /«Глобал Стекло» — уровень A/);
  const take = await say(`возьми заявку ${lead.id}`);
  assert.match(take.reply, /статус «В работе», ответственный — вы/);
  assert.equal(s.db.getLead(lead.id).assignee, 'Анна Сорокина');
  const fromLead = await say(take.options[0].command);
  assert.match(fromLead.reply, /Завёл клиента «Глобал Стекло» по заявке/);

  // навигация, тема, сводка по клиенту, справка
  assert.equal((await say('открой медиапланы')).navigate, '#/plans');
  const theme = await say('включи тёмную тему');
  assert.equal(theme.prefs.theme, 'dark');
  assert.equal(s.auth.getUser(s.anna.id).prefs.theme, 'dark');
  assert.match((await say('что по Юнистриму')).reply, /Медиапланов: 1/);
  s.kb.create({ title: 'Запуск рекламы', body: '# Бриф\n- Цели\n- Доступы\n\n# Настройка\n- Метрика\n- Кампании' }, s.anna);
  const run = await say('запусти регламент запуска рекламы для Таллера');
  assert.match(run.reply, /Запустил «Запуск рекламы» в проекте «Таллер»: новая доска и 2 задачи/);
  const steps = s.crm.listTasks({ clientId: s.talle.id }).filter((t) => t.title === 'Бриф' || t.title === 'Настройка');
  assert.equal(steps.length, 2);
  assert.deepEqual(s.crm.checklist(steps.find((t) => t.title === 'Бриф').id).map((c) => c.text), ['Цели', 'Доступы']);
  const help = await say('что ты умеешь');
  assert.match(help.reply, /добавь клиента/);
  assert.match(help.reply, /возьми заявку/);
});

test('ассистент с ИИ: свободную просьбу модель переписывает в фразы каталога, их выполняют правила', async () => {
  const replies = ['КОМАНДА: добавь клиента Юнистрим\nКОМАНДА: поставь задачу бриф для Юнистрима на завтра', 'Это свободный ответ.'];
  const sent = [];
  const ai = createAi(
    { provider: 'yandexgpt', yandexApiKey: 'k', yandexFolderId: 'f', yandexModel: 'yandexgpt/latest' },
    {
      fetchImpl: async (url, init) => {
        sent.push(JSON.parse(init.body));
        const text = replies.shift() ?? 'ок';
        return new Response(JSON.stringify({ result: { alternatives: [{ message: { text } }], usage: {} } }), { status: 200 });
      },
    },
  );
  const s = setup({ ai, full: true });
  const r = await s.assistant.handle(s.anna, 'слушай, у нас новый клиент Юнистрим, заведи его и запланируй мне на завтра бриф', { now: NOW });
  assert.match(JSON.stringify(sent[0]), /КОМАНДА/, 'модель знает про команды');
  assert.match(r.reply, /Добавил клиента «Юнистрим»/);
  assert.match(r.reply, /Поставил задачу «Бриф»: проект «Юнистрим»/);
  assert.equal(r.via, 'ai');
  // фразы из каталога модель не тратят
  const before = sent.length;
  await s.assistant.handle(s.anna, 'добавь клиента Ромашка', { now: NOW });
  assert.equal(sent.length, before, 'правила сработали без модели');
});

test('ассистент: деньги — ведение, счёт, оплата, должники', async () => {
  const s = setup({ full: true });
  const say = (t) => s.assistant.handle(s.anna, t, { now: NOW });
  assert.match((await say('ведение Таллер 80 000 в месяц до 10 числа')).reply, /Ведение «Таллер» — 80\s000 ₽ в месяц, оплата до 10 числа/);
  assert.match((await say('выставь счёт Таллеру 50 000 до 20.10 за аудит')).reply, /Записал счёт: Таллер — 50\s000 ₽, аудит, срок 20 октября/);
  const who = await say('кто должен');
  assert.match(who.reply, /Просрочено: 80\s000 ₽/, 'ведение за октябрь — срок 10-го, уже прошёл');
  assert.match(who.reply, /Таллер — 80\s000 ₽/);
  const amb = await say('Таллер оплатил');
  assert.equal(amb.options.length, 2, 'два счёта — переспросить');
  assert.match((await say('Таллер оплатил 80 000')).reply, /Отметил оплату: Таллер — 80\s000 ₽, ведение за октябрь 2026/);
  assert.match((await say('кто должен')).reply, /Просроченных оплат нет/);
});

test('ассистент: итоги встречи — задачи исполнителям в проекте клиента', async () => {
  const s = setup({ full: true });
  const say = (t) => s.assistant.handle(s.anna, t, { now: NOW });
  s.calendar.create({ title: 'Стратсессия Таллер', startsAt: '2026-10-13T10:00:00+03:00', clientId: s.talle.id, participants: [s.anna.id, s.dan.id] }, s.anna);
  const r = await say('итоги встречи с Таллером: Даниил — креативы для РСЯ до пятницы срочно; мне — согласовать бюджет завтра в 12');
  assert.match(r.reply, /Итоги встречи «Стратсессия Таллер» — поставил задач: 2 в проекте «Таллер»/);
  assert.match(r.reply, /Креативы для РСЯ — Даниил Карацапов, 16 октября/);
  const tasks = s.crm.listTasks({ clientId: s.talle.id });
  assert.ok(tasks.some((t) => t.title === 'Креативы для РСЯ' && t.assignee_id === s.dan.id && t.priority === 3));
});
