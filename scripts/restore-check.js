// Проверка восстановления из резервной копии: npm run restore-check [-- путь/к/копии.db]
// Копия открывается во временной папке (рабочая база не трогается): контрольная сумма, целостность,
// открывается ли текущей версией, все ли файлы на месте. Итог — на странице «Сотрудники» → «Состояние».

import { loadConfig } from '../src/config.js';
import { checkBackup } from '../src/ops/backup.js';

const file = process.argv.slice(2).find((a) => a.endsWith('.db')) ?? null;
const { dbPath } = loadConfig();
const c = await checkBackup({ dbPath, file });
console.log(`Копия: ${c.backup ?? '—'}${c.userVersion != null ? `, схема v${c.userVersion}` : ''}`);
if (c.counts && Object.keys(c.counts).length) console.log(`Записей: ${Object.entries(c.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
for (const w of c.warnings) console.log(`! ${w}`);
for (const e of c.errors) console.log(`✗ ${e}`);
console.log(c.ok ? '✓ Из копии можно восстановиться' : '✗ Проверка не пройдена');
process.exitCode = c.ok ? 0 : 1;
