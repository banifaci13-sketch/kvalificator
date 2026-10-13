// Поручения обычной фразой — без ИИ, по правилам: работают мгновенно и даже когда модель недоступна.
// «поставь задачу созвониться с Ромашкой завтра в 11», «закрой задачу по лендингу»,
// «перенеси отчёт на пятницу», «встреча с Таллером в четверг в 15», «что у меня завтра».

import { parseWhen, word } from './when.js';

const STOP = new Set(['задачу', 'задача', 'задачи', 'по', 'про', 'для', 'на', 'в', 'во', 'с', 'со', 'и', 'к', 'у', 'о', 'об', 'мне', 'мою', 'эту', 'ту', 'встречу', 'встреча', 'созвон']);
// организационно-правовая форма — не часть имени клиента
const LEGAL = new Set(['ооо', 'ип', 'зао', 'ао', 'пао', 'нко', 'llc']);
const tokens = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((t) => t && !STOP.has(t));

/** Общее начало слов: «ромашкой» и «ромашка» совпадают по основе. */
function stemMatch(a, b) {
  const n = Math.min(a.length, b.length);
  // короткие слова («дом» — «дома»): одно начинается с другого и отличается окончанием
  if (n < 4) return a === b || (n === 3 && (a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 2);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i >= Math.max(4, Math.min(a.length, b.length) - 2);
}

/**
 * Лучшее совпадение по словам: точное слово — 2 очка, по основе — 1. Ищем в названии
 * и в имени клиента. Если одинаково подходят несколько — не угадываем, возвращаем всех.
 */
export function bestMatch(query, items, text = (x) => x.title) {
  const q = tokens(query);
  if (!q.length) return { item: null, candidates: [] };
  const scored = items
    .map((item) => {
      const words = tokens(text(item));
      let score = 0;
      for (const t of q) {
        if (words.includes(t)) score += 2;
        else if (words.some((w) => stemMatch(t, w))) score += 1;
      }
      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { item: null, candidates: [] };
  const top = scored.filter((x) => x.score === scored[0].score).map((x) => x.item);
  return top.length === 1 ? { item: top[0], candidates: top } : { item: null, candidates: top.slice(0, 5) };
}

/** Клиент, упомянутый во фразе («для Таллера», «с Ромашкой»): по основе каждого слова названия. */
export function findClient(text, clients) {
  const words = tokens(text);
  let best = null;
  for (const c of clients) {
    const name = tokens(c.name).filter((t) => !LEGAL.has(t));
    if (!name.length) continue;
    const hits = name.filter((n) => words.some((w) => stemMatch(w, n))).length;
    if (hits === name.length && (!best || name.length > best.n)) best = { client: c, n: name.length };
  }
  if (best) return best.client;
  // «Медлайн» вместо «Клиника Медлайн»: хватает одного характерного слова, если оно только у одного клиента
  const partial = clients.filter((c) => tokens(c.name).filter((t) => t.length >= 4 && !LEGAL.has(t) && !GENERIC.has(t)).some((n) => words.some((w) => w.length >= 4 && stemMatch(w, n))));
  return partial.length === 1 ? partial[0] : null;
}
// слова, которые встречаются в названиях многих компаний и сами по себе клиента не определяют
const GENERIC = new Set(['клиника', 'компания', 'группа', 'студия', 'агентство', 'магазин', 'центр', 'завод', 'холдинг', 'сервис', 'маркет', 'торговый', 'дом']);

/** Сотрудник по имени в любом падеже: «Даниилу», «на Олега». */
export function findPerson(text, team) {
  const words = String(text).toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я]+/i).filter(Boolean);
  for (const u of team) {
    const first = String(u.name).split(/\s+/)[0].toLowerCase().replace(/ё/g, 'е');
    if (first.length < 3) continue;
    const base = first.length > 4 ? first.slice(0, -1) : first;
    const hit = words.find((w) => w.startsWith(base) && w.length - first.length <= 2);
    if (hit) return { user: u, word: hit };
  }
  return null;
}

/** Название задачи в порядке: заглавная, без хвостовых знаков, «созвонится» → «созвониться». */
export function tidyTitle(s) {
  let t = String(s).replace(/\s+/g, ' ').trim().replace(/^[:—–-]\s*/, '').replace(/[.,;:!]+$/, '').trim();
  t = t.replace(/^(\S+?)тся(?=\s|$)/i, (m, stem) => (/^(созвони|позвони|встрети|связа|договори|списа|увиде)/i.test(stem) ? `${stem}ться` : m));
  t = t.replace(/"([^"]+)"/g, '«$1»');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

const PRIORITY_WORDS = [
  [word('критично|горит|аврал'), 4],
  [word('срочно|важно|приоритетно|высокий приоритет'), 3],
];

/**
 * Намерение фразы. Возвращает { intent, ... } или { intent: 'chat' }.
 * clients и team — для поиска клиента и исполнителя; now — текущий момент.
 */
export function parseCommand(message, { clients = [], team = [], now = new Date() } = {}) {
  const text = String(message).trim().replace(/\s+/g, ' ');
  const low = text.toLowerCase().replace(/ё/g, 'е');

  // что у меня — сводка по задачам и встречам
  if (/^(что|какие|покажи|расскажи)[^?]*(у меня|мои|мой день|на сегодня|на завтра|на неделю|просроч)/i.test(low) || /^(мой день|мои задачи|план на (сегодня|завтра|неделю))/i.test(low)) {
    const range = /завтра/.test(low) ? 'tomorrow' : /недел/.test(low) ? 'week' : /просроч/.test(low) ? 'overdue' : /^(какие|покажи)?\s*(у меня\s+)?(мои\s+)?задачи$|^мои задачи/.test(low) ? 'open' : 'today';
    return { intent: 'agenda', range };
  }

  // поиск в интернете — явная просьба
  const search = /^(найди|поищи|загугли|погугли|посмотри|проверь)(\s+(мне|в интернете|в сети|в яндексе))*\s+(.+)$/i.exec(text);
  if (search && !/задач/i.test(search[4].split(' ')[0])) return { intent: 'search', query: search[4] };

  // закрыть задачу
  const done = /^(закрой|закрыть|выполни|отметь(?:\s+как)?\s+выполненн\S*|заверши|готово:?)\s+(?:задачу\s+)?(.+)$/i.exec(text);
  if (done) return { intent: 'task_done', query: done[2] };

  // перенести задачу или встречу
  const move = /^(перенеси|перенести|сдвинь|передвинь|отложи)\s+(.+)$/i.exec(text);
  if (move) {
    const w = parseWhen(move[2], now);
    const isMeeting = /встреч|созвон|планерк|планёрк/i.test(move[2]);
    return { intent: isMeeting ? 'meeting_move' : 'task_move', query: w.rest.replace(/^(задачу|встречу)\s+/i, ''), date: w.date, time: w.time };
  }

  // встреча
  let meet = /^(?:(?:назначь|запланируй|поставь|создай|добавь)\s+)?(встреч[ауи]|созвон|планерк[ау]|планёрк[ау]|звонок)\s*(.*)$/i.exec(text);
  // «поставь на завтра на 13 00 встречу с Таллером» — слово «встреча» не сразу после глагола
  const loose = !meet && /^(?:назначь|запланируй|поставь|создай|добавь|организуй)\s+(.+?)\s(встреч[ауи]|созвон|планерк[ау]|планёрк[ау])(?=\s|$)(.*)$/i.exec(text);
  if (loose && !/задач|напомин/i.test(loose[1])) meet = [loose[0], loose[2], `${loose[1]} ${loose[3]}`.trim()];
  if (meet) {
    const w = parseWhen(meet[2], now);
    const client = findClient(meet[2], clients);
    const online = /(онлайн|zoom|зум|телемост)/i.test(meet[2]);
    const office = /(в офисе|офлайн|у нас)/i.test(meet[2]);
    let title = tidyTitle(`${meet[1].toLowerCase().startsWith('созвон') ? 'Созвон' : 'Встреча'} ${w.rest.replace(/(онлайн|в офисе|офлайн|в zoom|в зуме|в телемосте|через телемост|у нас)/gi, '')}`);
    if (title === 'Встреча' && client) title = `Встреча с «${client.name}»`;
    return { intent: 'meeting', title, client, date: w.date, time: w.time, format: office ? 'office' : 'online', provider: /телемост/i.test(meet[2]) ? 'telemost' : /(zoom|зум)/i.test(meet[2]) ? 'zoom' : null, online };
  }

  // новая задача: «поставь задачу …», «задача: …», «напомни …», «поручи Даниилу …»
  const create =
    /^(?:поставь|создай|добавь|заведи|запиши|сделай)\s+(?:мне\s+)?(?:новую\s+)?задач[уи]\s*:?\s*(.+)$/i.exec(text) ??
    /^задача\s*:\s*(.+)$/i.exec(text) ??
    /^(?:поручи|поставь|дай)\s+(\S+\s+(?:задачу\s+)?.+)$/i.exec(text) ??
    /^напомни(?:\s+мне)?\s+(.+)$/i.exec(text);
  if (create) {
    let body = create[1];
    const w = parseWhen(body, now);
    body = w.rest;
    let priority = 0;
    for (const [re, p] of PRIORITY_WORDS) {
      if (re.test(body)) {
        priority = Math.max(priority, p);
        body = body.replace(re, ' ');
      }
    }
    const person = findPerson(body, team);
    if (person) body = body.replace(new RegExp(`(?:^|\\s)(?:на|для|поручи|ответственный:?)?\\s*${person.word}(?=\\s|$)`, 'i'), ' ');
    body = body.replace(/^\s*задачу\s+/i, '');
    const client = findClient(body, clients);
    if (client) {
      // имя клиента вырезаем, только если оно приписано: «отчёт для Таллера», «по клиенту Ромашка»
      const stems = tokens(client.name).filter((t) => !LEGAL.has(t)).map((t) => t.slice(0, Math.max(3, t.length - 2)));
      const tail = new RegExp(`\\s+(?:для|по|клиенту|клиента|клиент)\\s+(?:клиента\\s+|клиенту\\s+)?«?"?(?:${stems.map((s) => `${s}\\S*`).join('\\s+')})»?"?`, 'i');
      body = body.replace(tail, ' ');
    }
    const title = tidyTitle(body);
    if (!title) return { intent: 'chat' };
    return { intent: 'task_create', title, client, assignee: person?.user ?? null, date: w.date, time: w.time, priority };
  }

  return { intent: 'chat' };
}
