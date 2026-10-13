// Уведомления в кабинете — колокольчик в боковой панели. Работают без Telegram:
// «вам поручили задачу», «комментарий к вашей задаче», «вас упомянули», «задача выполнена»,
// «вас пригласили на встречу», горячий лид, оплата клиента.

export function createNotifications({ db }) {
  const q = {
    add: db.prepare('INSERT INTO notifications (user_id, kind, text, href, actor, actor_id) VALUES (?, ?, ?, ?, ?, ?)'),
    list: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
    readAll: db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL"),
    readOne: db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id = ? AND read_at IS NULL"),
    // старые прочитанные не копятся: держим 60 дней
    prune: db.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < datetime('now', '-60 days')"),
  };
  return {
    /** Уведомить сотрудника. actor — кто сделал (себя не уведомляем). */
    add(userId, { kind, text, href = null, actor = null, actorId = null }) {
      if (!userId || userId === actorId) return;
      q.add.run(userId, kind, String(text).slice(0, 500), href, actor, actorId);
    },
    list: (userId, limit = 30) => q.list.all(userId, limit),
    unread: (userId) => q.unread.get(userId).n,
    read(userId, id = null) {
      if (id) q.readOne.run(userId, Number(id));
      else q.readAll.run(userId);
    },
    prune: () => q.prune.run(),
  };
}
