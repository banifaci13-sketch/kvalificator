// Брошенные диалоги: посетитель начал разговор с квалификатором, но не оставил контакт.
// Переписку читает администратор, чтобы понять, что спрашивают и где уходят. Это данные без
// согласия на обработку, поэтому через N дней (ABANDONED_DAYS, по умолчанию 10) из сессии
// стираются ответы и переписка — остаётся только шаг, на котором ушли (для сводки «где уходят»).

// незавершённый диалог считаем брошенным, если в нём ничего не происходило 5 минут (так же — в сводке
// «где уходят»). Закрыть окно чата — ещё не уйти: вернувшийся посетитель продолжит с того же места.
export const ABANDON_AFTER = '-5 minutes';
const IDLE = ABANDON_AFTER;

export function createAbandoned({ db, days = 10 }) {
  const q = {
    list: db.prepare(
      `SELECT id, channel, status, created_at, updated_at, state, meta FROM sessions
       WHERE status != 'done' AND json_extract(state, '$.purged') IS NULL
         AND (status = 'abandoned' OR updated_at < datetime('now', '${IDLE}'))
         AND json_array_length(json_extract(state, '$.transcript')) > 1
       ORDER BY updated_at DESC LIMIT ?`,
    ),
    purge: db.prepare(
      `UPDATE sessions
       SET state = json_object('stepId', json_extract(state, '$.stepId'), 'mode', json_extract(state, '$.mode'), 'purged', 1),
           meta = '{}', status = 'abandoned', handoff_code = NULL
       WHERE status != 'done' AND updated_at < datetime('now', ?) AND json_extract(state, '$.purged') IS NULL`,
    ),
  };

  const view = (row) => {
    const state = JSON.parse(row.state);
    const meta = JSON.parse(row.meta);
    const a = state.answers ?? {};
    return {
      id: row.id,
      channel: row.channel,
      startedAt: row.created_at,
      lastAt: row.updated_at,
      step: state.stepId ?? null,
      // что успели понять из разговора — коротко, для списка
      found: {
        name: a.name ?? null,
        company: a.company ?? null,
        services: a.services ?? (a.service ? [a.service] : []),
        budget: a.budget ?? null,
        start: a.start ?? null,
        summary: a.summary ?? null,
      },
      dialog: state.transcript ?? [],
      page: meta.page ?? null,
      utm: meta.utm ?? null,
      test: Boolean(meta.test),
    };
  };

  return {
    days,
    /** Брошенные диалоги с ИИ-квалификатором, новые сверху. */
    list: (limit = 200) => q.list.all(limit).map(view),
    /** Стереть переписку и ответы у незавершённых диалогов старше срока хранения. Возвращает, сколько стёрто. */
    purge: () => Number(q.purge.run(`-${days} days`).changes),
  };
}
