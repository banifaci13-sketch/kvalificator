// Предварительная стоимость «от … ₽» для квалификатора — по прайсу агентства (config/pricing.json).
// Сумму считает код, а не ИИ: модель только определяет направления (услуги сценария), а какой
// продукт прайса взять, решают слова клиента. Нет файла или нет цены — шаг с ценой пропускается.
//
// config/pricing.json:
//   "services": { "<значение услуги из сценария>": [варианты] } — общие слова направления
//               («директ», «таргет»): по ним понятно направление, а цена — у продукта по умолчанию
//   "products": [ { "id", "name", "from": 30000 | null, "note"?,
//                   "service"?:  "<значение услуги из сценария>",
//                   "default"?:  true,       — цена направления, если ничего точнее не нашлось
//                   "words"?:    [варианты], — называют сам продукт («аудит директа»): выбирается всегда
//                   "match"?:    [варианты], — уточняют уже известное направление («вк» при таргете)
//                   "combines"?: ["id"] } ] — заменяет набор продуктов, если названы все (Яндекс + Google → SEO общее)
//
// Вариант — слова через пробел, каждое — начало слова: «реклам вк» найдёт «рекламу в ВК», «реклама во вк».
// Между словами допускаются окончания, дефис, точка и короткий предлог (в, на, для, по, через…).
// Слово из 1–3 букв ищется целиком («вк», «тг», «seo»), ё = е, регистр не важен.
// Можно писать регулярные выражения: «директ(?!ор)»; вариант в /косых/ — регулярка целиком.

import { existsSync, readFileSync } from 'node:fs';

export const rub = (v) => `${Math.round(v).toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`;

const norm = (t) => String(t ?? '').toLowerCase().replace(/ё/g, 'е');
const PREP = '(?:в|во|на|для|по|под|через|с|со|из|и|у|к|от|о|об|про)';
const SEP = `[\\s\\-–—.,:/+&«»"']*(?:${PREP}[\\s\\-]+)?`;
// Буквы — простым классом, а не \p{L}: словарь из сотен вариантов с Unicode-классами компилируется
// секунды. Текст перед поиском приводится к нижнему регистру, ё → е.
const L = 'a-zа-я';
const LETTER = `[${L}]`;
const WORD = `[${L}0-9]`;
const plain = (re) => re.replace(/\[\\p\{L\}\\p\{N\}\]/g, WORD).replace(/\[\\p\{L\}\]/g, LETTER).replace(/\\p\{L\}/g, LETTER).replace(/\\p\{N\}/g, '0-9');

function variantRe(v) {
  // без toLowerCase: в регулярках бывают \p{L}, \S — регистр и так не важен (флаг i)
  const s = String(v).replace(/ё/g, 'е').replace(/Ё/g, 'Е').trim();
  if (s.length > 2 && s.startsWith('/') && s.endsWith('/')) return plain(s.slice(1, -1));
  // «brand + performance»: знаки между словами и так допускаются — отдельным словом их не считаем
  const words = s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
    .map((w) => (/^[\p{L}\p{N}]{1,3}$/u.test(w) ? `${w}(?!${WORD})` : plain(w)));
  return `(?<!${WORD})${words.join(`${LETTER}*${SEP}`)}`;
}

/** Список вариантов → одна регулярка (или null). Ошибочный вариант пропускается, остальные работают. */
export function compileWords(list, log = console) {
  const arr = (Array.isArray(list) ? list : list ? [list] : []).filter((v) => typeof v === 'string' && v.trim());
  const ok = arr.map(variantRe).filter((re, i) => {
    try {
      new RegExp(re, 'i');
      return true;
    } catch {
      log.warn?.(`Прайс квалификатора: вариант «${arr[i]}» не разобран — пропущен`);
      return false;
    }
  });
  return ok.length ? new RegExp(ok.join('|'), 'i') : null;
}

export function loadPricing(file, log = console) {
  if (!existsSync(file)) return null;
  try {
    return createPricing(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    log.error?.({ err }, `Прайс квалификатора не прочитан: ${file}`);
    return null;
  }
}

export function createPricing(matrix) {
  // старый формат { services: { seo: { from } } } — по одному продукту на направление
  const legacy = Object.entries(matrix?.services ?? {})
    .filter(([, p]) => p && !Array.isArray(p) && typeof p === 'object')
    .map(([service, p]) => ({ id: service, name: p.name ?? service, service, default: true, ...p }));
  const serviceWords = Object.entries(matrix?.services ?? {})
    .filter(([, list]) => Array.isArray(list))
    .map(([service, list]) => ({ service, re: compileWords(list) }))
    .filter((x) => x.re);
  const products = [...(matrix?.products ?? []), ...legacy].map((p) => ({
    ...p,
    from: typeof p.from === 'number' && p.from > 0 ? p.from : null,
    words: compileWords(p.words),
    match: compileWords(p.match),
  }));

  /** Что клиент назвал сам: направления (общими словами или через продукт) и продукты. */
  function detect(text) {
    const t = norm(text);
    const named = products.filter((p) => p.words?.test(t));
    const services = new Set(serviceWords.filter((x) => x.re.test(t)).map((x) => x.service));
    for (const p of named) if (p.service) services.add(p.service);
    return { services: [...services], products: named.map((p) => p.id) };
  }

  /** Продукты прайса по направлениям и словам клиента. */
  function pick(services = [], text = '') {
    const list = [...new Set(services ?? [])];
    const t = norm(text);
    // названное прямо («реклама в телеге», «ведение группы вк») — точнее уточняющих слов: при рекламе
    // и SMM сразу «вк» из одной фразы не должно уточнять другое направление
    const chosen = products.filter((p) => p.words?.test(t));
    for (const s of list) {
      if (chosen.some((p) => p.service === s)) continue;
      const refined = products.filter((p) => p.service === s && p.match?.test(t));
      chosen.push(...(refined.length ? refined : products.filter((p) => p.service === s && p.default)));
    }
    // «SEO под Яндекс и Google»: Яндекс назван прямо, Google — уточнением; вместе это SEO общее
    const hit = (id) => {
      const p = products.find((x) => x.id === id);
      return chosen.includes(p) || (p && list.includes(p.service) && p.match?.test(t));
    };
    for (const c of products.filter((p) => p.combines?.length)) {
      if (!c.combines.every(hit)) continue;
      for (let i = chosen.length - 1; i >= 0; i--) if (c.combines.includes(chosen[i].id) || chosen[i] === c) chosen.splice(i, 1);
      chosen.push(c);
    }
    return [...new Set(chosen)];
  }

  // регулярки компилируются при первом поиске — делаем это при запуске, а не на первом посетителе
  detect('прогрев');

  return {
    detect,
    pick,
    /**
     * Предварительная стоимость по услугам и словам клиента или null, если цен нет.
     * total — «от 30 000 ₽»: самая низкая цена из сметы (с неё начинается работа), не сумма;
     * items — разбивка по продуктам (клиенту и менеджеру).
     */
    estimate(services, text = '') {
      const items = pick(services, text);
      const priced = items.filter((p) => p.from);
      if (!priced.length) return null;
      const unit = matrix?.unit ? ` ${matrix.unit}` : '';
      const total = `от ${rub(Math.min(...priced.map((p) => p.from)))}${unit}`;
      const line = (p) => `${p.name} — ${p.from ? `от ${rub(p.from)}` : p.note ?? 'индивидуально'}${p.from && p.note ? ` (${p.note})` : ''}`;
      return { total, items: items.map(line), ids: items.map((p) => p.id) };
    },
  };
}
