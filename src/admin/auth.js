// Сотрудники агентства и их сессии в админке.
// Логин — латиница, цифры или e-mail; пароли — scrypt с солью; в базе хранится только хеш токена сессии.
// Роли: admin — управляет сотрудниками; manager — работает с лидами.

import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { readPrefs } from './prefs.js';
import { imageInfo } from '../docs/media.js';

export const AVATAR_MAX = 512 * 1024;

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MIN_PASSWORD = 10;
const LOGIN_RE = /^[a-z0-9][a-z0-9._@+-]{2,63}$/;
export const ROLES = { admin: 'Администратор', manager: 'Менеджер' };

export class AuthError extends Error {}

export function hashPassword(password) {
  if (String(password).length < MIN_PASSWORD) throw new AuthError(`Пароль — минимум ${MIN_PASSWORD} символов`);
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [kind, N, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// Без похожих символов (0/O, 1/l/I), чтобы пароль было легко передать сотруднику
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 14 символов из 56 — около 81 бита энтропии. */
export function generatePassword(length = 14) {
  return Array.from({ length }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');
}

export function normalizeLogin(login) {
  const value = String(login ?? '').trim().toLowerCase();
  if (!LOGIN_RE.test(value)) throw new AuthError('Логин — от 3 до 64 символов: латиница, цифры, точка, дефис, @');
  return value;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Хеш-заглушка, чтобы вход несуществующего пользователя занимал столько же времени
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

const publicUser = (u) =>
  u && {
    id: u.id,
    login: u.email,
    name: u.name,
    position: u.position ?? null,
    phone: u.phone ?? null,
    telegram: Boolean(u.telegram_chat_id),
    role: u.role,
    disabled: Boolean(u.disabled),
    created_at: u.created_at,
    hasPassword: Boolean(u.password_hash),
    hasYandex: Boolean(u.yandex_id),
    prefs: readPrefs(u.prefs),
    avatar: u.avatar_ver ?? null,
  };

export function createAuth(db) {
  // В базе колонка называется email: логином может быть и почта, и короткое имя
  const q = {
    userByLogin: db.prepare('SELECT * FROM admin_users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM admin_users WHERE id = ?'),
    setPrefs: db.prepare('UPDATE admin_users SET prefs = ? WHERE id = ?'),
    setAvatar: db.prepare("INSERT INTO user_avatars (user_id, mime, data) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = datetime('now')"),
    getAvatar: db.prepare('SELECT mime, data FROM user_avatars WHERE user_id = ?'),
    removeAvatar: db.prepare('DELETE FROM user_avatars WHERE user_id = ?'),
    avatarVer: db.prepare('UPDATE admin_users SET avatar_ver = ? WHERE id = ?'),
    avatars: db.prepare('SELECT id, avatar_ver FROM admin_users WHERE avatar_ver IS NOT NULL'),
    listUsers: db.prepare('SELECT * FROM admin_users ORDER BY disabled, id'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM admin_users'),
    countAdmins: db.prepare("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'admin' AND disabled = 0"),
    insertUser: db.prepare('INSERT INTO admin_users (email, name, password_hash, yandex_id, role) VALUES (?, ?, ?, ?, ?)'),
    userByYandex: db.prepare('SELECT * FROM admin_users WHERE yandex_id = ?'),
    linkYandex: db.prepare('UPDATE admin_users SET yandex_id = ?, name = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?'),
    setDisabled: db.prepare('UPDATE admin_users SET disabled = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE admin_users SET role = ? WHERE id = ?'),
    setName: db.prepare('UPDATE admin_users SET name = ? WHERE id = ?'),
    setLogin: db.prepare('UPDATE admin_users SET email = ? WHERE id = ?'),
    setProfile: db.prepare('UPDATE admin_users SET position = ?, phone = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM admin_users WHERE id = ?'),
    insertSession: db.prepare(
      `INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`,
    ),
    sessionUser: db.prepare(
      `SELECT u.* FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.disabled = 0`,
    ),
    deleteSession: db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM admin_sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?'),
    purgeExpired: db.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')"),
  };

  function startSession(userId) {
    q.purgeExpired.run();
    const token = randomBytes(32).toString('base64url');
    q.insertSession.run(sha256(token), userId);
    return token;
  }

  function mustGet(id) {
    const user = q.userById.get(id);
    if (!user) throw new AuthError('Сотрудник не найден');
    return user;
  }

  function byLogin(login) {
    const user = q.userByLogin.get(normalizeLogin(login));
    if (!user) throw new AuthError('Сотрудник не найден');
    return user;
  }

  /** Нельзя оставить систему без активного администратора. */
  function assertKeepsAdmin(user, change) {
    const losesAdmin = user.role === 'admin' && !user.disabled && (change.role === 'manager' || change.disabled === true);
    if (losesAdmin && q.countAdmins.get().n <= 1) throw new AuthError('Нужен хотя бы один активный администратор');
  }

  return {
    sessionDays: SESSION_DAYS,
    hasUsers: () => q.countUsers.get().n > 0,
    listUsers: () => q.listUsers.all().map(publicUser),
    getUser: (id) => publicUser(q.userById.get(id)),

    /**
     * Новый сотрудник. password: строка — задать; true — сгенерировать; null — без пароля (только Яндекс ID).
     * Возвращает { user, password } — сгенерированный пароль показывается один раз.
     */
    addUser(login, name, { password = true, role = 'manager' } = {}) {
      const value = normalizeLogin(login);
      if (!(role in ROLES)) throw new AuthError('Неизвестная роль');
      if (q.userByLogin.get(value)) throw new AuthError('Такой логин уже есть');
      const plain = password === true ? generatePassword() : password;
      const { lastInsertRowid } = q.insertUser.run(
        value,
        String(name ?? '').trim().slice(0, 100) || value,
        plain ? hashPassword(plain) : null,
        null,
        role,
      );
      return { user: publicUser(q.userById.get(lastInsertRowid)), password: plain || null };
    },

    /** Новый случайный пароль; все сессии сотрудника завершаются. */
    resetPassword(id) {
      mustGet(id);
      const password = generatePassword();
      q.setPassword.run(hashPassword(password), id);
      q.deleteUserSessions.run(id);
      return password;
    },

    /** Смена своего пароля: остальные устройства выходят, текущая сессия остаётся. */
    changeOwnPassword(id, current, next, currentToken) {
      const user = mustGet(id);
      if (user.password_hash && !verifyPassword(current, user.password_hash)) throw new AuthError('Текущий пароль неверный');
      q.setPassword.run(hashPassword(next), id);
      q.deleteOtherSessions.run(id, sha256(currentToken ?? ''));
    },

    updateUser(id, change) {
      const user = mustGet(id);
      assertKeepsAdmin(user, change);
      if (change.role !== undefined) {
        if (!(change.role in ROLES)) throw new AuthError('Неизвестная роль');
        q.setRole.run(change.role, id);
      }
      if (change.name !== undefined) q.setName.run(String(change.name).trim().slice(0, 100) || user.email, id);
      if (change.login !== undefined) {
        const login = normalizeLogin(change.login);
        const other = q.userByLogin.get(login);
        if (other && other.id !== user.id) throw new AuthError('Такой логин уже есть');
        // со сменой логина пароль прежний, сессии остаются
        q.setLogin.run(login, id);
      }
      if (change.position !== undefined || change.phone !== undefined) {
        const clean = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
        q.setProfile.run(
          change.position !== undefined ? clean(change.position, 100) : user.position,
          change.phone !== undefined ? clean(change.phone, 40) : user.phone,
          id,
        );
      }
      if (change.disabled !== undefined) {
        q.setDisabled.run(change.disabled ? 1 : 0, id);
        if (change.disabled) q.deleteUserSessions.run(id);
      }
      return publicUser(q.userById.get(id));
    },

    /** Личные настройки внешнего вида: изменение поверх сохранённых (patch уже проверен). */
    /** Фото профиля: JPEG или PNG до 512 КБ (браузер заранее обрезает до квадрата 256×256). */
    setAvatar(id, buf) {
      mustGet(id);
      const info = imageInfo(buf);
      if (!info || !info.width || !info.height) throw new AuthError('Нужна картинка JPG или PNG');
      if (buf.length > AVATAR_MAX) throw new AuthError('Фото больше 512 КБ — уменьшите его');
      if (info.width > 1024 || info.height > 1024) throw new AuthError('Фото больше 1024×1024 — уменьшите его');
      q.setAvatar.run(id, info.mime, buf);
      const ver = Date.now();
      q.avatarVer.run(ver, id);
      return ver;
    },
    removeAvatar(id) {
      q.removeAvatar.run(id);
      q.avatarVer.run(null, id);
    },
    getAvatar: (id) => q.getAvatar.get(Number(id)) ?? null,
    /** { id: версия } — у кого из сотрудников есть фото. */
    avatars: () => Object.fromEntries(q.avatars.all().map((r) => [r.id, r.avatar_ver])),

    setPrefs(id, patch) {
      const user = mustGet(id);
      const next = { ...readPrefs(user.prefs), ...patch };
      q.setPrefs.run(JSON.stringify(next), id);
      return readPrefs(JSON.stringify(next));
    },

    /** Удалить можно только отключённого сотрудника, за которым ничего не числится. */
    deleteUser(id, actorId) {
      const user = mustGet(id);
      if (user.id === actorId) throw new AuthError('Себя удалить нельзя');
      if (!user.disabled) throw new AuthError('Сначала отключите сотрудника');
      try {
        db.exec('BEGIN');
        q.deleteUserSessions.run(id);
        q.deleteUser.run(id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        if (/FOREIGN KEY/i.test(err.message)) {
          throw new AuthError('За сотрудником числятся задачи, встречи или клиенты — оставьте его отключённым, чтобы не потерять историю');
        }
        throw err;
      }
    },

    // Для консольной команды scripts/admin.js
    setPasswordByLogin(login, password) {
      const user = byLogin(login);
      q.setPassword.run(hashPassword(password), user.id);
      q.deleteUserSessions.run(user.id);
    },
    setNameByLogin(login, name) {
      const user = byLogin(login);
      const value = String(name ?? '').trim().slice(0, 100);
      if (!value) throw new AuthError('Укажите имя');
      q.setName.run(value, user.id);
    },
    setDisabledByLogin(login, disabled) {
      const user = byLogin(login);
      assertKeepsAdmin(user, { disabled });
      q.setDisabled.run(disabled ? 1 : 0, user.id);
      if (disabled) q.deleteUserSessions.run(user.id);
    },
    setRoleByLogin(login, role) {
      const user = byLogin(login);
      if (!(role in ROLES)) throw new AuthError('Неизвестная роль');
      assertKeepsAdmin(user, { role });
      q.setRole.run(role, user.id);
    },

    /** Возвращает токен сессии или null. */
    login(login, password) {
      const user = q.userByLogin.get(String(login ?? '').trim().toLowerCase());
      const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok || user.disabled) return null;
      return startSession(user.id);
    },

    /**
     * Вход через Яндекс ID (если настроен). Пускаем, если почта сотрудника заведена логином
     * или её домен в allowedDomains (тогда учётная запись создаётся автоматически).
     */
    loginWithYandex(profile, { allowedDomains = [] } = {}) {
      const emails = [profile.default_email, ...(profile.emails ?? [])].filter(Boolean).map((e) => e.toLowerCase());
      const name = profile.real_name || profile.display_name || profile.login || emails[0];
      let user = q.userByYandex.get(String(profile.id));
      if (!user) {
        user = emails.map((e) => q.userByLogin.get(e)).find(Boolean);
        if (!user) {
          const email = emails.find((e) => allowedDomains.includes(e.split('@')[1]));
          if (!email) return null;
          q.insertUser.run(email, name, null, String(profile.id), 'manager');
          user = q.userByLogin.get(email);
        } else {
          q.linkYandex.run(String(profile.id), user.name || name, user.id);
        }
      }
      if (user.disabled) return null;
      return startSession(user.id);
    },

    userByToken: (token) => (token ? publicUser(q.sessionUser.get(sha256(token))) ?? null : null),
    logout: (token) => token && q.deleteSession.run(sha256(token)),
  };
}
