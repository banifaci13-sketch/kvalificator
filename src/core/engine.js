// Движок сценария квалификации. Не знает о каналах (виджет, Telegram, MAX):
// принимает состояние сессии и ответ, возвращает новое состояние и следующий вопрос.

const MAX_TEXT_LENGTH = 1000;

export class AnswerError extends Error {}

export function createEngine(scenario) {
  const stepsById = new Map(scenario.steps.map((s) => [s.id, s]));

  function isVisible(step, answers) {
    if (!step.when) return true;
    return Object.entries(step.when).every(([id, allowed]) => allowed.includes(answers[id]));
  }

  function visibleSteps(answers) {
    return scenario.steps.filter((s) => isVisible(s, answers));
  }

  function findNext(state) {
    return visibleSteps(state.answers).find(
      (s) => !(s.id in state.answers) && !state.skipped.includes(s.id),
    );
  }

  function render(step, state) {
    if (!step) return { type: 'done' };
    const steps = visibleSteps(state.answers);
    return {
      type: 'question',
      step: {
        id: step.id,
        type: step.type,
        text: step.text,
        required: Boolean(step.required),
        placeholder: step.placeholder ?? null,
        options: step.options?.map(({ value, label }) => ({ value, label })) ?? null,
      },
      progress: { index: steps.indexOf(step) + 1, total: steps.length },
    };
  }

  function start() {
    const state = { stepId: null, answers: {}, skipped: [] };
    const step = findNext(state);
    state.stepId = step?.id ?? null;
    return { state, reply: render(step, state) };
  }

  // Если вопрос убрали из таблицы посреди диалога — переходим к следующему актуальному
  function currentStep(state) {
    if (!state.stepId) return null;
    const step = stepsById.get(state.stepId);
    return step && isVisible(step, state.answers) ? step : findNext(state) ?? null;
  }

  /** Текущий вопрос — для повторного показа после перезагрузки страницы. */
  function current(state) {
    return render(currentStep(state), state);
  }

  /**
   * @param {{stepId: string|null, answers: object, skipped: string[]}} state
   * @param {{stepId?: string, value?: unknown, skip?: boolean}} input
   */
  function answer(state, input) {
    const step = currentStep(state);
    if (!step) throw new AnswerError('Опрос уже завершён');
    if (input.stepId && input.stepId !== step.id) {
      throw new AnswerError('Этот вопрос уже пройден');
    }

    const next = { ...state, answers: { ...state.answers }, skipped: [...state.skipped] };
    if (input.skip) {
      if (step.required) throw new AnswerError('Этот вопрос обязательный');
      next.skipped.push(step.id);
    } else {
      next.answers[step.id] = normalize(step, input.value);
    }

    const following = findNext(next);
    next.stepId = following?.id ?? null;
    return { state: next, reply: render(following, next) };
  }

  return { start, answer, current, stepsById };
}

function normalize(step, value) {
  switch (step.type) {
    case 'choice':
    case 'consent':
      return normalizeChoice(step, value);
    case 'contact':
      return normalizeContact(value);
    case 'text':
      return normalizeText(value);
    default:
      throw new Error(`Неизвестный тип шага: ${step.type}`);
  }
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  if (text.length < 2) throw new AnswerError('Напишите, пожалуйста, чуть подробнее');
  return text.slice(0, MAX_TEXT_LENGTH);
}

function normalizeChoice(step, value) {
  const raw = String(value ?? '').trim();
  const lower = raw.toLowerCase();
  const byNumber = /^\d+$/.test(raw) ? step.options[Number(raw) - 1] : undefined;
  const option =
    step.options.find((o) => o.value === raw) ??
    step.options.find((o) => o.label.toLowerCase() === lower) ??
    byNumber;
  if (!option) throw new AnswerError('Выберите, пожалуйста, один из вариантов');
  return option.value;
}

const EMAIL_RE = /[^\s@<>(),;:"'«»]+@[^\s@<>(),;:"'«»]+\.[a-zа-я]{2,}/i;
const TG_LINK_RE = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-z][a-z0-9_]{3,31})/i;
const TG_RE = /(?<![\w.@])@([a-z][a-z0-9_]{3,31})(?![\w@]|\.[a-z])/i;
// «тг anna_smm», «телеграм: anna_smm» — ник без @
const TG_WORD_RE = /(?:тг|телеграм\S*|телега\S*|telegram|tg)\s*[:—-]?\s*@?([a-z][a-z0-9_]{3,31})(?![\w.])/i;
const PHONE_RE = /(?:\+?\s?7|(?<!\d)8)?[\s(‐–-]*\d{3}[\s)‐–-]*\d{3}[\s‐–-]*\d{2}[\s‐–-]*\d{2}(?!\d)|\+\d{1,3}[\d\s()‐–-]{7,16}\d/;
const VK_RE = /(?:https?:\/\/)?(?:m\.)?vk\.(?:com|ru)\/[a-z0-9_.]+/i;

/**
 * Контакт из ответа клиента: телефон, Telegram, e-mail или ВКонтакте — в том числе внутри фразы
 * («мой номер 8 (900) 123-45-67, звоните после 18», «пишите в тг anna_smm»). raw — как написал клиент.
 */
export function normalizeContact(value) {
  // Мессенджеры присылают контакт объектом (кнопка «Поделиться номером»)
  if (value && typeof value === 'object') {
    const phone = normalizePhone(value.phone);
    if (!phone) throw new AnswerError('Не удалось прочитать номер телефона');
    return { raw: phone, phone, ...(value.name ? { name: String(value.name) } : {}) };
  }
  const raw = String(value ?? '').trim().slice(0, 200);
  const out = { raw };
  const email = EMAIL_RE.exec(raw)?.[0];
  if (email) out.email = email.toLowerCase();
  // без почты: в «anna@mail.ru» ник «@mail» — не Telegram
  const rest = email ? raw.replace(email, ' ') : raw;
  const tg = TG_LINK_RE.exec(rest)?.[1] ?? TG_RE.exec(rest)?.[1] ?? TG_WORD_RE.exec(rest)?.[1];
  if (tg) out.telegram = `@${tg}`;
  const phoneText = PHONE_RE.exec(rest.replace(TG_LINK_RE, ' '))?.[0];
  const phone = normalizePhone(phoneText) ?? (!email && !tg ? normalizePhone(raw) : null);
  if (phone) out.phone = phone;
  const vk = VK_RE.exec(rest)?.[0];
  if (vk) out.vk = vk;
  if (out.email || out.telegram || out.phone || out.vk) return out;
  throw new AnswerError('Укажите телефон, e-mail или Telegram (например, @username)');
}

function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  return `+${digits}`;
}
