// Наблюдение за сервером изнутри: когда последний раз отработали фоновые задачи и чем закончились,
// последние ошибки из журнала. Хранится в памяти процесса (после перезапуска — с чистого листа):
// это оперативная картина для администратора, а не архив. Тексты ошибок обрезаются, тела запросов
// и данные пользователей сюда не попадают — только сообщение и место.

const MAX_ERRORS = 30;
const cut = (s, n = 300) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

export function createMonitor({ now = () => new Date() } = {}) {
  const jobs = new Map();
  const errors = [];
  const startedAt = now().toISOString();
  let logger = null;

  /** Фоновая задача: name — ключ, label — как назвать в интерфейсе, everyMs — как часто должна работать. */
  function job(name, label, everyMs) {
    if (!jobs.has(name)) jobs.set(name, { name, label, everyMs, runs: 0, fails: 0, lastRun: null, lastOk: null, lastError: null, lastErrorAt: null });
    const j = jobs.get(name);
    return async (fn) => {
      j.lastRun = now().toISOString();
      j.runs += 1;
      try {
        const out = await fn();
        j.lastOk = now().toISOString();
        return out;
      } catch (err) {
        j.fails += 1;
        j.lastError = cut(err?.message ?? err);
        j.lastErrorAt = now().toISOString();
        // в журнал сервера (оттуда ошибка попадёт и в список через logHook) или сразу в список
        if (logger) logger.error({ err }, `Фоновая задача «${label}»`);
        else error(`Фоновая задача «${label}»`, err);
        return undefined;
      }
    };
  }

  function error(where, err) {
    errors.push({ at: now().toISOString(), where: cut(where, 120), message: cut(err?.message ?? err) });
    if (errors.length > MAX_ERRORS) errors.shift();
  }

  /** Для pino: hooks.logMethod — ошибки (уровень 50+) попадают в список. */
  function logHook(args, method, level) {
    if (level >= 50) {
      const [a, b] = args;
      const msg = typeof a === 'string' ? a : (b ?? '');
      const err = a && typeof a === 'object' ? (a.err ?? a) : null;
      error(msg || 'Ошибка сервера', err?.message ? err : msg);
    }
    return method.apply(this, args);
  }

  function snapshot() {
    const t = now().getTime();
    return {
      startedAt,
      jobs: [...jobs.values()].map((j) => ({
        ...j,
        // давно не запускалась: больше трёх интервалов (или 5 минут для частых)
        stale: Boolean(j.everyMs && (j.lastRun ? t - Date.parse(j.lastRun) : t - Date.parse(startedAt)) > Math.max(3 * j.everyMs, 5 * 60e3)),
      })),
      errors: [...errors].reverse(),
    };
  }

  /** Журнал сервера (pino), созданный уже с logHook. */
  const useLog = (l) => {
    logger = l;
  };

  return { job, error, logHook, snapshot, useLog };
}
