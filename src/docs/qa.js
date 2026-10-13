// Проверка презентации перед экспортом. Ошибки блокируют экспорт, предупреждения — нет.
//  1) Содержание: обязательные поля, незаполненные переменные, источник и статус у цифр, данные графиков.
//  2) Вёрстка (в Chromium): текст помещается (с запасом под шрифты PowerPoint), поля, минимальный
//     кегль, контраст, иерархия, наложения, изображения, логотип.

import { SLIDE_TYPES } from './templates.js';
import { renderDeckHtml } from './render-html.js';
import { withPage } from './browser.js';
import { FIGURE_STYLES } from './layout.js';

const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\[заполнить[^\]]*\]|lorem ipsum|TODO/i;
const LIMITS = { title: 90, subtitle: 160, takeaway: 140 };

export function checkContent(deck, brand) {
  const errors = [];
  const warnings = [];
  const at = (i, msg) => `Слайд ${i + 1}: ${msg}`;

  if (!deck?.slides?.length) errors.push('В презентации нет слайдов');
  if (brand.status !== 'verified') warnings.push(`Фирменный стиль ${brand.version} предварительный: цвета и шрифты ещё не утверждены`);
  if (!brand.logo.onLight) warnings.push('Оригинальный логотип не загружен — вместо него текстовая подпись SOROKA MARKETING');
  for (const p of brand.logo.problems) errors.push(`Логотип: ${p}`);

  (deck?.slides ?? []).forEach((s, i) => {
    const type = SLIDE_TYPES[s.type];
    if (!type) return errors.push(at(i, `неизвестный тип «${s.type}»`));
    for (const f of type.required) {
      const v = s[f];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) errors.push(at(i, `не заполнено «${fieldLabel(f)}»`));
    }
    walkStrings(s, (str, path) => {
      if (PLACEHOLDER_RE.test(str)) errors.push(at(i, `осталась заготовка «${str.match(PLACEHOLDER_RE)[0]}» (${path})`));
    });
    for (const [f, max] of Object.entries(LIMITS)) {
      if (typeof s[f] === 'string' && s[f].length > max) warnings.push(at(i, `«${fieldLabel(f)}» длиннее ${max} символов — один слайд, одна мысль`));
    }
    if (type.data && s.source && /^(источник|нет|-|—)$/i.test(s.source.trim())) errors.push(at(i, 'источник данных указан формально'));
    if (s.type === 'case' && s.verified !== true) errors.push(at(i, 'кейс не подтверждён: отметьте «Проверено», только реальные кейсы с согласия клиента'));
    if (s.chart) checkChart(s.chart, (m) => errors.push(at(i, m)));
    if (s.type === 'mediaplan' && s.dataStatus === 'fact') warnings.push(at(i, 'медиаплан помечен как «Факт» — обычно это прогноз'));
    if (s.type === 'kpi' && s.kpis?.length > 4) warnings.push(at(i, 'больше 4 KPI — лишние не поместятся'));
  });
  return { errors, warnings };
}

function checkChart(chart, fail) {
  if (!Array.isArray(chart.categories) || !chart.categories.length) return fail('у графика нет категорий');
  if (!Array.isArray(chart.series) || !chart.series.length) return fail('у графика нет рядов данных');
  for (const s of chart.series) {
    if (s.values?.length !== chart.categories.length) fail(`ряд «${s.name}»: значений ${s.values?.length ?? 0}, категорий ${chart.categories.length}`);
    if (s.values?.some((v) => typeof v !== 'number' || !Number.isFinite(v))) fail(`ряд «${s.name}»: значения должны быть числами`);
  }
  if (chart.series.length > 4) fail('больше 4 рядов на графике — разделите на несколько');
}

function walkStrings(obj, fn, path = '') {
  if (typeof obj === 'string') return fn(obj, path);
  if (Array.isArray(obj)) return obj.forEach((v, i) => walkStrings(v, fn, `${path}[${i}]`));
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) walkStrings(v, fn, path ? `${path}.${k}` : k);
}

const FIELD_LABELS = {
  title: 'Заголовок', subtitle: 'Подзаголовок', kpis: 'Показатели', source: 'Источник', dataStatus: 'Статус данных',
  chart: 'График', takeaway: 'Главный вывод', insights: 'Выводы', client: 'Клиент', task: 'Задача', solution: 'Что сделали',
  results: 'Результаты', pillars: 'Направления', rows: 'Строки медиаплана', items: 'Состав работ',
};
export const fieldLabel = (f) => FIELD_LABELS[f] ?? f;

/** Проверки вёрстки в браузере. Возвращает { errors, warnings, slides: [{ index, issues }] }. */
export async function checkLayout(deck, brand) {
  const html = renderDeckHtml(deck, brand, { mode: 'qa' });
  const t = brand.typography.slideScalePx;
  const params = { minFont: t.minimum, margin: brand.slide.margin, W: brand.slide.width, H: brand.slide.height, logoMin: brand.logoConfig?.minHeightPx ?? 24, figureStyles: [...FIGURE_STYLES] };

  const found = await withPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return page.evaluate(runChecks, params);
  });

  const errors = [];
  const warnings = [];
  for (const f of found) (f.level === 'error' ? errors : warnings).push(`Слайд ${f.slide + 1}: ${f.message}`);
  return { errors, warnings };
}

/* Выполняется в браузере. */
function runChecks({ minFont, margin, W, H, logoMin, figureStyles }) {
  const out = [];
  const push = (slide, level, message) => out.push({ slide, level, message });

  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x));
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const snippet = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);

  document.querySelectorAll('.slide').forEach((slideEl) => {
    const i = Number(slideEl.dataset.index);
    const sr = slideEl.getBoundingClientRect();
    const texts = [...slideEl.querySelectorAll('[data-fit]')];
    let titleSize = 0;
    let maxBody = 0;

    for (const el of texts) {
      const name = el.dataset.name;
      const inner = el.firstElementChild;
      // 1. Переполнение и запас ~4% под метрики шрифтов в PowerPoint
      if (inner.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) {
        push(i, 'error', `текст не помещается в блок «${name}»: «${snippet(el)}…» — сократите текст`);
      } else if (!el.dataset.chrome) {
        const size = parseFloat(getComputedStyle(el).fontSize);
        el.style.fontSize = `${size * 1.04}px`;
        if (inner.scrollHeight > el.clientHeight + 1) push(i, 'warning', `блок «${name}» заполнен впритык — в PowerPoint текст может не поместиться`);
        el.style.fontSize = '';
      }
      // 2. Минимальный кегль
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < minFont - 0.5) push(i, 'error', `кегль ${fs}px в «${name}» меньше минимума ${minFont}px`);
      if (name === 'title') titleSize = fs;
      else if (!el.dataset.chrome && el.dataset.el !== 'wordmark' && !figureStyles.some((st) => el.classList.contains(`t-${st}`))) maxBody = Math.max(maxBody, fs);

      // 3. Поля: текст внутри безопасной зоны
      const r = el.getBoundingClientRect();
      const x = r.left - sr.left;
      const y = r.top - sr.top;
      if (x < margin - 1 || x + r.width > W - margin + 1 || y < 40 || y + r.height > H - 24) {
        push(i, 'error', `блок «${name}» выходит за поля слайда`);
      }

      // 4. Контраст: цвет текста против того, что под ним (подложка или фон слайда)
      const fg = parse(getComputedStyle(el).color);
      const cx = r.left + Math.min(20, r.width / 2);
      const cy = r.top + Math.min(20, r.height / 2);
      let bg = null;
      for (const under of document.elementsFromPoint(cx, cy)) {
        if (under === el || el.contains(under)) continue;
        const c = parse(getComputedStyle(under).backgroundColor);
        if (c && c.a > 0.5) { bg = c; break; }
      }
      if (fg && bg) {
        const large = fs >= 24 || (fs >= 18.66 && parseInt(getComputedStyle(el).fontWeight, 10) >= 700);
        const need = large ? 3 : 4.5;
        const cr = ratio(fg, bg);
        if (cr < need) push(i, 'error', `низкий контраст в «${name}»: ${cr.toFixed(2)}:1 (нужно ${need}:1)`);
      }
    }

    // 5. Иерархия: заголовок заметно крупнее текста
    if (titleSize && maxBody && titleSize < maxBody * 1.5) push(i, 'warning', `заголовок (${titleSize}px) почти не отличается от текста (${maxBody}px)`);

    // 6. Наложения текстовых блоков
    const boxes = texts.filter((el) => !el.dataset.chrome).map((el) => ({ el, r: el.getBoundingClientRect() }));
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const p = boxes[a].r;
        const q = boxes[b].r;
        const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (w > 2 && h > 2) push(i, 'error', `блоки «${boxes[a].el.dataset.name}» и «${boxes[b].el.dataset.name}» наезжают друг на друга`);
      }
    }

    // 7. Изображения и логотип: загружены, не растянуты, пропорции сохранены
    for (const img of slideEl.querySelectorAll('img')) {
      if (!img.complete || !img.naturalWidth) {
        push(i, 'error', `изображение «${img.dataset.name}» не загрузилось`);
        continue;
      }
      const r = img.getBoundingClientRect();
      const natural = img.naturalWidth / img.naturalHeight;
      if (Math.abs(r.width / r.height - natural) / natural > 0.01) push(i, 'error', `пропорции «${img.dataset.name}» искажены`);
      if (!img.src.startsWith('data:image/svg') && img.naturalWidth < r.width) push(i, 'warning', `изображение «${img.dataset.name}» растянуто — будет нечётким`);
      if (img.classList.contains('logo') && r.height < logoMin) push(i, 'error', `логотип меньше минимальной высоты ${logoMin}px`);
    }
  });
  return out;
}

/** Полная проверка: содержание, затем вёрстка (если содержание без ошибок блокирующих рендер). */
export async function runQa(deck, brand) {
  const content = checkContent(deck, brand);
  const renderable = !content.errors.some((e) => /неизвестный тип|нет слайдов|у графика/.test(e));
  const layout = renderable ? await checkLayout(deck, brand) : { errors: [], warnings: [] };
  return {
    ok: !content.errors.length && !layout.errors.length,
    errors: [...content.errors, ...layout.errors],
    warnings: [...content.warnings, ...layout.warnings],
    checkedAt: new Date().toISOString(),
    brand: brand.label,
  };
}
