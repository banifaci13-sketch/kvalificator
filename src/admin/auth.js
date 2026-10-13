// Сотрудники агентства и их сессии в админке.
// Пароли — scrypt с солью; в базе хранится только хеш токена сессии.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MIN_PASSWORD = 10;

export function hashPassword(password) {
  if (String(password).length < MIN_PASSWORD) throw new Error(`Пароль — минимум ${MIN_PASSWORD} символов`);
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

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Хеш-заглушка, чтобы вход несуществующего пользователя занимал столько же времени
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

export function createAuth(db) {
  const q = {
    userByEmail: db.prepare('SELECT * FROM admin_users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM admin_users WHERE id = ?'),
    listUsers: db.prepare(
      `SELECT id, email, name, disabled, created_at, password_hash IS NOT NULL AS has_password,
              yandex_id IS NOT NULL AS has_yandex
       FROM admin_users ORDER BY id`,
    ),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM admin_users'),
    insertUser: db.prepare('INSERT INTO admin_users (email, name, password_hash, yandex_id) VALUES (?, ?, ?, ?)'),
    userByYandex: db.prepare('SELECT * FROM admin_users WHERE yandex_id = ?'),
    linkYandex: db.prepare('UPDATE admin_users SET yandex_id = ?, name = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE admin_users SET password_hash = ? WHERE email = ?'),
    setDisabled: db.prepare('UPDATE admin_users SET disabled = ? WHERE email = ?'),
    insertSession: db.prepare(
      `INSERT INTO admin_sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`,
    ),
    sessionUser: db.prepare(
      `SELECT u.id, u.email, u.name FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.disabled = 0`,
    ),
    deleteSession: db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare(
      'DELETE FROM admin_sessions WHERE user_id = (SELECT id FROM admin_users WHERE email = ?)',
    ),
    purgeExpired: db.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')"),
  };

  function startSession(userId) {
    q.purgeExpired.run();
    const token = randomBytes(32).toString('base64url');
    q.insertSession.run(sha256(token), userId);
    return token;
  }

  return {
    sessionDays: SESSION_DAYS,
    hasUsers: () => q.countUsers.get().n > 0,
    listUsers: () => q.listUsers.all(),

    /** Без пароля сотрудник входит только через Яндекс ID. */
    addUser(email, name, password = null) {
      const normalized = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new Error('Некорректный e-mail');
      if (q.userByEmail.get(normalized)) throw new Error('Такой пользователь уже есть');
      q.insertUser.run(normalized, String(name ?? '').trim() || normalized, password ? hashPassword(password) : null, null);
    },

    setPassword(email, password) {
      if (q.setPassword.run(hashPassword(password), email).changes === 0) throw new Error('Пользователь не найден');
      q.deleteUserSessions.run(email);
    },

    setDisabled(email, disabled) {
      if (q.setDisabled.run(disabled ? 1 : 0, email).changes === 0) throw new Error('Пользователь не найден');
      if (disabled) q.deleteUserSessions.run(email);
    },

    /** Возвращает токен сессии или null. */
    login(email, password) {
      const user = q.userByEmail.get(String(email).trim());
      const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok || user.disabled) return null;
      return startSession(user.id);
    },

    /**
     * Вход через Яндекс ID. Пускаем, если e-mail сотрудника заранее добавлен в админку
     * или его домен в allowedDomains (тогда учётная запись создаётся автоматически).
     */
    loginWithYandex(profile, { allowedDomains = [] } = {}) {
      const emails = [profile.default_email, ...(profile.emails ?? [])].filter(Boolean).map((e) => e.toLowerCase());
      const name = profile.real_name || profile.display_name || profile.login || emails[0];
      let user = q.userByYandex.get(String(profile.id));
      if (!user) {
        user = emails.map((e) => q.userByEmail.get(e)).find(Boolean);
        if (!user) {
          const email = emails.find((e) => allowedDomains.includes(e.split('@')[1]));
          if (!email) return null;
          q.insertUser.run(email, name, null, String(profile.id));
          user = q.userByEmail.get(email);
        } else {
          q.linkYandex.run(String(profile.id), user.name || name, user.id);
        }
      }
      if (user.disabled) return null;
      return startSession(user.id);
    },

    userByToken: (token) => (token ? q.sessionUser.get(sha256(token)) ?? null : null),
    logout: (token) => token && q.deleteSession.run(sha256(token)),
  };
}
