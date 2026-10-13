// Управление сотрудниками админки из консоли (то же можно делать в разделе «Сотрудники»).
//   npm run admin -- list
//   npm run admin -- add anna "Анна Иванова"            — менеджер, пароль сгенерируется и покажется один раз
//   npm run admin -- add dmitry "Дмитрий" --admin        — администратор
//   npm run admin -- passwd anna                          — новый случайный пароль
//   npm run admin -- role anna admin|manager
//   npm run admin -- rename anna "Анна Петрова"          — имя, которое видно в админке
//   npm run admin -- disable anna   |   enable anna
// В Docker: docker compose exec app node scripts/admin.js list

import { loadConfig } from '../src/config.js';
import { openDb } from '../src/storage/db.js';
import { createAuth, generatePassword, ROLES } from '../src/admin/auth.js';

const args = process.argv.slice(2);
const [command, login, name] = args.filter((a) => !a.startsWith('--'));
const db = openDb(loadConfig().dbPath);
const auth = createAuth(db.raw);

const need = (v, what) => {
  if (!v) throw new Error(`Укажите ${what}`);
  return v;
};

try {
  switch (command) {
    case 'list':
      for (const u of auth.listUsers()) {
        console.log(`${u.disabled ? '✗' : '✓'} ${u.login} — ${u.name}, ${ROLES[u.role] ?? u.role}`);
      }
      break;
    case 'add': {
      const { user, password } = auth.addUser(need(login, 'логин'), name, { role: args.includes('--admin') ? 'admin' : 'manager' });
      console.log(`Добавлен: ${user.login} (${ROLES[user.role]})`);
      console.log(`Пароль: ${password}`);
      console.log('Пароль показывается один раз — передайте его сотруднику.');
      break;
    }
    case 'passwd': {
      const password = generatePassword();
      auth.setPasswordByLogin(need(login, 'логин'), password);
      console.log(`Новый пароль для ${login}: ${password}`);
      console.log('Все сессии сотрудника завершены.');
      break;
    }
    case 'role':
      auth.setRoleByLogin(need(login, 'логин'), need(name, 'роль: admin или manager'));
      console.log('Роль изменена');
      break;
    case 'rename':
      auth.setNameByLogin(need(login, 'логин'), need(name, 'новое имя в кавычках'));
      console.log(`Имя изменено: ${name}`);
      break;
    case 'disable':
    case 'enable':
      auth.setDisabledByLogin(need(login, 'логин'), command === 'disable');
      console.log(command === 'disable' ? 'Доступ закрыт' : 'Доступ открыт');
      break;
    default:
      console.log('Команды: list | add <логин> [имя] [--admin] | passwd <логин> | role <логин> admin|manager | rename <логин> "Имя" | disable <логин> | enable <логин>');
  }
} catch (err) {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
