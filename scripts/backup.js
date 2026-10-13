// Резервная копия базы: npm run backup [-- --keep 14]
// Копия делается без остановки сервера (VACUUM INTO), старые копии удаляются.

import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/storage/db.js';

const keepArg = process.argv.indexOf('--keep');
const keep = keepArg > -1 ? Number(process.argv[keepArg + 1]) : 14;
const { dbPath } = loadConfig();
const dir = join(dirname(dbPath), 'backups');
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
const target = join(dir, `kvalificator-${stamp}.db`);
const db = openDb(dbPath);
db.raw.prepare('VACUUM INTO ?').run(target);
db.close();
console.log(`Копия сохранена: ${target}`);

const old = readdirSync(dir).filter((f) => /^kvalificator-.*\.db$/.test(f)).sort().slice(0, -keep);
for (const f of old) unlinkSync(join(dir, f));
if (old.length) console.log(`Удалено старых копий: ${old.length}`);
