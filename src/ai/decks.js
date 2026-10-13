// ИИ-помощник для презентаций: черновик документа по брифу и правка слайда.
// Правила агентства зашиты в код, а не только в подсказку модели:
//  — слайды приводятся к схеме движка (лишние поля отбрасываются, типы проверяются);
//  — цифры, которых нет во входных данных, заменяются на [заполнить: …] — проверка перед выгрузкой
//    не пропустит документ, пока человек не впишет настоящие;
//  — название клиента, имена, телефоны и почта в модель не уходят: вместо них метки {{…}}.

import { slideCatalog, CHART_TYPES } from '../docs/schema.js';
import { SLIDE_TYPES } from '../docs/templates.js';
import { validateSpec } from '../docs/library.js';
import { AiError, extractJson } from './client.js';

export const KINDS = {
  kp: 'Коммерческое предложение',
  mediaplan: 'Медиаплан (презентация)',
  strategy: 'Стратегия продвижения',
  report: 'Отчёт клиенту',
  pitch: 'Презентация агентства',
  other: 'Другое',
};

export const ACTIONS = {
  shorten: { label: 'Сократить', prompt: 'Сократи тексты слайда примерно вдвое. Смысл и структуру сохрани.' },
  clarify: { label: 'Сделать яснее', prompt: 'Перепиши тексты проще и яснее: деловой стиль, короткие фразы, без канцелярита и штампов.' },
  persuasive: { label: 'Убедительнее', prompt: 'Сделай тексты убедительнее для клиента: от выгоды клиента, конкретно, без преувеличений и без новых фактов.' },
  fix: { label: 'Исправить ошибки', prompt: 'Исправь орфографию, пунктуацию и стилистические ошибки. Больше ничего не меняй.' },
  notes: { label: 'Заметки докладчика', prompt: 'Напиши заметки докладчика к слайду: 3–5 предложений, что сказать вслух. Верни только поле notes.' },
  custom: { label: 'Своя просьба', prompt: '' },
};

const PLACEHOLDER = '[заполнить: цифра]';
const MAX_SLIDES = 14;

// ---------- схема слайдов для подсказки ----------

function describeField(f) {
  switch (f.type) {
    case 'repeater':
      return `${f.key}: список до ${f.max ?? 6} объектов {${f.fields.map((x) => x.key).join(', ')}} — ${f.label}`;
    case 'group':
      return `${f.key}: объект {${f.fields.map((x) => x.key).join(', ')}} — ${f.label}`;
    case 'lines':
      return `${f.key}: список строк${f.max ? ` до ${f.max}` : ''} — ${f.label}`;
    case 'csv':
      return `${f.key}: список коротких строк — ${f.label}`;
    case 'chart':
      return `${f.key}: {type: ${CHART_TYPES.map(([t]) => t).join('|')}, categories: [строки], series: [{name, values: [числа]}]} — ${f.label}`;
    case 'select':
      return `${f.key}: одно из ${f.options.map(([v]) => v).join('|')} — ${f.label}`;
    case 'checkbox':
      return `${f.key}: true|false — ${f.label}`;
    case 'number':
      return `${f.key}: число — ${f.label}`;
    default:
      return `${f.key}: текст${f.max ? ` до ${f.max} символов` : ''} — ${f.label}`;
  }
}

export function schemaPrompt() {
  return slideCatalog()
    .map((t) => `• ${t.type} — «${t.label}»${t.required.length ? ` (обязательно: ${t.required.join(', ')})` : ''}\n  ${t.fields.map(describeField).join('\n  ')}`)
    .join('\n');
}

const RULES = `Правила, которые нельзя нарушать:
1. Пиши по-русски, деловым языком агентства, без воды и штампов. Один слайд — одна мысль. Заголовок до 70 символов.
2. Не придумывай цифры, проценты, суммы, сроки, названия компаний, клиентов, кейсы, результаты и источники. Если нужна цифра или факт, которых нет во входных данных, пиши «[заполнить: что именно нужно]».
3. Название клиента пиши как {{client}}, дату — {{date}}, менеджера — {{manager}}. Любые {{метки}} из входных данных оставляй как есть.
4. У слайдов с цифрами (kpi, chart, analytics, mediaplan) обязательно dataStatus и source. Если цифр во входных данных нет — лучше не делай такой слайд или поставь dataStatus "hypothesis" и заготовки.
5. Слайд case — только если во входных данных есть реальный кейс; verified всегда false (подтверждает человек).
6. Списки — до 4–5 пунктов, пункт до 90 символов.
7. Ответ — только JSON, без пояснений.`;

// ---------- обезличивание ----------

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;

/** Заменяет известные имена, телефоны и почту на метки; restore() возвращает их обратно. */
export function createMask({ client = '', contact = '' } = {}) {
  const map = new Map();
  let n = 0;
  const token = (value, kind) => {
    for (const [k, v] of map) if (v === value) return k;
    const key = kind === 'client' ? '{{client}}' : kind === 'contact' ? '{{contact_name}}' : `{{${kind}_${++n}}}`;
    map.set(key, value);
    return key;
  };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [
    [client?.trim(), 'client'],
    [contact?.trim(), 'contact'],
  ].filter(([v]) => v && v.length >= 3);
  const maskStr = (s) => {
    let out = s.replace(EMAIL_RE, (m) => token(m, 'email')).replace(PHONE_RE, (m) => token(m, 'phone'));
    for (const [v, kind] of names) out = out.replace(new RegExp(escapeRe(v), 'gi'), () => token(v, kind));
    return out;
  };
  const restoreStr = (s) => {
    let out = s;
    for (const [k, v] of map) if (k !== '{{client}}' || client) out = out.split(k).join(v);
    return out;
  };
  return { mask: (obj) => mapStrings(obj, maskStr), restore: (obj) => mapStrings(obj, restoreStr), maskText: maskStr };
}

// ---------- цифры ----------

const NUM_RE = /\d+(?:[\s  ]\d{3})*(?:[.,]\d+)?/g;
const normNum = (s) => String(Number(s.replace(/[\s  ]/g, '').replace(',', '.')));

/** Все числа во входных данных — только их модель может повторить. */
export function allowedNumbers(...sources) {
  const set = new Set();
  for (const src of sources) {
    walkStrings(src, (s) => {
      for (const m of s.matchAll(NUM_RE)) set.add(normNum(m[0]));
    });
    walkNumbers(src, (v) => set.add(String(v)));
  }
  return set;
}

function numberAllowed(token, after, allowed) {
  const n = Number(normNum(token));
  if (allowed.has(String(n))) return true;
  if (Number.isInteger(n) && n >= 2000 && n <= 2100) return true; // годы
  // «3 шага», «5 направлений» — счёт, а не данные; «5 %» или «5 млн» — данные
  return Number.isInteger(n) && n <= 12 && !/^\s*(%|₽|руб|тыс|млн|млрд|процент|раз|x\b|х\b)/i.test(after);
}

function guardString(s, allowed, counter) {
  if (/^\[заполнить/i.test(s)) return s;
  return s.replace(NUM_RE, (m, offset) => {
    // внутри [заполнить: …] цифры — часть подсказки
    const before = s.slice(0, offset);
    if (before.lastIndexOf('[заполнить') > before.lastIndexOf(']')) return m;
    if (numberAllowed(m, s.slice(offset + m.length), allowed)) return m;
    counter.n += 1;
    return PLACEHOLDER;
  });
}

/** Убирает выдуманные цифры из слайдов. Возвращает число замен. */
export function guardNumbers(slides, allowed) {
  const counter = { n: 0 };
  const numberField = (v) => {
    if (v == null) return null;
    if (allowed.has(String(v))) return v;
    counter.n += 1;
    return null;
  };
  const fieldsOf = (type) => Object.fromEntries((SLIDE_TYPE_FIELDS[type] ?? []).map((f) => [f.key, f]));
  const fix = (obj, fields) => {
    for (const [k, f] of Object.entries(fields)) {
      const v = obj[k];
      if (v == null) continue;
      if (f.type === 'number') obj[k] = k === 'number' && Number.isInteger(v) && v <= 20 ? v : numberField(v);
      else if (f.type === 'repeater') v.forEach((item) => fix(item, Object.fromEntries(f.fields.map((x) => [x.key, x]))));
      else if (f.type === 'group') fix(v, Object.fromEntries(f.fields.map((x) => [x.key, x])));
      else if (f.type === 'chart') {
        v.series.forEach((s) => (s.values = s.values.map(numberField)));
        v.categories = v.categories.map((c) => guardString(c, allowed, counter));
        v.series.forEach((s) => (s.name = guardString(s.name, allowed, counter)));
      } else if (Array.isArray(v)) obj[k] = v.map((x) => (typeof x === 'string' ? guardString(x, allowed, counter) : x));
      else if (typeof v === 'string' && f.type !== 'select') obj[k] = guardString(v, allowed, counter);
    }
  };
  for (const s of slides) fix(s, { ...fieldsOf(s.type), notes: { type: 'textarea' } });
  return counter.n;
}

// ---------- приведение к схеме ----------

const SLIDE_TYPE_FIELDS = Object.fromEntries(slideCatalog().map((t) => [t.type, t.fields]));

function cleanValue(f, v) {
  if (v == null) return undefined;
  switch (f.type) {
    case 'text':
    case 'textarea':
      return typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, f.max ? f.max * 2 : 2000) : undefined;
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[\s ]/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    case 'select':
      return f.options.some(([o]) => o === v) ? v : undefined;
    case 'checkbox':
      return Boolean(v);
    case 'lines':
    case 'csv': {
      const list = Array.isArray(v) ? v : String(v).split(f.type === 'csv' ? ',' : '\n');
      return list.map((x) => String(x).trim()).filter(Boolean).slice(0, f.max ?? 8);
    }
    case 'repeater':
      return (Array.isArray(v) ? v : []).slice(0, f.max ?? 8).map((item) => cleanObject(f.fields, item ?? {}));
    case 'group':
      return cleanObject(f.fields, v);
    case 'chart': {
      const type = CHART_TYPES.some(([t]) => t === v.type) ? v.type : 'column';
      const categories = (Array.isArray(v.categories) ? v.categories : []).map(String).slice(0, 12);
      const series = (Array.isArray(v.series) ? v.series : []).slice(0, 4).map((s) => ({
        name: String(s?.name ?? ''),
        values: categories.map((_, i) => {
          const n = Number(s?.values?.[i]);
          return Number.isFinite(n) ? n : null;
        }),
      }));
      return { type, categories, series: series.length ? series : [{ name: '', values: categories.map(() => null) }] };
    }
    default:
      return undefined;
  }
}

function cleanObject(fields, obj) {
  const out = {};
  for (const f of fields) {
    const v = cleanValue(f, obj?.[f.key]);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

export function cleanSlide(raw) {
  const type = raw?.type;
  if (!SLIDE_TYPES[type]) return null;
  const slide = { type, ...cleanObject(SLIDE_TYPE_FIELDS[type], raw) };
  if (type === 'case') slide.verified = false; // подтверждает только человек
  if (SLIDE_TYPES[type].data) {
    slide.dataStatus ??= 'hypothesis';
    slide.source ??= '[заполнить: источник данных]';
  }
  return slide;
}

// ---------- черновик документа ----------

/**
 * brief — текст менеджера; facts — [[подпись, значение]] из заявки (уже без имён и контактов).
 * Возвращает { title, spec, replaced }.
 */
export async function draftDeck(ai, { kind = 'kp', brief = '', facts = [], slides = 8, mask }) {
  const count = Math.max(4, Math.min(MAX_SLIDES, Number(slides) || 8));
  const briefText = mask ? mask.maskText(brief) : brief;
  const factsText = facts.map(([k, v]) => `${k}: ${mask ? mask.maskText(String(v)) : v}`).join('\n');
  const system = `Ты — старший стратег digital-агентства Soroka Marketing. Готовишь черновик презентации, который менеджер доработает в редакторе.

Доступные типы слайдов и их поля:
${schemaPrompt()}

${RULES}

Формат ответа: {"title": "название документа", "slides": [{"type": "...", ...поля}, ...]}. Первый слайд — cover, последний — closing.`;
  const user = `Документ: ${KINDS[kind] ?? KINDS.other}. Слайдов: около ${count}.
${factsText ? `\nДанные из заявки клиента:\n${factsText}\n` : ''}
Бриф менеджера — главный источник:
${briefText || '(пусто — опирайся на данные заявки)'}

Каждый слайд должен отвечать именно на этот бриф: продукт и задача клиента, аудитория, каналы, цели, ограничения и пожелания менеджера — его словами и терминами. Не подменяй бриф общими словами об агентстве. Если менеджер просит определённую структуру, тон или акценты — выполни это.`;

  // модель иногда обрывает или портит JSON — одна повторная попытка с напоминанием о формате
  let raw;
  for (let attempt = 0; ; attempt++) {
    const { text } = await ai.complete({ system, user: attempt ? `${user}\n\nВажно: ответ — строго валидный JSON, без пояснений и комментариев.` : user, maxTokens: 6000 });
    try {
      raw = extractJson(text);
      if (!Array.isArray(raw.slides) || raw.slides.length < 2) throw new AiError('ИИ не смог собрать слайды — уточните бриф и попробуйте ещё раз');
      break;
    } catch (err) {
      if (attempt >= 1) throw err;
    }
  }
  const list = (Array.isArray(raw.slides) ? raw.slides : []).map(cleanSlide).filter(Boolean).slice(0, MAX_SLIDES);
  if (list.length < 2) throw new AiError('ИИ не смог собрать слайды — уточните бриф и попробуйте ещё раз');
  const allowed = allowedNumbers(briefText, factsText);
  let replaced = guardNumbers(list, allowed);
  let spec = { meta: { title: String(raw.title ?? KINDS[kind]).slice(0, 200) }, slides: list };
  if (mask) spec = mask.restore(spec);
  // невалидный слайд не валит весь черновик: проверка в редакторе подсветит, что дописать
  validateSpec(spec);
  return { title: spec.meta.title, spec, replaced };
}

// ---------- правка слайда ----------

const TEXT_TYPES = new Set(['text', 'textarea', 'lines', 'csv']);

/** Переносит из ответа модели только тексты; цифры, график, статус и источник остаются прежними. */
function mergeTexts(original, edited, fields) {
  const out = structuredClone(original);
  for (const f of fields) {
    const k = f.key;
    if (TEXT_TYPES.has(f.type) && !f.figure && edited[k] !== undefined) out[k] = edited[k];
    if (f.type === 'repeater' && Array.isArray(out[k]) && Array.isArray(edited[k]) && edited[k].length === out[k].length) {
      out[k] = out[k].map((item, i) => mergeTexts(item, edited[k][i] ?? {}, f.fields));
    }
    if (f.type === 'group' && out[k] && edited[k]) out[k] = mergeTexts(out[k], edited[k], f.fields);
  }
  return out;
}

export async function rewriteSlide(ai, { slide, action, instruction = '', mask }) {
  const a = ACTIONS[action];
  if (!a) throw new AiError('Неизвестное действие');
  if (action === 'custom' && !instruction.trim()) throw new AiError('Напишите, что сделать со слайдом');
  const fields = SLIDE_TYPE_FIELDS[slide.type];
  if (!fields) throw new AiError('Неизвестный тип слайда');
  const masked = mask ? mask.mask(slide) : slide;
  const system = `Ты — редактор презентаций digital-агентства Soroka Marketing. Правишь один слайд.

Поля слайда «${SLIDE_TYPES[slide.type].label}» (${slide.type}):
${fields.map(describeField).join('\n')}

${RULES}

Верни слайд целиком в том же JSON-формате, с теми же полями и тем же числом элементов в списках.`;
  const user = `Задача: ${action === 'custom' ? instruction.trim() : a.prompt}

Слайд:
${JSON.stringify(masked, null, 1)}`;
  const { text } = await ai.complete({ system, user, maxTokens: 3000 });
  const edited = cleanSlide({ ...extractJson(text), type: slide.type }) ?? {};
  let next;
  if (action === 'notes') {
    next = { ...masked, notes: typeof edited.notes === 'string' ? edited.notes : masked.notes };
  } else {
    next = mergeTexts(masked, edited, fields);
    if (typeof edited.notes === 'string' && masked.notes) next.notes = edited.notes;
  }
  const replaced = guardNumbers([next], allowedNumbers(masked, instruction));
  return { slide: mask ? mask.restore(next) : next, replaced };
}

// ---------- обход ----------

function walkStrings(obj, fn) {
  if (typeof obj === 'string') return fn(obj);
  if (Array.isArray(obj)) return obj.forEach((v) => walkStrings(v, fn));
  if (obj && typeof obj === 'object') Object.values(obj).forEach((v) => walkStrings(v, fn));
}
function walkNumbers(obj, fn) {
  if (typeof obj === 'number') return fn(obj);
  if (Array.isArray(obj)) return obj.forEach((v) => walkNumbers(v, fn));
  if (obj && typeof obj === 'object') Object.values(obj).forEach((v) => walkNumbers(v, fn));
}
function mapStrings(obj, fn) {
  if (typeof obj === 'string') return fn(obj);
  if (Array.isArray(obj)) return obj.map((v) => mapStrings(v, fn));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, mapStrings(v, fn)]));
  return obj;
}
