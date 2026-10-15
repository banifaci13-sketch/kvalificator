// Регулярные встречи: правило повтора → даты встреч (по Москве).
// Каждая встреча серии хранится обычной записью календаря — напоминания, итоги, задачи по итогам
// и подписка на календарь работают как для разовой. Серия создаёт встречи на HORIZON_DAYS вперёд
// и продлевается фоновой задачей.

export const REPEATS = {
  daily: 'Каждый день',
  weekdays: 'По будням (пн–пт)',
  weekly: 'Каждую неделю',
  biweekly: 'Раз в две недели',
  monthly: 'Каждый месяц, то же число',
  monthly_weekday: 'Каждый месяц, тот же день недели',
};
export const HORIZON_DAYS = 180;
export const MAX_COUNT = 500;

const WD = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WD_FULL = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
const ORD = ['', 'первый', 'второй', 'третий', 'четвёртый', 'последний'];
const ORD_ACC = ['', 'первую', 'вторую', 'третью', 'четвёртую', 'последнюю'];

const asDate = (iso) => new Date(`${iso}T12:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export function addDays(date, n) {
  const d = asDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
/** День недели: 1 — понедельник … 7 — воскресенье. */
export const weekday = (date) => ((asDate(date).getUTCDay() + 6) % 7) + 1;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** Какой по счёту этот день недели в месяце: 1–4; 29-е и позже — 5, «последний». */
export function nthOfMonth(date) {
  return Math.min(Math.ceil(asDate(date).getUTCDate() / 7), 5);
}

/**
 * Даты встреч серии по порядку: { date, n } (n — номер встречи от начала серии, с 1).
 * after — пропустить даты до неё включительно; to — не дальше этой даты.
 */
export function* seriesDates({ rule, days, start, until = null, count = null }, { after = null, to }) {
  const last = until && until < to ? until : to;
  const limit = Math.min(count ?? MAX_COUNT, MAX_COUNT);
  let n = 0;
  const emit = (date) => {
    n += 1;
    return date;
  };
  if (rule === 'monthly' || rule === 'monthly_weekday') {
    const s = asDate(start);
    const day = s.getUTCDate();
    const wd = weekday(start);
    const nth = nthOfMonth(start);
    for (let i = 0; n < limit; i++) {
      const y = s.getUTCFullYear() + Math.floor((s.getUTCMonth() + i) / 12);
      const mo = (s.getUTCMonth() + i) % 12;
      let date;
      if (rule === 'monthly') date = iso(new Date(Date.UTC(y, mo, Math.min(day, daysInMonth(y, mo)), 12)));
      else {
        // n-й такой день недели месяца; 5 — последний
        const first = new Date(Date.UTC(y, mo, 1, 12));
        const shift = (wd - (((first.getUTCDay() + 6) % 7) + 1) + 7) % 7;
        let dom = 1 + shift + (Math.min(nth, 4) - 1) * 7;
        if (nth === 5) while (dom + 7 <= daysInMonth(y, mo)) dom += 7;
        date = iso(new Date(Date.UTC(y, mo, dom, 12)));
      }
      if (date < start) continue;
      if (date > last) return;
      emit(date);
      if (!after || date > after) yield { date, n };
    }
    return;
  }
  const set = new Set(rule === 'weekdays' ? [1, 2, 3, 4, 5] : rule === 'daily' ? [1, 2, 3, 4, 5, 6, 7] : days?.length ? days : [weekday(start)]);
  const monday0 = addDays(start, 1 - weekday(start));
  for (let date = start; date <= last && n < limit; date = addDays(date, 1)) {
    if (!set.has(weekday(date))) continue;
    if (rule === 'biweekly') {
      const weeks = Math.round((asDate(addDays(date, 1 - weekday(date))) - asDate(monday0)) / (7 * 864e5));
      if (weeks % 2) continue;
    }
    emit(date);
    if (!after || date > after) yield { date, n };
  }
}

/** Проверка правила из формы: { rule, days?, until?, count? } → нормализованное или ошибка (строкой). */
export function normalizeRepeat(r, startDate) {
  if (!r || typeof r !== 'object') return { error: 'Неверное правило повтора' };
  if (!(r.rule in REPEATS)) return { error: 'Неизвестный повтор' };
  const days = ['weekly', 'biweekly'].includes(r.rule)
    ? [...new Set((r.days?.length ? r.days : [weekday(startDate)]).map(Number))].filter((d) => d >= 1 && d <= 7).sort()
    : null;
  if (days && !days.length) return { error: 'Выберите дни недели' };
  const until = r.until ? String(r.until).slice(0, 10) : null;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { error: 'Неверная дата окончания' };
  if (until && until < startDate) return { error: 'Дата окончания раньше первой встречи' };
  const count = r.count == null ? null : Number(r.count);
  if (count != null && (!Number.isInteger(count) || count < 2 || count > MAX_COUNT)) return { error: `Количество встреч — от 2 до ${MAX_COUNT}` };
  return { rule: r.rule, days, until: count ? null : until, count };
}

const fmtDate = (date) => asDate(date).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

/** «Каждую неделю по пн и чт в 10:00, до 31 декабря 2026 г.» */
export function repeatLabel(s, time = null) {
  const list = (days) => {
    const names = days.map((d) => WD[d]);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} и ${names.at(-1)}` : names[0];
  };
  let text;
  if (s.rule === 'weekly') text = `Каждую неделю по ${list(s.days ?? [weekday(s.start)])}`;
  else if (s.rule === 'biweekly') text = `Раз в две недели по ${list(s.days ?? [weekday(s.start)])}`;
  else if (s.rule === 'monthly') text = `Каждый месяц ${asDate(s.start).getUTCDate()}-го числа`;
  else if (s.rule === 'monthly_weekday') {
    const nth = nthOfMonth(s.start);
    const wd = weekday(s.start);
    // «в первый понедельник», «в последнюю пятницу»
    const female = [3, 5, 6].includes(wd);
    text = `Каждый месяц в ${female ? ORD_ACC[nth] : ORD[nth]} ${WD_FULL[wd]}`;
  } else text = REPEATS[s.rule];
  if (time) text += ` в ${time}`;
  if (s.until) text += `, до ${fmtDate(s.until)}`;
  else if (s.count) text += `, ${s.count} встреч${s.count % 10 === 1 && s.count % 100 !== 11 ? 'а' : [2, 3, 4].includes(s.count % 10) && ![12, 13, 14].includes(s.count % 100) ? 'и' : ''}`;
  return text;
}
