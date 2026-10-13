// Сборка презентации из JSON: npm run deck -- examples/decks/demo.json [--out out] [--formats pdf,pptx,html] [--force]
// Перед экспортом идёт проверка (содержание и вёрстка); с ошибками экспорт не выполняется без --force.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { loadBrand } from '../src/brand/index.js';
import { buildDeck, QaError, FORMATS } from '../src/docs/build.js';
import { closeBrowser } from '../src/docs/browser.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : def;
};
const input = args.find((a, i) => !a.startsWith('--') && !['--out', '--formats'].includes(args[i - 1]));
if (!input) {
  console.log('Использование: npm run deck -- файл.json [--out папка] [--formats pdf,pptx,html] [--force]');
  process.exit(1);
}

const deck = JSON.parse(await readFile(input, 'utf8'));
const out = resolve(opt('out', 'out'));
const formats = opt('formats', FORMATS.join(',')).split(',');
const name = basename(input, '.json');
const brand = loadBrand();

try {
  const { qa, files, manifest } = await buildDeck(deck, brand, { formats, force: args.includes('--force') });
  await mkdir(out, { recursive: true });
  for (const [ext, buf] of Object.entries(files)) await writeFile(join(out, `${name}.${ext}`), buf);
  await writeFile(join(out, `${name}.manifest.json`), JSON.stringify(manifest, null, 2));
  report(qa);
  console.log(`\nГотово: ${Object.keys(files).map((e) => join(out, `${name}.${e}`)).join(', ')}`);
} catch (err) {
  if (!(err instanceof QaError)) throw err;
  report(err.qa);
  console.error('\nЭкспорт остановлен: исправьте ошибки (или --force для черновика).');
  process.exitCode = 1;
} finally {
  await closeBrowser();
}

function report(qa) {
  console.log(`Проверка (${qa.brand}): ${qa.ok ? 'пройдена' : 'есть ошибки'}`);
  for (const e of qa.errors) console.log(`  ✗ ${e}`);
  for (const w of qa.warnings) console.log(`  ! ${w}`);
}
