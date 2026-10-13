// Сервис квалификации: сессии, ответы, финальная оценка и уведомление менеджеров.
// Каналы (виджет, Telegram, MAX) вызывают только этот модуль.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createEngine, AnswerError } from './engine.js';
import { scoreLead, outroKey } from './scoring.js';

export { AnswerError };

export class SessionError extends Error {}

export function createQualifier({ db, scenarioSource, rules, notifier, log = console }) {
  const leadHooks = [];
  let engineFor = null;
  let engine = null;
  const getEngine = () => {
    const scenario = scenarioSource.get();
    if (engineFor !== scenario) {
      engine = createEngine(scenario);
      engineFor = scenario;
    }
    return engine;
  };

  // Ответы одной сессии обрабатываем строго по очереди (двойной клик, повтор запроса)
  const locks = new Map();
  async function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  function startSession({ channel, channelUserId = null, meta = {} }) {
    const { state, reply } = getEngine().start();
    const session = db.createSession({
      id: randomUUID(),
      token: randomBytes(24).toString('base64url'),
      channel,
      channelUserId: channelUserId == null ? null : String(channelUserId),
      handoffCode: randomBytes(12).toString('base64url'),
      state,
      meta,
    });
    return { session, reply: withIntro(reply) };
  }

  function getSession(id, token) {
    const session = db.getSession(id);
    if (!session || (token !== undefined && !safeEqual(session.token, token))) {
      throw new SessionError('Сессия не найдена');
    }
    return session;
  }

  function resume(session) {
    if (session.status === 'done') return { type: 'done', text: scenarioSource.get().outro.warm };
    return getEngine().current(session.state);
  }

  async function answer(sessionId, input) {
    return withLock(sessionId, async () => {
      const session = db.getSession(sessionId);
      if (!session) throw new SessionError('Сессия не найдена');
      if (session.status === 'done') throw new AnswerError('Опрос уже завершён');

      const { state, reply } = getEngine().answer(session.state, input);
      if (reply.type !== 'done') {
        db.saveState(session.id, state);
        return reply;
      }
      return finish(session, state);
    });
  }

  function finish(session, state) {
    const scenario = scenarioSource.get();
    const result = scoreLead(state.answers, rules, scenario);
    const lead = db.completeSession(session, state, result);
    log.info({ leadId: lead.id, rating: lead.rating, channel: lead.channel }, 'Новый лид');
    void deliver(lead);
    // подписчики на новые заявки (например, задача «Связаться» по горячей заявке); их ошибки не мешают клиенту
    for (const fn of leadHooks) {
      try {
        fn(lead);
      } catch (err) {
        log.error({ err, leadId: lead.id }, 'Обработчик новой заявки упал');
      }
    }

    const reply = { type: 'done', text: scenario.outro[outroKey(lead.rating)] };
    const hint = scenario.budgetHints?.[state.answers.service];
    if (lead.rating === 2 && hint) reply.hint = hint;
    return reply;
  }

  const delivering = new Set();
  async function deliver(lead) {
    if (!notifier || delivering.has(lead.id)) return;
    delivering.add(lead.id);
    try {
      const { delivered, errors } = await notifier.notifyLead(lead, scenarioSource.get(), lead.delivered);
      db.setDelivered(lead.id, delivered, errors.length === 0);
      for (const err of errors) log.error({ err, leadId: lead.id }, 'Лид не доставлен, повторю позже');
    } catch (err) {
      log.error({ err, leadId: lead.id }, 'Лид не доставлен, повторю позже');
    } finally {
      delivering.delete(lead.id);
    }
  }

  /** Повторная отправка лидов, которые не ушли менеджерам (сбой сети, Telegram недоступен). */
  async function retryUndelivered({ minAgeSeconds } = {}) {
    for (const lead of db.unnotifiedLeads(minAgeSeconds)) await deliver(lead);
  }

  /** Продолжение диалога из виджета в мессенджере по deep link. */
  function claimHandoff(code, channel, channelUserId, meta = {}) {
    const session = db.getSessionByHandoff(code);
    if (!session || session.status !== 'active') return null;
    db.moveToChannel(session.id, channel, channelUserId, meta);
    return db.getSession(session.id);
  }

  function withIntro(reply) {
    return { ...reply, intro: scenarioSource.get().intro };
  }

  /** Незавершённый диалог пользователя в мессенджере. */
  function activeSession(channel, channelUserId) {
    return db.getActiveSession(channel, channelUserId);
  }

  /** Менеджер берёт лид в работу. ok: false — лид уже взял кто-то другой. */
  function takeLead(leadId, assignee) {
    const lead = db.getLead(leadId);
    if (!lead) return { ok: false, lead: null };
    return { ok: db.assignLead(leadId, assignee), lead: db.getLead(leadId) };
  }

  return { startSession, getSession, resume, answer, claimHandoff, activeSession, takeLead, retryUndelivered, onLead: (fn) => leadHooks.push(fn) };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
