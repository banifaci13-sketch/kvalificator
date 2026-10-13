// Личные настройки внешнего вида кабинета. Хранятся в профиле сотрудника (admin_users.prefs),
// поэтому одинаковы на любом устройстве, где он вошёл. Принимаются только известные значения.

export const PREF_OPTIONS = {
  theme: ['system', 'light', 'dark'],
  accent: ['soroka', 'blue', 'violet', 'green', 'orange', 'pink', 'graphite'],
  background: ['none', 'mist', 'aurora', 'sunset', 'night', 'paper'],
  density: ['comfortable', 'compact'],
  sidebar: ['full', 'icons'],
  start: ['home', 'news', 'chat', 'docs', 'tasks', 'mytasks', 'calendar', 'plans', 'leads'],
  // ассистент: на «вы» или на «ты», искать ли в интернете
  address: ['vy', 'ty'],
  webSearch: ['on', 'off'],
  // уведомления: всплывающие в кабинете, системные браузера, звук, тихие часы
  notifyPopup: ['on', 'off'],
  notifyBrowser: ['off', 'on'],
  notifySound: ['on', 'off'],
  notifyQuiet: ['off', '22-9', '21-9', '20-8', '23-8', '19-9'],
};
// категории уведомлений, которые можно отключить: «-comments,-news» в notifyMute
export const NOTIFY_CATEGORIES = ['messages', 'tasks', 'comments', 'mentions', 'meetings', 'payments', 'news'];
const validMute = (v) => typeof v === 'string' && v.length <= 100 && (v === '' || v.split(',').every((x) => NOTIFY_CATEGORIES.includes(x)));
export const NAV_IDS = ['home', 'news', 'chat', 'docs', 'templates', 'plans', 'tasks', 'calendar', 'leads', 'kb', 'staff'];
const validNav = (v) => typeof v === 'string' && v.length <= 200 && (v === '' || v.split(',').every((x) => NAV_IDS.includes(x.replace(/^-/, ''))));
// имя ассистента — свободное, но короткое и без разметки
const NAME_RE = /^[A-Za-zА-Яа-яЁё0-9 .-]{1,24}$/;

export const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'soroka',
  background: 'none',
  density: 'comfortable',
  sidebar: 'full',
  start: 'home',
  assistantName: '',
  // порядок разделов меню: «home,docs,-templates,…»; минус — раздел спрятан; пусто — как задумано
  nav: '',
  address: 'vy',
  webSearch: 'on',
  notifyPopup: 'on',
  notifyBrowser: 'off',
  notifySound: 'on',
  notifyQuiet: 'off',
  notifyMute: '',
};

// своё фото фоном — картинка из медиатеки: «media:<id>»
const MEDIA_BG = /^media:(\d{1,10})$/;

export class PrefsError extends Error {}

/** Сохранённые настройки поверх значений по умолчанию; испорченная запись не ломает вход. */
export function readPrefs(raw) {
  let saved = {};
  try {
    saved = raw ? JSON.parse(raw) : {};
  } catch {
    saved = {};
  }
  const out = { ...DEFAULT_PREFS };
  for (const key of Object.keys(DEFAULT_PREFS)) {
    const v = saved?.[key];
    if (key === 'assistantName') out[key] = typeof v === 'string' && (v === '' || NAME_RE.test(v)) ? v : '';
    else if (key === 'nav') out[key] = validNav(v) ? v : '';
    else if (key === 'notifyMute') out[key] = validMute(v) ? v : '';
    else if (PREF_OPTIONS[key].includes(v) || (key === 'background' && MEDIA_BG.test(v ?? ''))) out[key] = v;
  }
  return out;
}

/** Проверка изменения; mediaExists(id) — есть ли такая картинка в медиатеке. */
export function checkPrefsPatch(patch, { mediaExists = () => false } = {}) {
  for (const [key, v] of Object.entries(patch)) {
    if (!(key in DEFAULT_PREFS)) throw new PrefsError(`Неизвестная настройка «${key}»`);
    if (key === 'assistantName') {
      if (v === '' || NAME_RE.test(v)) continue;
      throw new PrefsError('Имя ассистента — до 24 букв и цифр');
    }
    if (key === 'nav') {
      if (validNav(v)) continue;
      throw new PrefsError('Неизвестный раздел меню');
    }
    if (key === 'notifyMute') {
      if (validMute(v)) continue;
      throw new PrefsError('Неизвестная категория уведомлений');
    }
    if (PREF_OPTIONS[key].includes(v)) continue;
    const m = key === 'background' && MEDIA_BG.exec(v ?? '');
    if (m && mediaExists(Number(m[1]))) continue;
    throw new PrefsError(m ? 'Картинка для фона не найдена в медиатеке' : `Недопустимое значение для «${key}»`);
  }
  return patch;
}
