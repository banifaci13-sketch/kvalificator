// Каталог фраз ассистента: каждая фраза разбирается правилами, без ИИ.
// Если правило меняется — меняйте и docs/assistant-phrases.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhrase, normalize } from '../src/assistant/phrases.js';
import { parseCommand } from '../src/assistant/commands.js';

const clients = [{ id: 1, name: 'Таллер' }, { id: 2, name: 'ООО Ромашка' }, { id: 3, name: 'Клиника Медлайн' }];
const team = [{ id: 1, name: 'Анна Сорокина' }, { id: 2, name: 'Олег Петров' }, { id: 3, name: 'Даниил Карацапов' }];
const now = new Date('2026-10-14T09:00:00Z'); // среда, 12:00 по Москве
const parse = (raw) => {
  const t = normalize(raw);
  return parsePhrase(t, { clients, team, now }) ?? parseCommand(t, { clients, team, now });
};

const CASES = [
  // справка, уведомления, оформление
  ['что ты умеешь', { intent: 'help' }],
  ['Что умеешь?', { intent: 'help' }],
  ['помощь', { intent: 'help' }],
  ['что нового', { intent: 'notifications' }],
  ['уведомления', { intent: 'notifications' }],
  ['отметь все уведомления прочитанными', { intent: 'notifications_read' }],
  ['включи тёмную тему', { intent: 'theme', theme: 'dark' }],
  ['сделай светлую тему', { intent: 'theme', theme: 'light' }],
  ['ночной режим', { intent: 'theme', theme: 'dark' }],
  ['давай на ты', { intent: 'address', address: 'ty' }],
  // навигация
  ['открой медиапланы', { intent: 'navigate', section: 'plans' }],
  ['перейди в календарь', { intent: 'navigate', section: 'calendar' }],
  ['открой мои задачи', { intent: 'navigate', section: 'mytasks' }],
  ['открой главную', { intent: 'navigate', section: 'home' }],
  ['открой квалификатор', { intent: 'navigate', section: 'leads' }],
  ['перейди в нормативы', { intent: 'navigate', section: 'benchmarks' }],
  ['открой регламенты', { intent: 'navigate', section: 'kb' }],
  ['открой профиль', { intent: 'navigate', section: 'account' }],
  ['открой воронку', { intent: 'navigate', section: 'board' }],
  // клиенты
  ['добавь клиента Юнистрим', { intent: 'client_create', name: 'Юнистрим' }],
  ['Создай клиента «Юнистрим»', { intent: 'client_create', name: 'Юнистрим' }],
  ['заведи нового клиента Юнистрим, сайт unistream.ru, контакт Иван', { intent: 'client_create', name: 'Юнистрим', site: 'unistream.ru', contact: 'Иван' }],
  ['новый клиент Глобал Стекло +7 999 123-45-67', { intent: 'client_create', name: 'Глобал Стекло', phone: '+7 999 123-45-67' }],
  ['добавь проект Леокид', { intent: 'client_create', name: 'Леокид' }],
  ['заведи клиента по заявке 123', { intent: 'client_from_lead', leadId: 123 }],
  ['список клиентов', { intent: 'client_list' }],
  ['мои клиенты', { intent: 'client_list', mine: true }],
  ['что по Таллеру', { intent: 'client_info', client: { id: 1 } }],
  ['как дела у Ромашки?', null],
  ['что с Ромашкой?', { intent: 'client_info', client: { id: 2 } }],
  ['сводка по клиенту Медлайн', { intent: 'client_info', client: { id: 3 } }],
  ['открой клиента Таллер', { intent: 'client_open', client: { id: 1 } }],
  ['в архив клиента Ромашка', { intent: 'client_archive', client: { id: 2 } }],
  ['создай доску Трафик в проекте Таллер', { intent: 'board_create', name: 'Трафик', client: { id: 1 } }],
  ['добавь доску «Контент» для Ромашки', { intent: 'board_create', name: 'Контент', client: { id: 2 } }],
  // задачи: создание (commands.js)
  ['поставь задачу подготовить КП для Таллера на пятницу', { intent: 'task_create', title: 'Подготовить КП', client: { id: 1 }, date: '2026-10-16' }],
  ['поручи Даниилу сделать медиаплан до 20.10', { intent: 'task_create', assignee: { id: 3 }, date: '2026-10-20' }],
  ['напомни позвонить в Медлайн завтра в 11', { intent: 'task_create', date: '2026-10-15', time: '11:00' }],
  ['задача: обновить нормативы', { intent: 'task_create', title: 'Обновить нормативы' }],
  // задачи: изменения
  ['закрой задачу по лендингу', { intent: 'task_done', query: 'по лендингу' }],
  ['я сделал отчёт для Таллера', { intent: 'task_done', query: 'отчёт для Таллера' }],
  ['баннеры готовы', { intent: 'task_done', query: 'баннеры' }],
  ['верни в работу задачу отчёт', { intent: 'task_reopen', query: 'отчёт' }],
  ['перенеси отчёт на понедельник в 12', { intent: 'task_move', date: '2026-10-19', time: '12:00' }],
  ['срок по баннерам — завтра', { intent: 'task_move', date: '2026-10-15' }],
  ['поменяй срок задачи отчёт на 25.10', { intent: 'task_move', date: '2026-10-25' }],
  ['передай задачу баннеры Олегу', { intent: 'task_assign', query: 'баннеры', assignee: { id: 2 } }],
  ['назначь задачу отчёт на Даниила', { intent: 'task_assign', assignee: { id: 3 } }],
  ['пусть Олег сделает баннеры', { intent: 'task_assign', query: 'баннеры', assignee: { id: 2 } }],
  ['перекинь отчёт на меня', { intent: 'task_assign', me: true }],
  ['сделай задачу отчёт критичной', { intent: 'task_priority', query: 'отчёт', priority: 4 }],
  ['отметь баннеры как срочную', { intent: 'task_priority', priority: 3 }],
  ['важность задачи отчёт низкая', { intent: 'task_priority', priority: 1 }],
  ['комментарий к задаче баннеры: макеты в папке', { intent: 'task_comment', query: 'баннеры', text: 'макеты в папке' }],
  ['напиши в задачу отчёт: @Олег проверь цифры', { intent: 'task_comment', text: '@Олег проверь цифры' }],
  ['удали задачу тест', { intent: 'task_delete', query: 'тест', confirmed: false }],
  ['удали задачу #12 подтверждаю', { intent: 'task_delete', query: '#12', confirmed: true }],
  ['открой задачу баннеры', { intent: 'task_open', query: 'баннеры' }],
  ['где задача про отчёт?', { intent: 'task_open' }],
  // сводки
  ['что у меня сегодня', { intent: 'agenda', range: 'today' }],
  ['что у меня на неделе', { intent: 'agenda', range: 'week' }],
  ['мои задачи', { intent: 'agenda', range: 'open' }],
  ['какие у меня задачи', { intent: 'agenda', range: 'open' }],
  ['что горит', { intent: 'agenda', range: 'overdue' }],
  ['что у Олега', { intent: 'person_tasks', user: { id: 2 } }],
  ['задачи Даниила', { intent: 'person_tasks', user: { id: 3 } }],
  ['загрузка команды', { intent: 'team_load' }],
  ['кто чем занят', { intent: 'team_load' }],
  // встречи
  ['встреча с Ромашкой завтра в 15 в Телемосте', { intent: 'meeting', client: { id: 2 }, date: '2026-10-15', time: '15:00', provider: 'telemost' }],
  ['назначь встречу с Таллером в четверг в 11', { intent: 'meeting', client: { id: 1 }, time: '11:00' }],
  ['перенеси встречу с Таллером на пятницу', { intent: 'meeting_move', date: '2026-10-16' }],
  ['отмени планёрку', { intent: 'meeting_cancel' }],
  ['отмени встречу с Таллером завтра', { intent: 'meeting_cancel', date: '2026-10-15' }],
  ['встречи на неделе', { intent: 'agenda', range: 'week', only: 'meetings' }],
  ['какие встречи завтра', { intent: 'agenda', range: 'tomorrow', only: 'meetings' }],
  // медиапланы
  ['создай медиаплан для Таллера на квартал', { intent: 'mediaplan_create', client: { id: 1 }, months: 3, kind: 'leads' }],
  ['сделай МП для Юнистрима на 6 месяцев', { intent: 'mediaplan_create', clientName: 'Юнистрима', months: 6 }],
  ['новый медиаплан для интернет-магазина', { intent: 'mediaplan_create', kind: 'ecom' }],
  ['открой медиаплан Таллер', { intent: 'mediaplan_open', query: 'Таллер' }],
  ['открой последний медиаплан', { intent: 'mediaplan_open', query: '' }],
  // документы
  ['создай КП для Юнистрима', { intent: 'document_create', template: 'kp', clientName: 'Юнистрима' }],
  ['подготовь коммерческое предложение для Таллера', { intent: 'document_create', template: 'kp', client: { id: 1 } }],
  ['сделай отчёт для Ромашки за сентябрь', { intent: 'document_create', template: 'report', client: { id: 2 }, month: 'сентябрь' }],
  ['создай стратегию для Медлайн', { intent: 'document_create', template: 'strategy', client: { id: 3 } }],
  ['создай пустой документ', { intent: 'document_create', template: null }],
  ['открой документ КП Таллер', { intent: 'document_open' }],
  // заявки
  ['новые заявки', { intent: 'lead_list', fresh: true }],
  ['горячие заявки за неделю', { intent: 'lead_list', hot: true, period: 'week' }],
  ['покажи заявки за сегодня', { intent: 'lead_list', period: 'today' }],
  ['сколько заявок за месяц', { intent: 'lead_stats', period: 'month' }],
  ['статистика по заявкам', { intent: 'lead_stats' }],
  ['открой заявку 123', { intent: 'lead_open', id: 123 }],
  ['заявка №45', { intent: 'lead_open', id: 45 }],
  ['возьми заявку 123', { intent: 'lead_status', id: 123, status: 'in_work', take: true }],
  ['заявка 123 — спам', { intent: 'lead_status', id: 123, status: 'spam' }],
  ['заявку 77 в работу', { intent: 'lead_status', id: 77, status: 'in_work' }],
  ['отметь заявку 12 как сделку', { intent: 'lead_status', id: 12, status: 'won' }],
  ['переведи заявку 9 в отказ', { intent: 'lead_status', id: 9, status: 'lost' }],
  ['заявка 5 кп отправлено', { intent: 'lead_status', id: 5, status: 'proposal' }],
  // новости
  ['опубликуй в новости: запустили РСЯ для Таллера', { intent: 'news_create', body: 'запустили РСЯ для Таллера' }],
  ['напиши в ленту — завтра субботник', { intent: 'news_create', body: 'завтра субботник' }],
  ['покажи новости', { intent: 'news_list' }],
  ['открой новости', { intent: 'navigate', section: 'news' }],
  // регламенты и поиск
  ['открой регламент по КП', { intent: 'kb_open', query: 'КП' }],
  ['найди в интернете требования SberAds к баннерам', { intent: 'search' }],
  // свободный вопрос — модели
  ['как лучше объяснить клиенту рост CPC?', { intent: 'chat' }],
  ['придумай 5 заголовков для баннера', { intent: 'chat' }],
];

for (const [phrase, want] of CASES) {
  test(`фраза: ${phrase}`, () => {
    const got = parse(phrase);
    if (want === null) return; // фраза допускает и разговор, и действие — главное, что не падает
    for (const [k, v] of Object.entries(want)) {
      if (v && typeof v === 'object') assert.equal(got[k]?.id, v.id, `${k} для «${phrase}»: ${JSON.stringify(got)}`);
      else assert.equal(got[k], v, `${k} для «${phrase}»: ${JSON.stringify(got)}`);
    }
  });
}

test('встреча, где «встреча» не сразу после глагола, и время через пробел', () => {
  const m = parse('поставь на завтра на 13 00 встречу с клиентом таллер');
  assert.deepEqual([m.intent, m.client?.id, m.date, m.time], ['meeting', 1, '2026-10-15', '13:00'], JSON.stringify(m));
  assert.doesNotMatch(m.title, /00/);
  const t = parse('поставь задачу подготовиться ко встрече с Таллером завтра в 15 30');
  assert.deepEqual([t.intent, t.time], ['task_create', '15:30']);
  assert.equal(parse('назначь в пятницу в 11 созвон с Ромашкой').intent, 'meeting');
});

test('живая речь: обращения, «пожалуйста», неопределённая форма, слово «встреча» в любом месте', () => {
  const cases = [
    ['слушай, поставь пожалуйста задачу отчёт для Таллера на пятницу', { intent: 'task_create', client: { id: 1 }, date: '2026-10-16' }],
    ['можешь поставить задачу обновить нормативы на завтра?', { intent: 'task_create', date: '2026-10-15' }],
    ['надо подготовить КП для Медлайн к пятнице', { intent: 'task_create', client: { id: 3 }, date: '2026-10-16' }],
    ['не забыть позвонить в Ромашку завтра в 11', { intent: 'task_create', date: '2026-10-15', time: '11:00' }],
    ['мне нужна встреча с Ромашкой в пятницу в 15', { intent: 'meeting', client: { id: 2 }, date: '2026-10-16', time: '15:00' }],
    ['завтра в 15 30 созвон с Таллером', { intent: 'meeting', client: { id: 1 }, date: '2026-10-15', time: '15:30' }],
    ['давай на завтра на 13 00 встречу с клиентом таллер', { intent: 'meeting', client: { id: 1 }, time: '13:00' }],
    ['организуй планёрку в понедельник в 10', { intent: 'meeting', date: '2026-10-19', time: '10:00' }],
    ['запланировать встречу с Таллером на 20.10 в 12', { intent: 'meeting', date: '2026-10-20', time: '12:00' }],
    ['перенеси встречу с Таллером на пятницу', { intent: 'meeting_move' }],
    ['отмени созвон с Ромашкой', { intent: 'meeting_cancel' }],
    ['какие встречи завтра', { intent: 'agenda', only: 'meetings' }],
    ['открыть календарь', { intent: 'navigate', section: 'calendar' }],
    ['добавить клиента Юнистрим, спасибо', { intent: 'client_create', name: 'Юнистрим' }],
    ['пожалуйста, что у меня сегодня?', { intent: 'agenda', range: 'today' }],
  ];
  for (const [phrase, want] of cases) {
    const got = parse(phrase);
    for (const [k, v] of Object.entries(want)) {
      if (v && typeof v === 'object') assert.equal(got[k]?.id, v.id, `${k} для «${phrase}»: ${JSON.stringify(got)}`);
      else assert.equal(got[k], v, `${k} для «${phrase}»: ${JSON.stringify(got)}`);
    }
  }
});

test('медиаплан из фразы: площадки, бюджеты, комиссия, НДС', () => {
  const a = parse('сделай медиаплан для клиента таллер. источник яндекс директ. бюджет 300000 рублей');
  assert.equal(a.intent, 'mediaplan_create');
  assert.equal(a.client?.id, 1);
  assert.deepEqual(a.channels, [{ name: 'Яндекс Директ', budget: 300000 }]);
  const b = parse('создай медиаплан для Ромашки на 6 месяцев: директ 300к и вк 150 тыс в месяц, комиссия 15%, с НДС');
  assert.deepEqual(b.channels, [{ name: 'Яндекс Директ', budget: 300000 }, { name: 'VK Реклама', budget: 150000 }]);
  assert.deepEqual([b.months, b.fee, b.vat, b.budgetTotal], [6, 15, 22, false]);
  const c = parse('сделай МП для Таллера на квартал: РСЯ, поиск в директе и телеграм, общий бюджет 900 000 на весь период');
  assert.deepEqual(c.channels.map((x) => x.name), ['Яндекс Директ — РСЯ', 'Яндекс Директ — Поиск', 'Telegram Ads']);
  assert.equal(c.budgetTotal, true);
  assert.equal(c.budgetSplit, true);
  assert.deepEqual(c.channels.map((x) => x.budget), [300000, 300000, 300000]);
  const d = parse('создай медиаплан для Медлайн, авито 1,5 млн');
  assert.deepEqual(d.channels, [{ name: 'Авито', budget: 1500000 }]);
});

test('повторяющиеся задачи из фразы', () => {
  const cases = [
    ['каждый понедельник отчёт для Таллера', { intent: 'task_create', repeat: 'weekly', date: '2026-10-19', client: { id: 1 } }],
    ['поставь задачу проверять ставки по будням в 10', { intent: 'task_create', repeat: 'weekdays', time: '10:00' }],
    ['ежемесячно 5 числа выставить счёт Ромашке', { intent: 'task_create', repeat: 'monthly', date: '2026-11-05' }],
    ['напомни раз в две недели обновить нормативы', { intent: 'task_create', repeat: 'biweekly', date: '2026-10-14' }],
    ['поручи Олегу каждую пятницу отчёт для Медлайн', { intent: 'task_create', repeat: 'weekly', date: '2026-10-16', assignee: { id: 2 } }],
  ];
  for (const [phrase, want] of cases) {
    const got = parse(phrase);
    for (const [k, v] of Object.entries(want)) {
      if (v && typeof v === 'object') assert.equal(got[k]?.id, v.id, `${k} для «${phrase}»: ${JSON.stringify(got)}`);
      else assert.equal(got[k], v, `${k} для «${phrase}»: ${JSON.stringify(got)}`);
    }
    assert.doesNotMatch(got.title, /кажд|ежемесячно|будням|раз в/i, got.title);
  }
});

test('деньги из фразы', () => {
  const a = parse('Таллер оплатил 80 000');
  assert.deepEqual([a.intent, a.client?.id, a.amount], ['money_paid', 1, 80000]);
  const b = parse('выставь счёт Ромашке 50к до 20.10 за аудит рекламы');
  assert.deepEqual([b.intent, b.client?.id, b.amount, b.due, b.kind, b.title], ['money_invoice', 2, 50000, '2026-10-20', 'other', 'аудит рекламы']);
  const c = parse('выставь счёт Таллеру на рекламный бюджет 300 000');
  assert.deepEqual([c.kind, c.amount], ['budget', 300000]);
  const d = parse('ведение Таллер 80 000 в месяц до 10 числа');
  assert.deepEqual([d.intent, d.client?.id, d.fee, d.payDay], ['money_billing', 1, 80000, 10]);
  assert.equal(parse('кто должен?').intent, 'money_summary');
  assert.equal(parse('пришла оплата от Медлайн 120 тыс').amount, 120000);
});

test('клиент по-русски и по-английски: «леокид» = Leokid, падежи, название из двух слов', () => {
  const run = (phrase, name) => {
    const clients = [{ id: 1, name }, { id: 2, name: 'Ромашка' }, { id: 3, name: 'Таллер' }];
    return (parsePhrase(phrase, { clients }) ?? parseCommand(phrase, { clients, team: [] }))?.client?.name ?? null;
  };
  assert.equal(run('сделать МП для клиента леокид', 'Leokid'), 'Leokid');
  assert.equal(run('сделать МП для клиента леокид', 'Leo Kid'), 'Leo Kid');
  assert.equal(run('сделай МП для leokid', 'Леокид'), 'Леокид');
  assert.equal(run('поставь задачу отчёт для Леокида на пятницу', 'Leokid'), 'Leokid');
  assert.equal(run('создай КП для юнистрима', 'Unistream'), 'Unistream');
  assert.equal(run('что по медлайну', 'Medline'), 'Medline');
  // разные названия не склеиваются
  assert.equal(run('что по медлайну', 'Medialab'), null);
  assert.equal(run('сделай МП для ромашки', 'Romantic'), 'Ромашка');
});

test('бриф по теме из фразы', () => {
  const run = (phrase) => parsePhrase(phrase, { clients });
  assert.deepEqual([run('сделай бриф по контексту для Таллера').template, run('сделай бриф по контексту для Таллера').client?.name], ['brief-context', 'Таллер']);
  assert.equal(run('подготовь бриф на сайт').template, 'brief-site');
  assert.equal(run('создай бриф SMM для Ромашки').template, 'brief-smm');
  assert.equal(run('новый бриф по таргету ВК').template, 'brief-target');
  assert.equal(run('сделай бриф по SEO').template, 'brief-seo');
  assert.equal(run('бриф по маркетплейсам для Медлайн')?.template, undefined, 'без глагола — не команда');
  assert.equal(run('сделай бриф по маркетплейсам для Медлайн').template, 'brief-marketplace');
  assert.equal(run('создай бриф для Таллера').template, 'brief-complex');
});
