// Управление сотрудниками админки.
//   npm run admin -- list
//   npm run admin -- add anna@soroka-marketing.ru "Анна Иванова"           — вход только через Яндекс ID
//   npm run admin -- add anna@soroka-marketing.ru "Анна Иванова" --password — ещё и по паролю (спросит его)
//   npm run admin -- passwd anna@soroka-marketing.ru
//   npm run admin -- disable anna@soroka-marketing.ru   |   enable …

import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/storage/db.js';
import { createAuth } from '../src/admin/auth.js';

const [command, email, name] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const withPassword = process.argv.includes('--password');
const db = openDb(loadConfig().dbPath);
const auth = createAuth(db.raw);

async function askPassword() {
  if (!process.stdin.isTTY) {
    const generated = randomBytes(12).toString('base64url');
    console.log(`Сгенерирован пароль: ${generated}`);
    return generated;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question('Пароль (минимум 10 символов, пусто — сгенерировать): ');
  rl.close();
  if (password) return password;
  const generated = randomBytes(12).toString('base64url');
  console.log(`Сгенерирован пароль: ${generated}`);
  return generated;
}

try {
  switch (command) {
    case 'list':
      for (const u of auth.listUsers()) {
        const how = [u.has_yandex ? 'Яндекс' : null, u.has_password ? 'пароль' : null].filter(Boolean).join(' + ') || 'Яндекс (ещё не входил)';
        console.log(`${u.disabled ? '✗' : '✓'} ${u.email} — ${u.name} [${how}]`);
      }
      break;
    case 'add':
      if (!email) throw new Error('Укажите e-mail');
      auth.addUser(email, name ?? email, withPassword ? await askPassword() : null);
      console.log(`Добавлен ${email}. Вход: ${withPassword ? 'Яндекс ID или пароль' : 'через Яндекс ID с этой почтой'}`);
      break;
    case 'passwd':
      if (!email) throw new Error('Укажите e-mail');
      auth.setPassword(email, await askPassword());
      console.log('Пароль изменён, все сессии пользователя завершены');
      break;
    case 'disable':
    case 'enable':
      if (!email) throw new Error('Укажите e-mail');
      auth.setDisabled(email, command === 'disable');
      console.log(command === 'disable' ? 'Доступ закрыт' : 'Доступ открыт');
      break;
    default:
      console.log('Команды: list | add <email> [имя] [--password] | passwd <email> | disable <email> | enable <email>');
  }
} catch (err) {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
