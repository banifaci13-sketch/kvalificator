// Каталог фраз ассистента: каждая фраза разбирается правилами, без ИИ.
// Если правило меняется — меняйте и docs/assistant-phrases.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhrase } from '../src/assistant/phrases.js';
import { parseCommand } from '../src/assistant/commands.js';

const clients = [{ id: 1, name: 'Таллер' }, { id: 2, name: 'ООО Ромашка' }, { id: 3, name: 'Клиника Медлайн' }];
const team = [{ id: 1, name: 'Анна Сорокина' }, { id: 2, name: 'Олег Петров' }, { id: 3, name: 'Даниил Карацапов' }];
const now = new Date('2026-10-14T09:00:00Z'); // среда, 12:00 по Москве
const parse = (t) => parsePhrase(t, { clients, team, now }) ?? parseCommand(t, { clients, team, now });

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
