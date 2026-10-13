// Фирменный стиль Soroka Marketing: загрузка и проверка brand/brand.config.json.
// Все документы, виджет и админка берут цвета, шрифты, сетку и логотип отсюда.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRAND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../brand');

const HEX = /^#[0-9A-F]{6}$/i;

export function loadBrand(dir = BRAND_DIR) {
  const config = JSON.parse(readFileSync(resolve(dir, 'brand.config.json'), 'utf8'));
  const problems = validateBrand(config, dir);
  if (problems.errors.length) throw new Error(`Брендовые настройки с ошибками:\n- ${problems.errors.join('\n- ')}`);

  const color = Object.fromEntries(Object.entries(config.color).map(([k, v]) => [k, v.value]));
  const logo = resolveLogo(config.logo, dir);

  return {
    ...config,
    dir,
    color,
    logo,
    logoConfig: config.logo,
    warnings: problems.warnings,
    /** Короткая подпись версии для манифестов и метаданных файлов. */
    label: `${config.brand} brand v${config.version} (${config.status === 'verified' ? 'утверждён' : 'предварительный'})`,
    fontFile: (name) => resolve(dir, 'fonts', name),
  };
}

export function validateBrand(config, dir = BRAND_DIR) {
  const errors = [];
  const warnings = [];
  for (const [name, token] of Object.entries(config.color ?? {})) {
    if (!HEX.test(token.value)) errors.push(`color.${name}: «${token.value}» — нужен HEX вида #RRGGBB`);
    if (token.status !== 'verified') warnings.push(`color.${name} — ${token.status}`);
  }
  for (const list of ['categorical', 'ordinal']) {
    for (const c of config.dataviz?.[list] ?? []) if (!HEX.test(c)) errors.push(`dataviz.${list}: «${c}» — нужен HEX`);
  }
  for (const role of ['heading', 'body']) {
    const t = config.typography?.[role];
    if (!t?.family) errors.push(`typography.${role}: не задан шрифт`);
    for (const f of t?.files ?? []) if (!existsSync(resolve(dir, 'fonts', f))) errors.push(`typography.${role}: нет файла brand/fonts/${f}`);
    if (t && t.status !== 'verified') warnings.push(`шрифт ${t.family} — ${t.status}`);
  }
  if (config.logo?.status !== 'verified') warnings.push('логотип не утверждён — используется текстовая подпись');
  if (contrast(config.color.ink.value, config.color.paper.value) < 7) errors.push('ink на paper — контраст ниже 7:1');
  if (contrast(config.color.steel.value, config.color.paper.value) < 4.5) errors.push('steel на paper — контраст ниже 4.5:1');
  return { errors, warnings };
}

/**
 * Логотип берётся только из утверждённых файлов и только если их хеш совпадает с записанным
 * в конфиге — подменённый или пережатый файл не попадёт в документы.
 */
function resolveLogo(logo, dir) {
  const result = { status: logo?.status ?? 'missing', onLight: null, onDark: null, problems: [] };
  for (const variant of ['onLight', 'onDark']) {
    const file = logo?.[variant];
    if (!file) continue;
    const path = resolve(dir, 'assets/logo', file);
    if (!existsSync(path)) {
      result.problems.push(`нет файла brand/assets/logo/${file}`);
      continue;
    }
    const data = readFileSync(path);
    const hash = createHash('sha256').update(data).digest('hex');
    if (logo.sha256?.[file] !== hash) {
      result.problems.push(`brand/assets/logo/${file}: хеш не совпадает с утверждённым — файл изменён`);
      continue;
    }
    const mime = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : null;
    if (!mime) {
      result.problems.push(`${file}: нужен SVG или PNG`);
      continue;
    }
    result[variant] = { file, path, mime, data, dataUri: `data:${mime};base64,${data.toString('base64')}`, sha256: hash };
  }
  if (result.status === 'verified' && !result.onLight) result.problems.push('логотип помечен verified, но файла onLight нет');
  return result;
}

// ---------- цвет ----------

function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст WCAG 2.x между двумя HEX-цветами. */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** CSS-переменные и @font-face для HTML-документов, виджета и админки. */
export function brandCss(brand, { fontUrl = (f) => `fonts/${f}` } = {}) {
  const faces = ['heading', 'body'].flatMap((role) => {
    const t = brand.typography[role];
    return t.files.map((f) => {
      const range = f.includes('cyrillic') ? 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116' : 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+20BD, U+2122, U+2212';
      return `@font-face { font-family: '${t.family}'; src: url('${fontUrl(f)}') format('woff2'); font-weight: 200 800; font-display: swap; unicode-range: ${range}; }`;
    });
  });
  const vars = [
    ...Object.entries(brand.color).map(([k, v]) => `  --soroka-${kebab(k)}: ${v};`),
    ...brand.dataviz.categorical.map((c, i) => `  --soroka-series-${i + 1}: ${c};`),
    ...brand.dataviz.ordinal.map((c, i) => `  --soroka-ordinal-${i + 1}: ${c};`),
    `  --soroka-context: ${brand.dataviz.context};`,
    `  --soroka-font-heading: '${brand.typography.heading.family}', ${brand.typography.heading.fallback};`,
    `  --soroka-font-body: '${brand.typography.body.family}', ${brand.typography.body.fallback};`,
  ];
  return `/* Сгенерировано из brand/brand.config.json (${brand.label}). Не редактировать вручную: npm run brand:sync */\n${faces.join('\n')}\n:root {\n${vars.join('\n')}\n}\n`;
}

const kebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
