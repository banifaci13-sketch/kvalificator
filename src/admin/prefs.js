// Личные настройки внешнего вида кабинета. Хранятся в профиле сотрудника (admin_users.prefs),
// поэтому одинаковы на любом устройстве, где он вошёл. Принимаются только известные значения.

export const PREF_OPTIONS = {
  theme: ['system', 'light', 'dark'],
  accent: ['soroka', 'blue', 'violet', 'green', 'orange', 'pink', 'graphite'],
  background: ['none', 'mist', 'aurora', 'sunset', 'night', 'paper'],
  density: ['comfortable', 'compact'],
  sidebar: ['full', 'icons'],
  start: ['docs', 'tasks', 'mytasks', 'calendar', 'plans', 'leads'],
};

export const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'soroka',
  background: 'none',
  density: 'comfortable',
  sidebar: 'full',
  start: 'docs',
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
    if (PREF_OPTIONS[key].includes(v) || (key === 'background' && MEDIA_BG.test(v ?? ''))) out[key] = v;
  }
  return out;
}

/** Проверка изменения; mediaExists(id) — есть ли такая картинка в медиатеке. */
export function checkPrefsPatch(patch, { mediaExists = () => false } = {}) {
  for (const [key, v] of Object.entries(patch)) {
    if (!(key in DEFAULT_PREFS)) throw new PrefsError(`Неизвестная настройка «${key}»`);
    if (PREF_OPTIONS[key].includes(v)) continue;
    const m = key === 'background' && MEDIA_BG.exec(v ?? '');
    if (m && mediaExists(Number(m[1]))) continue;
    throw new PrefsError(m ? 'Картинка для фона не найдена в медиатеке' : `Недопустимое значение для «${key}»`);
  }
  return patch;
}
