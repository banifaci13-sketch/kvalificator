// Применяет brand/brand.config.json ко всей системе: npm run brand:sync
//  - brand/brand.css и admin/brand/ (CSS-переменные + шрифты для админки)
//  - значения по умолчанию в виджете (между маркерами brand:start / brand:end)
//  - подсказывает sha256 для новых файлов логотипа в brand/assets/logo/
// С флагом --check ничего не пишет, а падает, если сгенерированные файлы устарели (для CI и тестов).

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadBrand, brandCss, BRAND_DIR } from '../src/brand/index.js';

const ROOT = resolve(BRAND_DIR, '..');
const check = process.argv.includes('--check');
const brand = loadBrand();
let stale = 0;

function write(path, content) {
  const binary = Buffer.isBuffer(content);
  const current = existsSync(path) ? readFileSync(path, binary ? undefined : 'utf8') : null;
  if (binary ? current?.equals(content) : current === content) return;
  stale++;
  if (check) return console.log(`устарел: ${path.replace(`${ROOT}/`, '')}`);
  writeFileSync(path, content);
  console.log(`обновлён: ${path.replace(`${ROOT}/`, '')}`);
}

// 1. CSS бренда
const css = brandCss(brand);
write(resolve(BRAND_DIR, 'brand.css'), css);

// 2. Админка: свой экземпляр CSS и шрифтов (раздаётся из /admin/brand/)
const adminBrand = resolve(ROOT, 'admin/brand');
if (!check) mkdirSync(resolve(adminBrand, 'fonts'), { recursive: true });
write(resolve(adminBrand, 'brand.css'), css);
if (!check) {
  for (const role of ['heading', 'body']) {
    for (const f of brand.typography[role].files) copyFileSync(brand.fontFile(f), resolve(adminBrand, 'fonts', f));
  }
}
// логотип для тёмной боковой панели и экрана входа — только утверждённый файл
if (brand.logo.onDark?.mime === 'image/png') write(resolve(adminBrand, 'logo.png'), brand.logo.onDark.data);

// 3. Виджет: значения по умолчанию
const widgetPath = resolve(ROOT, 'widget/widget.js');
const widget = readFileSync(widgetPath, 'utf8');
const defaults = [
  '  // brand:start — сгенерировано npm run brand:sync из brand/brand.config.json',
  `  var BRAND = ${JSON.stringify({
    color: brand.color.ink,
    accent: brand.color.accent,
    accentText: brand.color.accentText,
    onAccent: brand.color.ink,
    title: brand.voice.name_en,
  })};`,
  '  // brand:end',
].join('\n');
const patched = widget.replace(/ {2}\/\/ brand:start[\s\S]*?\/\/ brand:end/, defaults);
if (patched === widget && !widget.includes('// brand:start')) throw new Error('В widget.js нет маркеров brand:start / brand:end');
write(widgetPath, patched);

// 4. Логотипы: подсказка по хешам
const logoDir = resolve(BRAND_DIR, 'assets/logo');
const files = existsSync(logoDir) ? readdirSync(logoDir).filter((f) => /\.(svg|png)$/i.test(f)) : [];
for (const f of files) {
  const hash = createHash('sha256').update(readFileSync(resolve(logoDir, f))).digest('hex');
  if (brand.logo.problems.length || brand.logoConfig?.sha256?.[f] !== hash) {
    console.log(`логотип ${f}: sha256 ${hash} — после проверки внесите в brand.config.json → logo.sha256`);
  }
}
for (const p of brand.logo.problems) console.log(`! ${p}`);
for (const w of brand.warnings) console.log(`· ${w}`);

if (check && stale) {
  console.error(`\nФайлы бренда устарели (${stale}). Выполните npm run brand:sync`);
  process.exit(1);
}
console.log(`\n${brand.label}${stale ? '' : ' — всё актуально'}`);
