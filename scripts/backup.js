// Резервная копия: npm run backup [-- --keep 14] [--no-check]
// База копируется без остановки сервера (VACUUM INTO), файлы (вложения, медиатека, выгрузки) — в зеркало,
// где копируются только новые. Потом сразу проверка: из копии можно восстановиться (см. src/ops/backup.js).

import { loadConfig } from '../src/config.js';
import { createBackup, checkBackup } from '../src/ops/backup.js';

const keepArg = process.argv.indexOf('--keep');
const keep = keepArg > -1 ? Number(process.argv[keepArg + 1]) : 14;
const { dbPath } = loadConfig();
const mb = (b) => `${(b / 1048576).toFixed(1)} МБ`;

const b = await createBackup({ dbPath, keep });
console.log(`Копия базы: ${b.path} (${mb(b.db.bytes)}, схема v${b.db.userVersion}, целостность: ${b.db.integrity})`);
console.log(`Файлы: всего ${b.files.total} (${mb(b.files.totalBytes)}), скопировано новых ${b.files.copied} (${mb(b.files.copiedBytes)})`);
if (b.removed) console.log(`Удалено старых копий базы: ${b.removed}`);

if (!process.argv.includes('--no-check')) {
  const c = await checkBackup({ dbPath });
  for (const w of c.warnings) console.log(`! ${w}`);
  for (const e of c.errors) console.log(`✗ ${e}`);
  console.log(c.ok ? `✓ Проверка восстановления пройдена за ${c.durationMs} мс` : '✗ Проверка восстановления НЕ пройдена');
  if (!c.ok) process.exitCode = 1;
}
