// Подготовка текста клиента к распознаванию услуг (правилами и словарём прайса).
//
// Клиенты пишут как придётся: «кантекстная», «дирекд», «таргед», «lbhtrn» (директ в английской
// раскладке), «ыущ» (seo в русской), «кoнтекст» с латинской «o», «реклама в яндексе и вк».
// Здесь текст приводится к виду, который понимает словарь, а фразы с отказом
// («директ не нужен», «без SEO», «кроме SMM») из поиска услуг убираются.
//
// Исправленные слова не заменяют исходные, а дописываются в конец текста: словарь находит и то и другое.

const norm = (t) => String(t ?? '').toLowerCase().replace(/ё/g, 'е');

// ---------- раскладка ----------

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const EN_RU = new Map([...EN].map((c, i) => [c, RU[i]]));
const RU_EN = new Map([...RU].map((c, i) => [c, EN[i]]));
// английские слова, которые набирают в русской раскладке («ыущ» → seo)
const EN_TERMS = new Set(['seo', 'smm', 'geo', 'ppc', 'crm', 'serm', 'ugc', 'aso', 'gtm', 'utm', 'ads', 'direct', 'target', 'google', 'yandex',
  'ozon', 'tiktok', 'telegram', 'instagram', 'landing', 'tilda', 'roistat', 'calltouch', 'wildberries', 'mytarget', 'adwords', 'analytics']);

/** «lbhtrn» → «директ», «ыущ» → «seo»; слова, которые и так понятны, не трогаем. */
export function layoutFixes(text) {
  const out = [];
  for (const w of norm(text).match(/[a-z[\];',.`]{4,}|[а-я]{3,}/g) ?? []) {
    if (/^[a-z]/.test(w)) {
      // латиница длиной от 4 букв без гласных подряд как в английском — скорее всего, русская раскладка
      if (EN_TERMS.has(w)) continue;
      const ru = [...w].map((c) => EN_RU.get(c) ?? c).join('');
      if (/^[а-я]+$/.test(ru)) out.push(ru);
    } else {
      const en = [...w].map((c) => RU_EN.get(c) ?? c).join('');
      if (EN_TERMS.has(en)) out.push(en);
    }
  }
  return out;
}

// ---------- латинские буквы внутри русских слов ----------

const HOMO = { a: 'а', c: 'с', e: 'е', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', h: 'н', b: 'в' };
/** «кoнтекст» с латинской «o» → «контекст». Только в словах, где есть и русские буквы. */
export const fixMixedScript = (text) =>
  String(text ?? '').replace(/[\p{L}]+/gu, (w) => (/[а-яё]/i.test(w) && /[a-z]/i.test(w) ? w.replace(/[acekmoptxyhb]/gi, (c) => HOMO[c.toLowerCase()] ?? c) : w));

// ---------- опечатки ----------

// ключевые слова услуг: слово с одной опечаткой (пропуск, лишняя или заменённая буква, перестановка) —
// то же слово. Короткие слова (сайт, сео, вк) так не исправляем: слишком много совпадений.
const STEMS = ['контекстн', 'контекст', 'директ', 'таргет', 'таргетолог', 'таргетинг', 'лендинг', 'маркетплейс', 'вайлдберриз', 'валберис',
  'инстаграм', 'телеграм', 'вконтакте', 'тикток', 'сеошник', 'сммщик', 'коллтрекинг', 'комплексн', 'аналитик', 'метрик', 'одностраничн',
  'продвижени', 'раскрутк', 'соцсет', 'медийн', 'брендформанс'];
// похожие настоящие слова — не опечатки
const NOT_TYPO = /^(?:дирекц|директор|директив|индекс|контакт|конкурс|метрическ|тарелк|продавц)/;

function dist1(a, b) {
  // расстояние Дамерау — Левенштейна не больше 1
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** «кантекстная» → «контекстная», «дирекд» → «директ», «таргит» → «таргет». */
export function typoFixes(text) {
  const out = [];
  for (const w of norm(text).match(/[а-я]{5,}/g) ?? []) {
    if (NOT_TYPO.test(w) || STEMS.some((s) => w.startsWith(s))) continue;
    for (const s of STEMS) {
      if (s.length < 6) continue;
      // начало слова (основа ± буква) с одной опечаткой, остаток — окончание до 4 букв
      const hit = [s.length, s.length + 1, s.length - 1].find((n) => n <= w.length && w.length - n <= 4 && dist1(w.slice(0, n), s));
      if (hit) {
        out.push(s + w.slice(hit));
        break;
      }
    }
  }
  return out;
}

// ---------- «реклама в яндексе и вк» ----------

const HEADS = 'реклам|продвижени|продвига|ведени|вести|таргет|настройк|настроить|запуск|запустить|раскрутк';
const COORD_RE = new RegExp(`((?:${HEADS})[а-я]*)\\s+(?:в|во|на)\\s+([^.;!?\\n]+)`, 'g');
const COORD_SEP = /\s*(?:,|\+|\/|&|(?:^|\s)(?:и|или|а также|плюс)(?=\s))\s*/;
/** «реклама в яндексе и вк» → ещё «реклама в вк»: общее слово относится к каждому из перечисленных. */
export function coordFixes(text) {
  const out = [];
  for (const m of norm(text).matchAll(COORD_RE)) {
    for (const item of m[2].split(COORD_SEP).slice(1, 5)) {
      const words = item.replace(/^(?:в|во|на)\s+/, '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
      if (words) out.push(`${m[1]} в ${words}`);
    }
  }
  return out;
}

// ---------- отказы ----------

// «не нужен», «не интересует», «уже есть», «делаем сами» — услуга в этой части фразы не заказ
const NEG_CLAUSE = /(?:^|[^а-я])(?:не\s+(?:очень\s+|особо\s+|сильно\s+|сейчас\s+|пока\s+)?(?:нуж[енао]|надо|интерес|требу|рассматрива|хотим|хочу|планиру|актуальн|подход|нуждаемся|в\s+приоритет|обязательн|будем|заказыва)|ненуж[енао]|отказ(?:ались|ываемся|аться)|уже\s+(?:есть|ведем|ведется|настроен|работает|запущен|делаем)|(?:делаем|ведем|ведут)\s+сами|своими\s+силами|сами\s+(?:ведем|делаем|справляемся))/;
// «без SEO», «кроме SMM», «за исключением таргета» — следующие слова не заказ;
// но «кроме директа нужен ещё таргет» — это «и то и другое»
const EXCEPT_RE = /(^|[^а-я])(?:без|кроме|за\s+исключением|исключая)\s+[^\s,.;:!?]+(?:\s+(?:и|или)\s+[^\s,.;:!?]+)?/g;
const ALSO_RE = /(?:^|[^а-я])(?:еще|также|тоже|плюс|и\s+еще|в\s+том\s+числе)(?:[^а-я]|$)/;

/** Части фразы, где клиент от услуги отказывается, — убираем; остальное оставляем как есть. */
export function dropNegated(text) {
  return norm(text)
    .split(/(?<=[.!?;:])\s+|\n+|\s*,\s*|\s+(?=(?:но|а|однако|зато|только)\s)/)
    .filter((part) => !NEG_CLAUSE.test(part))
    .map((part) => (ALSO_RE.test(part) ? part : part.replace(EXCEPT_RE, '$1')))
    .join(' , ');
}

/**
 * Текст для поиска услуг: без отказов, плюс исправленные раскладка, опечатки и перечисления.
 * Используется и правилами, и словарём прайса — оба видят одно и то же.
 */
export function recognitionText(text) {
  const clean = dropNegated(fixMixedScript(text));
  const extra = [...layoutFixes(clean), ...typoFixes(clean)];
  const withExtra = extra.length ? `${clean}\n${extra.join(' , ')}` : clean;
  const coord = coordFixes(withExtra);
  return coord.length ? `${withExtra}\n${coord.join(' , ')}` : withExtra;
}
