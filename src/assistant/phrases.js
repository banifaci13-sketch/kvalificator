// Каталог поручений обычной фразой — по разделам кабинета. Всё, что здесь разобрано, выполняется
// мгновенно и без ИИ. Модель подключается, только если фраза не подошла ни под одно правило, и даже
// тогда она лишь переписывает просьбу в одну из этих фраз (см. src/assistant/index.js).
// Полный список с примерами — docs/assistant-phrases.md; меняя правила, обновляйте и его.

import { parseWhen, word } from './when.js';
import { findClient, findPerson, tidyTitle } from './commands.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const strip = (s) => String(s ?? '').trim().replace(/^[«"']+|[»"'.!?,;:]+$/g, '').trim();

// Разделы кабинета и слова, которыми их называют
export const SECTIONS = [
  ['mytasks', 'Мои задачи', 'мои задачи|моим задачам'],
  ['home', 'Главная', 'главн\\S*|домой|мой день|сводк\\S* дня'],
  ['news', 'Новости', 'новост\\S*|лент\\S*'],
  ['chat', 'Сообщения', 'сообщени[яй]|чат\\S*|мессенджер\\S*|переписк\\S*'],
  ['templates', 'Шаблоны', 'шаблон\\S*'],
  ['benchmarks', 'Нормативы', 'норматив\\S*'],
  ['plans', 'Медиапланы', 'медиаплан\\S*|мп'],
  ['docs', 'Документы', 'документ\\S*|презентаци\\S*'],
  ['clients', 'Клиенты', 'клиент(?:ы|ов|ам)'],
  ['tasks', 'Задачи', 'задач[иа]?|проект\\S*'],
  ['calendar', 'Календарь', 'календар\\S*|встреч[иам]*'],
  ['board', 'Воронка', 'воронк\\S*'],
  ['stats', 'Сводка по заявкам', 'статистик\\S*|аналитик\\S*|сводк\\S*(?: по заявкам)?'],
  ['leads', 'Квалификатор', 'квалификатор\\S*|заявк\\S*|лид\\S*'],
  ['kb', 'Регламенты', 'регламент\\S*|баз\\S* знаний'],
  ['integrations', 'Подключения', 'подключени\\S*|интеграци\\S*'],
  ['staff', 'Сотрудники', 'сотрудник\\S*|команд\\S*'],
  ['appearance', 'Внешний вид', 'внешн\\S* вид\\S*|оформлени\\S*|настройк\\S*'],
  ['account', 'Учётная запись', 'профил\\S*|уч[её]тн\\S*(?: запис\\S*)?|аккаунт\\S*|парол\\S*'],
];
const sectionOf = (s) => SECTIONS.find(([, , re]) => new RegExp(`^(?:раздел\\S*\\s+)?(?:${re})$`, 'i').test(norm(s)));

// Статусы заявок
const LEAD_STATUS = [
  ['in_work', 'в работу|в работе|взять|беру|возьму|принять'],
  ['proposal', 'кп отправлено|отправили кп|отправлено кп|кп'],
  ['won', 'сделк\\S*|выиграли|успешн\\S*|договор\\S*|оплатил\\S*'],
  ['lost', 'отказ\\S*|проиграли|слил\\S*|не целев\\S*|нецелев\\S*'],
  ['spam', 'спам'],
  ['new', 'нов\\S*'],
];
const leadStatusOf = (s) => LEAD_STATUS.find(([, re]) => word(re).test(norm(s)))?.[0] ?? null;

const PRIO = [
  [4, 'критичн\\S*|горящ\\S*|аврал\\S*|максимальн\\S*'],
  [3, 'срочн\\S*|важн\\S*|высок\\S*|приоритетн\\S*'],
  [2, 'средн\\S*|обычн\\S*'],
  [1, 'низк\\S*|не срочн\\S*|неважн\\S*|несрочн\\S*'],
  [0, 'без важности|сними важность|убери важность'],
];
const prioOf = (s) => PRIO.find(([, re]) => word(re).test(norm(s)))?.[0];

const DOC_KINDS = [
  ['kp', 'Коммерческое предложение', 'кп|коммерческ\\S* предложени\\S*|предложени\\S*'],
  ['strategy', 'Стратегия продвижения', 'стратеги\\S*'],
  ['report', 'Ежемесячный отчёт', 'отч[её]т\\S*'],
  ['mediaplan', 'Медиаплан (слайды)', 'презентаци\\S* медиаплан\\S*|слайд\\S* медиаплан\\S*'],
];

// бриф по теме: «сделай бриф по контексту для Таллера», «бриф на сайт», «бриф SMM»
const BRIEF_TOPICS = [
  ['brief-context', 'Бриф: контекстная реклама', /контекст|директ|поиск\S*\s+реклам|рся/i],
  ['brief-target', 'Бриф: таргетированная реклама', /таргет|vk|вк\b|вконтакт|телеграм|telegram|mytarget|майтаргет/i],
  ['brief-seo', 'Бриф: SEO-продвижение', /\bseo\b|\bсео\b|поисков\S*\s+продвиж/i],
  ['brief-site', 'Бриф: сайт или лендинг', /сайт|лендинг|landing/i],
  ['brief-smm', 'Бриф: SMM и контент', /\bsmm\b|\bсмм\b|соцсет|социальн|контент/i],
  ['brief-marketplace', 'Бриф: маркетплейсы', /маркетплейс|ozon|озон|wildberries|вайлдберриз|\bwb\b|\bвб\b|маркет\b/i],
];

const CREATE = '(?:добавь|добавить|создай|создать|заведи|завести|внеси|внести|оформи|сделай|сделать|подготовь|подготовить|собери|нов(?:ый|ая|ое|ую))';

/** «по клиенту Таллер», «для Ромашки», «Таллеру» — клиент из хвоста фразы. */
function clientIn(text, clients) {
  return findClient(text, clients);
}

// ---------- нормализация живой речи ----------

const FILLERS = '(?:пожалуйста|пож|плиз|please|слушай|слушайте|смотри|эй|привет|здравствуй(?:те)?|ассистент|сара|бот|так|итак|ну|короче|давай|давайте|будь добр(?:а)?|будьте добры|можешь|можете|мог бы ты|могла бы ты|не мог(?:ла)? бы ты|не могли бы вы|ты можешь|вы можете|сможешь|помоги|помогите|я хочу|хочу|хотел(?:а)? бы|мне надо|мне нужно|надо бы|нужно бы)';
// неопределённая форма → повелительная: «можешь поставить задачу» → «поставь задачу»
const IMPERATIVE = {
  поставить: 'поставь', создать: 'создай', добавить: 'добавь', завести: 'заведи', назначить: 'назначь', запланировать: 'запланируй',
  перенести: 'перенеси', сдвинуть: 'сдвинь', закрыть: 'закрой', удалить: 'удали', открыть: 'открой', показать: 'покажи',
  найти: 'найди', напомнить: 'напомни', поручить: 'поручи', передать: 'передай', отменить: 'отмени', записать: 'запиши',
  подготовить: 'подготовь', сделать: 'сделай', собрать: 'собери', включить: 'включи', перейти: 'перейди', отметить: 'отметь',
  вернуть: 'верни', организовать: 'организуй', оформить: 'оформи', внести: 'внеси', перевести: 'переведи', взять: 'возьми',
};
const MEETING = 'встреч[ауи]|созвон|планерк[ауи]|планёрк[ауи]|звонок|колл';
const NOT_MEETING = /задач|напомин|напомни|перенес|сдвин|отмен|закр|удал|открой|покажи|какие|мои|что |сколько|верни|комментар|отчёт|отчет|итог|постмит/i;

/** Привести живую фразу к форме из каталога: убрать обращения и «пожалуйста», глагол — в повелительную форму. */
export function normalize(message) {
  let t = String(message ?? '').replace(/\s+/g, ' ').trim().replace(/[!.]+$/, '').trim();
  const lead = new RegExp(`^(?:${FILLERS})(?:[,!:\\s]+|$)`, 'i');
  for (let i = 0; i < 4 && lead.test(t); i++) t = t.replace(lead, '').trim();
  t = t.replace(new RegExp(`[,\\s]+(?:${FILLERS}|спасибо)[!.?]*$`, 'i'), '').trim();
  t = t.replace(/^([А-ЯЁа-яё]+)(?=\s|$)/, (w) => IMPERATIVE[w.toLowerCase()] ?? w);
  // «каждый понедельник отчёт для Таллера», «ежемесячно 5 числа счёт клиенту» — повторяющаяся задача
  if (/^(?:кажд(?:ый|ую|ое|ые)|ежедневно|еженедельно|ежемесячно|ежеквартально|по\s+(?:будням|понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям)|раз\s+в\s+|\d{1,2}(?:-?го)?\s+числа)/i.test(t) && !new RegExp(`(?:^|\\s)(?:${MEETING})(?=\\s|$)`, 'i').test(t)) return `поставь задачу ${t}`;
  // «надо подготовить КП к пятнице», «не забыть позвонить Ромашке» — это задача
  const todo = /^(?:надо|нужно|необходимо|не забыть|не забудь|не забудьте)\s+([а-яё]+(?:ть|ться|чь)\s.+)$/i.exec(t);
  if (todo && !new RegExp(`(?:^|\\s)(?:${MEETING})(?=\\s|$)`, 'i').test(todo[1])) return `поставь задачу ${todo[1]}`;
  // встреча в любом месте фразы: «завтра в 15 созвон с Таллером», «мне нужна встреча с Ромашкой в пятницу»
  const meet = new RegExp(`^(.*?)(?:^|\\s)(${MEETING})(?=\\s|$)(.*)$`, 'i').exec(t);
  if (meet && meet[1] && !NOT_MEETING.test(meet[1])) {
    const pre = meet[1].replace(/(?:^|\s)(?:назначь|запланируй|поставь|создай|добавь|организуй|сделай|устрой|нужн[аоы]|нужен|надо|хочу|мне|нам|у нас|у меня|будет|давай|новую|новый|ещё|еще)(?=\s|$)/gi, ' ').trim();
    return `встреча ${pre} ${meet[3]}`.replace(/\s+/g, ' ').trim();
  }
  return t;
}

/**
 * Разбор фразы по каталогу. Возвращает { intent, ... } или null — тогда правила commands.js.
 * ctx: { clients, team, now }.
 */
export function parsePhrase(message, { clients = [], team = [], now = new Date() } = {}) {
  const text = String(message).trim().replace(/\s+/g, ' ');
  const low = norm(text);
  let m;

  // ---------- справка и уведомления ----------
  if (/^(что (ты )?(умеешь|можешь)|помощь|help|\/help|\/start|команды|список команд|какие (есть )?команды|что можно (тебе )?(сказать|поручить))\??$/.test(low)) return { intent: 'help' };
  if (/^(что нового|уведомлени[яй]|мои уведомления|покажи уведомления|есть (что-то|что) новое\??|новости по задачам)\??$/.test(low)) return { intent: 'notifications' };
  if (/^(прочитай|отметь( прочитанными)?|очисти|сбрось) (все )?уведомлени[яй]( прочитанными)?$/.test(low)) return { intent: 'notifications_read' };

  // ---------- новости ----------
  if ((m = /^(?:опубликуй|опубликовать|напиши|запости|выложи|добавь|поделись)\s+(?:в\s+(?:новости|ленту)|новость|запись в новости|в ленте)\s*[:—-]?\s*(.+)$/i.exec(text))) return { intent: 'news_create', body: m[1].trim() };
  if (/^(?:покажи|какие|последние|свежие|что в)\s*(?:последние\s+|свежие\s+)?(?:новости|ленте|ленту)(?:\s+агентства)?\??$/.test(low) || /^новости\??$/.test(low)) return { intent: 'news_list' };

  // ---------- сообщения коллегам ----------
  // «напиши Олегу: макеты готовы», «сообщи Ире в чат — созвон переносится»
  if ((m = /^(?:напиши|отправь|передай|скажи|сообщи|черкни)\s+(?:сообщение\s+)?([А-ЯЁа-яёA-Za-z]+)(?:\s+в\s+(?:чат|личку|личные|мессенджер))?\s*[:,—–-]\s*([\s\S]+)$/i.exec(String(message).trim()))) {
    const person = findPerson(m[1], team);
    if (person) return { intent: 'chat_send', user: person.user, text: m[2].trim() };
  }

  // ---------- оформление ----------
  if ((m = /^(?:включи|сделай|поставь|переключи(?: на)?|хочу)\s+(т[её]мн\S*|светл\S*|ночн\S*|дневн\S*|системн\S*)(?:\s+(?:тему|режим|оформление))?$/.exec(low)) || (m = /^(т[её]мн\S*|светл\S*|ночн\S*) (?:тема|режим)$/.exec(low))) {
    return { intent: 'theme', theme: /^(т[её]мн|ночн)/.test(m[1]) ? 'dark' : /^(светл|дневн)/.test(m[1]) ? 'light' : 'system' };
  }
  if (/^(давай|можно|обращайся|говори)?\s*(на ты|на «ты»|ко мне на ты)$/.test(low) || /^зови меня на ты$/.test(low)) return { intent: 'address', address: 'ty' };
  if (/^(давай|обращайся|говори)?\s*(на вы|на «вы»|ко мне на вы)$/.test(low)) return { intent: 'address', address: 'vy' };

  // ---------- навигация: «открой медиапланы», «перейди в календарь» ----------
  if ((m = /^(?:открой|открыть|перейди(?: в| на| к)?|перейти(?: в| на| к)?|покажи раздел|раздел|иди в|го в|хочу в)\s+(.+?)\.?$/i.exec(text))) {
    const sec = sectionOf(m[1]);
    if (sec) return { intent: 'navigate', section: sec[0], label: sec[1] };
  }

  // ---------- деньги ----------
  if (/^(?:кто (?:нам )?должен|кто не оплатил|должники|долги(?: клиентов)?|дебиторка|дебиторская задолженность|что с оплатами|оплаты|какие оплаты (?:ждём|ждем))\??$/.test(low)) return { intent: 'money_summary' };
  if ((m = /^(?:выставь|выставить|создай|добавь)\s+сч[её]т\s+(.+)$/i.exec(text))) {
    const w = parseWhen(m[1], now);
    const sum = moneyIn(w.rest)[0]?.value ?? null;
    const client = clientIn(w.rest, clients);
    const kind = /ведени|абонент/i.test(w.rest) ? 'fee' : /бюджет|пополнени/i.test(w.rest) ? 'budget' : 'other';
    const what = /за\s+(.+?)$/i.exec(w.rest.replace(/\d[\d\s]*(?:[.,]\d+)?\s*(?:млн|тыс\S*|к|₽|руб\S*)?/gi, ' ').replace(/\s+/g, ' ').trim());
    return { intent: 'money_invoice', client, query: w.rest, amount: sum, due: w.date, kind, title: what && kind === 'other' ? strip(what[1]) : null };
  }
  if ((m = /^(.+?)\s+(?:оплатил[аи]?|заплатил[аи]?|перевел[аи]?|перевёл|прислал[аи]? оплату)\s*(.*)$/i.exec(text)) || (m = /^(?:пришла|получили|поступила)?\s*оплат[аы]\s+(?:от\s+)?(.+?)\s+(\d.*)$/i.exec(text))) {
    const client = clientIn(m[1], clients);
    if (client) return { intent: 'money_paid', client, amount: moneyIn(m[2])[0]?.value ?? null };
  }
  if ((m = /^(?:ведение|абонентк\S*|абонентская плата)\s+(?:для\s+|у\s+)?(.+?)\s+(\d[\d\s]*(?:[.,]\d+)?\s*(?:к|тыс\S*|₽|руб\S*)?)(?:\s+в\s+месяц)?(?:[,\s]+(?:оплата\s+)?(?:до|к)\s+(\d{1,2})(?:-?го)?\s+числа)?$/i.exec(text))) {
    const client = clientIn(m[1], clients);
    if (client) return { intent: 'money_billing', client, fee: moneyIn(m[2])[0]?.value ?? Number(m[2].replace(/\D/g, '')), payDay: m[3] ? Number(m[3]) : null };
  }

  // ---------- клиенты ----------
  if ((m = /^(?:заведи|создай|добавь|сделай)\s+клиента\s+(?:по|из)\s+(?:заявк[еи]|лиду|лида)\s*№?\s*(\d+)$/i.exec(text))) return { intent: 'client_from_lead', leadId: Number(m[1]) };
  if ((m = /^(?:добав(?:ь|ить)|созда(?:й|ть)|заведи|завести|внеси|внести|нов(?:ый|ого))\s+(?:нового\s+)?(?:клиента|клиент|проект)\s*:?\s+(.+)$/i.exec(text)) || (m = /^новый клиент\s*:?\s+(.+)$/i.exec(text))) {
    return { intent: 'client_create', ...clientDetails(m[1]) };
  }
  if (/^(список клиентов|покажи клиентов|все клиенты|мои клиенты|какие у нас клиенты|клиенты)\??$/.test(low)) return { intent: 'client_list', mine: /мои/.test(low) };
  if ((m = /^(?:что|как)\s+(?:там\s+)?(?:по|с|у)\s+(?:клиент[уома]\s+|проект[уома]\s+)?(.+?)\??$/i.exec(text)) || (m = /^(?:сводка|расскажи|информация|инфо|карточка|покажи клиента|открой клиента|открой проект|статус)\s+(?:по\s+|про\s+|о\s+)?(?:клиент[уае]?\s+|проект[уае]?\s+)?(.+?)\??$/i.exec(text))) {
    const client = clientIn(m[1], clients);
    if (client) return { intent: /^(открой)/i.test(text) ? 'client_open' : 'client_info', client };
  }
  if ((m = /^(?:архивируй|отправь в архив|убери в архив|в архив)\s+(?:клиента\s+|проект\s+)?(.+)$/i.exec(text))) {
    const client = clientIn(m[1], clients);
    return { intent: 'client_archive', client, query: strip(m[1]) };
  }

  // ---------- доски проекта ----------
  if ((m = /^(?:добавь|создай|заведи|сделай)\s+(?:новую\s+)?доску\s+«?([^»]+?)»?\s+(?:в|для|по)\s+(?:проект[еау]?\s+|клиент[уае]?\s+)?(.+)$/i.exec(text))) {
    const client = /^общ/i.test(m[2]) ? null : clientIn(m[2], clients);
    return { intent: 'board_create', name: tidyTitle(m[1]), client, internal: /^общ/i.test(m[2]), query: strip(m[2]) };
  }

  // ---------- задачи: исполнитель, важность, комментарий, удаление, возврат, поиск ----------
  if ((m = /^(?:передай|переназначь|назначь|отдай|перекинь)\s+(?:задачу\s+)?(.+?)\s+(?:на|для)?\s*(\S+)$/i.exec(text)) && /задач|^(передай|переназначь|перекинь|отдай)/i.test(text) && !/^назначь\s+(встреч|созвон|планерк|планёрк)/i.test(text)) {
    const person = findPerson(m[2], team) ?? (/^(меня|мне|себе|себя)$/i.test(m[2]) ? { me: true } : null);
    if (person) return { intent: 'task_assign', query: m[1].replace(/^задачу\s+/i, ''), assignee: person.user ?? null, me: Boolean(person.me) };
  }
  if ((m = /^(?:пусть|путь)\s+(\S+)\s+(?:сделает|делает|займ[её]тся|возьм[её]т)\s+(?:задачу\s+)?(.+)$/i.exec(text))) {
    const person = findPerson(m[1], team);
    if (person) return { intent: 'task_assign', query: m[2], assignee: person.user };
  }
  if ((m = /^(?:сделай|отметь|поставь|пометь)\s+(?:задачу\s+)?(.+?)\s+(?:как\s+)?((?:не\s*)?(?:критичн|срочн|важн|низк|средн|обычн|высок)(?:ой|ая|ую|ым))$/i.exec(text)) || (m = /^(?:важность|приоритет)\s+(?:задачи\s+|у задачи\s+)?(.+?)\s*[—:-]?\s+(критичн\S*|высок\S*|средн\S*|низк\S*)$/i.exec(text))) {
    return { intent: 'task_priority', query: m[1].replace(/^задачу\s+/i, ''), priority: prioOf(m[2]) };
  }
  if ((m = /^(?:напиши|добавь комментарий|оставь комментарий|комментарий|коммент|допиши)\s+(?:в|к|по)\s+(?:задач[еиу]\s+)?(.+?)\s*:\s*(.+)$/i.exec(text))) {
    return { intent: 'task_comment', query: m[1], text: m[2].trim() };
  }
  if ((m = /^(?:удали|удалить|убери)\s+задачу\s+(.+?)(\s+подтверждаю)?$/i.exec(text))) return { intent: 'task_delete', query: m[1], confirmed: Boolean(m[2]) };
  if ((m = /^(?:верни|вернуть|переоткрой|открой снова|возобнови)\s+(?:в работу\s+)?(?:задачу\s+)?(.+?)(?:\s+в работу)?$/i.exec(text))) return { intent: 'task_reopen', query: m[1] };
  if ((m = /^(?:я\s+)?(?:сделал[аи]?|закончил[аи]?|выполнил[аи]?|доделал[аи]?)\s+(?:задачу\s+)?(.+)$/i.exec(text)) || (m = /^(.+?)\s+(?:готов[аоы]?|сделан[аоы]?|выполнен[аоы]?)$/i.exec(text))) {
    if (!/^(что|как|когда|кто|где)\s/i.test(m[1])) return { intent: 'task_done', query: m[1].replace(/^задача\s+/i, '') };
  }
  if ((m = /^(?:поменяй|измени|смени|поставь|установи)\s+срок\s+(?:у\s+|по\s+|для\s+)?(?:задач[иеу]\s+)?(.+)$/i.exec(text)) || (m = /^срок\s+(?:у\s+|по\s+)?(?:задач[иеу]\s+)?(.+)$/i.exec(text))) {
    const w = parseWhen(m[1], now);
    if (w.date || w.time) return { intent: 'task_move', query: w.rest.replace(/\s+(?:на|—|-)\s*$/i, '').replace(/^\s*(?:на|—|-)\s+/i, '').trim(), date: w.date, time: w.time };
  }
  if ((m = /^(?:открой|найди|покажи|где)\s+задач[уа]\s+(.+?)\??$/i.exec(text))) return { intent: 'task_open', query: m[1] };

  // задачи коллеги и загрузка команды
  if (/^(загрузка|нагрузка) (команды|сотрудников)|^кто (чем|над чем) (занят|работает)/.test(low)) return { intent: 'team_load' };
  if ((m = /^(?:что|какие задачи)\s+(?:у|на)\s+(\S+?)(?:\s+(сегодня|завтра|на неделе|на неделю|просрочено))?\??$/i.exec(text)) || (m = /^задачи\s+(\S+?)(?:\s+(сегодня|завтра|на неделе|на неделю))?\??$/i.exec(text))) {
    const person = findPerson(m[1], team);
    if (person) return { intent: 'person_tasks', user: person.user };
  }
  if (/^(что|какие задачи)\s+(горит|срочно|горят)|^горящие( задачи)?$|^что горит\??$/.test(low)) return { intent: 'agenda', range: 'overdue', hot: true };

  // ---------- итоги встречи (постмит) ----------
  if ((m = /^(?:итоги|постмит|по\s+итогам)\s+(?:встречи|созвона|планерки|планёрки)?\s*(.*?)\s*:\s*([\s\S]+)$/i.exec(String(message).trim()))) {
    return { intent: 'meeting_followup', query: strip(m[1].replace(/^(?:с|со)\s+/i, '')), text: m[2] };
  }

  // ---------- встречи ----------
  if ((m = /^(?:отмени|отменить|отменяем|удали)\s+(?:встречу|созвон|планерку|планёрку)\s*(.*)$/i.exec(text))) {
    const w = parseWhen(m[1], now);
    return { intent: 'meeting_cancel', query: w.rest.trim(), date: w.date };
  }
  if ((m = /^(?:какие|мои|покажи)?\s*(?:у меня\s+)?(?:встречи|созвоны)(?:\s+(?:у меня\s+)?(сегодня|завтра|на неделе|на неделю|на этой неделе))?\??$/i.exec(low))) {
    const r = m[1] ? (/завтра/.test(m[1]) ? 'tomorrow' : /недел/.test(m[1]) ? 'week' : 'today') : 'week';
    return { intent: 'agenda', range: r, only: 'meetings' };
  }

  // ---------- медиапланы ----------
  if ((m = new RegExp(`^${CREATE}\\s+(?:нов\\S+\\s+)?(?:медиаплан\\S*|мп)(?:\\s+(.*))?$`, 'i').exec(text)) && !/^(?:открой|найди)/i.test(text)) {
    const rest = m[1] ?? '';
    const months = /(\d{1,2})\s*(?:мес|месяц)/i.exec(rest);
    const qtr = /квартал/i.test(rest) ? 3 : /полгода|пол года/i.test(rest) ? 6 : /\bгод\b|на год/i.test(rest) ? 12 : null;
    const ecom = /(интернет-?магазин|e-?com|ecom|еком|магазин|маркетплейс)/i.test(rest);
    const client = clientIn(rest, clients);
    const title = /(?:«([^»]+)»|"([^"]+)")/.exec(rest);
    return { intent: 'mediaplan_create', client, clientName: client?.name ?? clientNameFrom(rest.replace(/[.;].*$/, '')), months: months ? Number(months[1]) : qtr ?? 3, kind: ecom ? 'ecom' : 'leads', title: title ? title[1] ?? title[2] : null, ...planDetails(rest) };
  }
  if ((m = /^(?:открой|найди|покажи)\s+(?:последний\s+)?медиаплан\S*\s*(.*)$/i.exec(text))) return { intent: 'mediaplan_open', query: strip(m[1].replace(/^(?:для|по)\s+/i, '')) };

  // ---------- документы ----------
  if ((m = new RegExp(`^${CREATE}\\s+(?:нов\\S+\\s+)?бриф\\S*(?:\\s+(.*))?$`, 'i').exec(text))) {
    const rest = m[1] ?? '';
    const [id, name] = BRIEF_TOPICS.find(([, , re]) => re.test(rest)) ?? ['brief-complex', 'Бриф: первичный (комплексный маркетинг)'];
    const client = clientIn(rest, clients);
    const named = /(?:для|клиенту|клиента)\s+(?:клиента\s+)?«?([^»,:]+?)»?\s*$/i.exec(rest.trim());
    return { intent: 'document_create', template: id, templateName: name, client, clientName: client?.name ?? (named ? strip(named[1]) : null) };
  }
  for (const [id, name, re] of DOC_KINDS) {
    const r = new RegExp(`^${CREATE}\\s+(?:нов\\S+\\s+)?(?:${re})(?:\\s+(.*))?$`, 'i').exec(text);
    if (r) {
      const rest = r[1] ?? '';
      const client = clientIn(rest, clients);
      const month = /(?:за|на)\s+(январ\S*|феврал\S*|март\S*|апрел\S*|ма[йя]\S*|июн\S*|июл\S*|август\S*|сентябр\S*|октябр\S*|ноябр\S*|декабр\S*)/i.exec(rest);
      const brief = /:\s*(.+)$/.exec(rest);
      return { intent: 'document_create', template: id, templateName: name, client, clientName: client?.name ?? clientNameFrom(rest.replace(/:.*$/, '')), month: month ? month[1] : null, brief: brief ? brief[1] : null };
    }
  }
  if (new RegExp(`^${CREATE}\\s+(?:пуст\\S+\\s+)?(?:документ|презентаци\\S*)(?:\\s+(.*))?$`, 'i').test(text)) return { intent: 'document_create', template: null, templateName: 'Пустой документ', clientName: null };
  if ((m = /^(?:открой|найди|покажи)\s+(?:документ|кп|презентацию|стратегию|отч[её]т)\s+(.+)$/i.exec(text))) return { intent: 'document_open', query: strip(m[1].replace(/^(?:для|по)\s+/i, '')) };

  // ---------- заявки (квалификатор) ----------
  if ((m = /^(?:открой|покажи|найди)?\s*(?:заявк[уа]|лид[а]?)\s*№?\s*(\d+)$/i.exec(text))) return { intent: 'lead_open', id: Number(m[1]) };
  if ((m = /^(?:заявк[уа]|лид[а]?)\s*№?\s*(\d+)\s*[—:-]?\s*(.+)$/i.exec(text)) || (m = /^(?:переведи|поставь|отметь|пометь)\s+(?:заявк[уа]|лид[а]?)\s*№?\s*(\d+)\s+(?:в|на|как)?\s*(.+)$/i.exec(text))) {
    const status = leadStatusOf(m[2]);
    if (status) return { intent: 'lead_status', id: Number(m[1]), status, take: /^(возьм|бер|взять|приня)/i.test(m[2].trim()) };
  }
  if ((m = /^(?:возьми|беру|возьму|взять)\s+(?:заявк[уа]|лид[а]?)\s*№?\s*(\d+)\s*(?:себе|на себя)?$/i.exec(text))) return { intent: 'lead_status', id: Number(m[1]), status: 'in_work', take: true };
  if ((m = /^(?:сколько|статистика|динамика)\s+(?:было\s+)?(?:заявок|лидов|по заявкам|по лидам)(?:\s+(?:за|на)\s+(.+?))?\??$/i.exec(low))) return { intent: 'lead_stats', period: periodOf(m[1]) };
  if ((m = /^(?:покажи|какие|есть|список)?\s*(?:новые|свежие|горячие|последние|необработанные|сегодняшние)?\s*(?:заявки|лиды)(?:\s+(?:за|на)\s+(.+?))?(?:\s+(?:есть|новые))?\??$/i.exec(low)) && /заявк|лид/.test(low) && !/^(создай|добавь)/.test(low)) {
    return { intent: 'lead_list', hot: /горяч/.test(low), fresh: /нов|свеж|необработ/.test(low), period: periodOf(m[1] ?? (/сегодняшн/.test(low) ? 'сегодня' : null)) };
  }

  // ---------- регламенты ----------
  // «запусти регламент запуска рекламы для Таллера» — шаги регламента задачами в проект клиента
  if ((m = /^(?:запусти|примени|разверни|создай задачи по|сделай задачи по)\s+(?:процесс\S*|регламент\S*)\s+(.+?)(?:\s+(?:для|в проект[еа]?|в|по)\s+(?:клиент[ауе]?\s+|проект[ауе]?\s+)?(.+))?$/i.exec(text))) {
    const client = m[2] ? clientIn(m[2], clients) : null;
    return { intent: 'kb_apply', query: strip(m[1]), client, internal: m[2] ? /^общ/i.test(m[2]) : false, clientQuery: m[2] ? strip(m[2]) : null };
  }
  if ((m = /^(?:открой|покажи|найди)?\s*регламент\S*\s+(?:по|про|о|об)?\s*(.+)$/i.exec(text))) return { intent: 'kb_open', query: strip(m[1]) };

  return null;
}

// ---------- медиаплан: каналы, бюджеты, комиссия, НДС ----------

// как называют площадки → как они записываются в медиаплане (порядок важен: частное раньше общего)
export const CHANNELS = [
  [/рся|рекламн\S* сет\S* яндекс/i, 'Яндекс Директ — РСЯ'],
  [/(?:поиск\S*\s+(?:в\s+)?(?:яндекс\S*\s*)?директ\S*|директ\S*\s+поиск\S*)/i, 'Яндекс Директ — Поиск'],
  [/яндекс\S*\s*маркет\S*/i, 'Яндекс Маркет'],
  [/яндекс\S*\s*(?:бизнес|карт)\S*/i, 'Яндекс Бизнес'],
  [/(?:я(?:ндекс\S*)?\.?\s*)?директ\S*|yandex\s*direct/i, 'Яндекс Директ'],
  [/vk\s*(?:ads|реклам\S*)|вк\s*реклам\S*|вконтакт\S*|(?:^|[^a-zа-яё])(?:vk|вк)(?:[^a-zа-яё]|$)/i, 'VK Реклама'],
  [/telegram\s*ads|телеграм\S*|telegram/i, 'Telegram Ads'],
  [/sber\s*ads|сбер\s*ads|сбер\S*\s*реклам\S*|сберэдс/i, 'SberAds'],
  [/my\s*target|майтаргет/i, 'myTarget'],
  [/авито/i, 'Авито'],
  [/ozon|озон/i, 'Ozon'],
  [/wildberries|вайлдберр\S*|(?:^|[^a-zа-яё])(?:wb|вб)(?:[^a-zа-яё]|$)/i, 'Wildberries'],
  [/2\s*гис|2gis/i, '2ГИС'],
  [/google|гугл/i, 'Google Ads'],
  [/(?:^|[^a-zа-яё])(?:seo|сео)(?:[^a-zа-яё]|$)/i, 'SEO'],
];

/** Сумма в рублях: «300000», «300 000», «300к», «1,5 млн», «300 тыс. руб.». */
const MONEY = /(\d{1,3}(?:[\s ]\d{3})+|\d+(?:[.,]\d+)?)\s*(млн|миллион\S*|тыс\S*|т\.р\.?|к(?![а-яё])|k(?![a-z]))?\s*(?:₽|р(?:уб\S*)?\.?(?![а-яё]))?/gi;
function moneyIn(text) {
  const out = [];
  for (const m of String(text).matchAll(MONEY)) {
    const unit = (m[2] ?? '').toLowerCase();
    let v = Number(m[1].replace(/[\s ]/g, '').replace(',', '.'));
    if (/^(млн|миллион)/.test(unit)) v *= 1e6;
    else if (/^(тыс|т\.р|к|k)/.test(unit)) v *= 1e3;
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const isMoney = unit || /₽|р/.test(m[0].slice(m[1].length)) || v >= 10000;
    // «на 3 месяца», «15%», «22 НДС» — не бюджет
    if (!isMoney || /^\s*(?:%|мес|месяц|дн|недел|ндс)/i.test(tail)) continue;
    out.push({ value: Math.round(v), at: m.index });
  }
  return out;
}

/** Каналы, бюджеты и настройки медиаплана из фразы. */
export function planDetails(text) {
  const t = String(text ?? '');
  const found = [];
  let rest = t;
  for (const [re, name] of CHANNELS) {
    const g = new RegExp(re.source, 'gi');
    for (const m of rest.matchAll(g)) {
      if (!found.some((f) => f.name === name)) found.push({ name, at: m.index });
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
  }
  found.sort((a, b) => a.at - b.at);
  const money = moneyIn(t.replace(/(\d{1,2})\s*%/g, ' '));
  const total = /(?:на\s+(?:весь\s+)?(?:период|квартал|полгода|год)|всего|общ\S*\s+бюджет|за\s+(?:весь\s+)?период|на\s+\d+\s+месяц\S*\s*$)/i.test(t) && !/в\s*мес|\/\s*мес|ежемесячн|в\s+месяц/i.test(t);
  let channels = found.map((f) => ({ name: f.name, budget: null }));
  let split = false;
  if (money.length && channels.length) {
    if (money.length === channels.length) channels.forEach((c, i) => (c.budget = money[i].value));
    else if (money.length === 1) {
      split = channels.length > 1 && !/кажд/i.test(t);
      channels.forEach((c) => (c.budget = split ? Math.round(money[0].value / channels.length) : money[0].value));
    } else {
      // бюджет — к ближайшему упоминанию площадки
      for (const c of found) {
        const near = money.reduce((best, x) => (Math.abs(x.at - c.at) < Math.abs(best.at - c.at) ? x : best), money[0]);
        channels.find((x) => x.name === c.name).budget = near.value;
      }
    }
  } else if (money.length && !channels.length) channels = [{ name: '', budget: money[0].value }];
  const fee = /(?:комисси\S*|ак|агентск\S*)\s*(?:агентства\s*)?[—:-]?\s*(\d{1,2}(?:[.,]\d+)?)\s*%/i.exec(t);
  const vat = /без\s+ндс/i.test(t) ? 'none' : /(?:с\s+ндс|ндс\s*(\d{1,2})|(\d{1,2})\s*%?\s*ндс)/i.exec(t);
  return {
    channels,
    budgetTotal: total,
    budgetSplit: split,
    fee: fee ? Number(fee[1].replace(',', '.')) : null,
    vat: vat === 'none' ? 0 : vat ? Number(vat[1] ?? vat[2] ?? 22) : null,
  };
}

/** Период для заявок: «сегодня», «неделю», «месяц», «вчера». */
function periodOf(s) {
  const t = norm(s);
  if (!t) return null;
  if (/сегодня/.test(t)) return 'today';
  if (/вчера/.test(t)) return 'yesterday';
  if (/недел/.test(t)) return 'week';
  if (/месяц/.test(t)) return 'month';
  if (/квартал/.test(t)) return 'quarter';
  return null;
}

/** Имя клиента, которого ещё нет в базе: «для Юнистрима» → «Юнистрима» (как сказали). */
function clientNameFrom(rest) {
  const m = /(?:для|по|клиенту|клиента)\s+(?:клиента\s+|клиенту\s+)?«?([^»,:]+?)»?(?:\s+(?:на|за)\s+.*)?$/i.exec(String(rest ?? '').trim());
  return m ? strip(m[1]) : null;
}

/** «Юнистрим, сайт unistream.ru, контакт Иван, +7 999…» → поля клиента. */
function clientDetails(raw) {
  let s = ` ${raw} `;
  const take = (re) => {
    const m = re.exec(s);
    if (!m) return null;
    s = s.replace(m[0], ' ');
    return m[1].trim();
  };
  const email = take(/\s([\w.+-]+@[\w-]+\.[\w.-]+)/);
  const phone = take(/(?:тел(?:ефон)?\.?:?\s*)?(\+?[78][\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})/);
  const site = take(/(?:сайт:?\s*)?\s((?:https?:\/\/)?(?:[\w-]+\.)+(?:ru|рф|com|net|org|io|su|pro|online|shop|store)(?:\/\S*)?)/i);
  const contact = take(/(?:контакт(?:ное лицо)?|представитель|лпр):?\s+([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?)/);
  const name = strip(s.replace(/[,;]+/g, ' ').replace(/\s+(?:с\s+)?(?:сайт|телефон|контакт|почта|email)\s*$/i, '').replace(/\s+/g, ' '));
  return { name, site, phone, email, contact };
}
