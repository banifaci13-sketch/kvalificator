// Сроки из живой речи: «завтра в 11», «в пятницу», «14 октября к 18:00», «через неделю».
// Возвращает дату и время по Москве и фразу без них — остаток становится названием задачи.
// В JavaScript \b не видит кириллицу, поэтому границы слов задаются явно.

const L = 'A-Za-zА-Яа-яЁё0-9_';
export const WB = `(?:^|(?<=[^${L}]))`;
export const WE = `(?![${L}])`;
/** Регулярное выражение с границами слов, которые работают и на кириллице. */
export const word = (src, flags = 'i') => new RegExp(`${WB}(?:${src})${WE}`, flags);

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
// «к пятнице», «ко вторнику», «до среды» — падежные окончания тоже
const WEEKDAYS = [
  ['понедельник[ау]?', 'пн'],
  ['вторник[ау]?', 'вт'],
  ['сред[ауые]', 'ср'],
  ['четверг[ау]?', 'чт'],
  ['пятниц[ауые]', 'пт'],
  ['суббот[ауые]', 'сб'],
  ['воскресень[еяю]', 'вс'],
];

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** «Сейчас» по Москве как дата UTC (полдень — чтобы сдвиги дней не задевали часовой пояс). */
function mskToday(now) {
  const m = new Date(now.getTime() + 3 * 3600e3);
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate(), 12));
}
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);

/**
 * Разбор срока. text — фраза; now — текущий момент.
 * Возвращает { date: 'ГГГГ-ММ-ДД' | null, time: 'ЧЧ:ММ' | null, rest: фраза без срока }.
 */
export function parseWhen(text, now = new Date()) {
  let rest = ` ${text} `;
  const today = mskToday(now);
  let date = null;
  let time = null;
  const take = (re, fn) => {
    const m = re.exec(rest);
    if (!m) return false;
    const r = fn(m);
    if (r === false) return false;
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return true;
  };
  const pre = '(?:(?:на|к|ко|до|в|во|с|со)\\s+)?';

  // дата
  take(word(`${pre}(сегодня|завтра|послезавтра)`), (m) => {
    date = iso(addDays(today, { сегодня: 0, завтра: 1, послезавтра: 2 }[m[1].toLowerCase()]));
  }) ||
    take(word(`${pre}через\\s+(\\d{1,2}|один|одну|два|две|три|четыре|пять|неделю|месяц)\\s*(дн(?:я|ей|ь)|недел[июь]|месяц(?:а|ев)?)?`), (m) => {
      const words = { один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5 };
      const raw = m[1].toLowerCase();
      if (raw === 'неделю') return void (date = iso(addDays(today, 7)));
      if (raw === 'месяц') {
        const d = new Date(today);
        d.setUTCMonth(d.getUTCMonth() + 1);
        return void (date = iso(d));
      }
      const n = Number(raw) || words[raw];
      const unit = (m[2] ?? 'дня').toLowerCase();
      if (unit.startsWith('недел')) date = iso(addDays(today, 7 * n));
      else if (unit.startsWith('месяц')) {
        const d = new Date(today);
        d.setUTCMonth(d.getUTCMonth() + n);
        date = iso(d);
      } else date = iso(addDays(today, n));
    }) ||
    take(word(`${pre}(\\d{1,2})\\s+(${MONTHS.join('|')})[а-я]*(?:\\s+(\\d{4}))?(?:\\s*г(?:ода|\\.)?)?`), (m) => {
      const month = MONTHS.findIndex((mm) => new RegExp(`^${mm}`, 'i').test(m[2]));
      let year = m[3] ? Number(m[3]) : today.getUTCFullYear();
      let d = new Date(Date.UTC(year, month, Number(m[1]), 12));
      if (d.getUTCDate() !== Number(m[1])) return false;
      // без года и дата уже прошла — значит, следующий год
      if (!m[3] && d < today) d = new Date(Date.UTC(year + 1, month, Number(m[1]), 12));
      date = iso(d);
    }) ||
    take(word(`${pre}(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{2,4}))?`), (m) => {
      const day = Number(m[1]);
      const month = Number(m[2]) - 1;
      if (month > 11 || day < 1 || day > 31) return false;
      let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : today.getUTCFullYear();
      let d = new Date(Date.UTC(year, month, day, 12));
      if (!m[3] && d < today) d = new Date(Date.UTC(year + 1, month, day, 12));
      date = iso(d);
    }) ||
    take(word(`${pre}(?:следующ(?:ей|ую)\\s+недел[еию])`), () => {
      const dow = (today.getUTCDay() + 6) % 7; // 0 — понедельник
      date = iso(addDays(today, 7 - dow));
    }) ||
    take(word(`${pre}(?:этой\\s+недел[еи]|конц[ау]\\s+недели)`), () => {
      const dow = (today.getUTCDay() + 6) % 7;
      date = iso(addDays(today, Math.max(0, 4 - dow)));
    }) ||
    WEEKDAYS.some(([full, short], idx) =>
      take(word(`${pre}(?:${full}|${short})`), () => {
        const dow = (today.getUTCDay() + 6) % 7;
        let diff = (idx - dow + 7) % 7;
        if (diff === 0) diff = 7; // «в пятницу», сказанное в пятницу, — следующая
        date = iso(addDays(today, diff));
      }),
    );

  // время: «в 11», «в 11:30», «к 18.00», «на 13 00», «в 3 дня», «в 7 вечера», «в 10 утра», «в 15 часов»
  take(word(`(?:в|к|до|на|с)\\s+(\\d{1,2})(?:(?:[:.]|\\s(?=\\d{2}(?![\\d.:])))(\\d{2}))?(?:\\s*(?:час(?:а|ов)?|ч\\.?))?(?:\\s*(утра|дня|вечера|ночи))?`), (m) => {
    let hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    const part = m[3]?.toLowerCase();
    if (part === 'дня' || part === 'вечера') hh = hh < 12 ? hh + 12 : hh;
    if (part === 'ночи' && hh === 12) hh = 0;
    // «в 3» без уточнения — рабочий день: 1–7 — это 13–19
    if (!part && !m[2] && hh >= 1 && hh <= 7) hh += 12;
    if (hh > 23 || mm > 59) return false;
    time = `${pad(hh)}:${pad(mm)}`;
  });
  // «завтра 11:30» — время без предлога, но с двоеточием
  if (!time) {
    take(word('(\\d{1,2}):(\\d{2})'), (m) => {
      if (Number(m[1]) > 23 || Number(m[2]) > 59) return false;
      time = `${pad(Number(m[1]))}:${m[2]}`;
    });
  }
  if (time && !date) {
    // только время — сегодня, а если оно уже прошло — завтра
    const nowMsk = new Date(now.getTime() + 3 * 3600e3);
    const passed = `${pad(nowMsk.getUTCHours())}:${pad(nowMsk.getUTCMinutes())}` >= time;
    date = iso(addDays(today, passed ? 1 : 0));
  }

  rest = rest.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim().replace(/[,;]+$/, '').trim();
  return { date, time, rest };
}
