// «Состояние системы» для администратора: место на диске, резервные копии, фоновые задачи,
// недоставленные заявки, обращения к ИИ, последние ошибки. Только чтение; секретов и персональных
// данных в ответе нет (ключи — только «настроено / нет», ошибки — без тел запросов).

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dirUsage, listBackups, readStatus, backupDir } from './backup.js';

const CACHE_MS = 60_000;

export function createSystemStatus({ db, dbPath, monitor, leadRecipients = false, now = () => new Date() }) {
  const q = {
    undelivered: db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM leads WHERE notified = 0 AND is_test = 0 AND created_at <= datetime('now', '-10 minutes')"),
    ai: db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(chars_in), 0) AS chars_in, COALESCE(SUM(chars_out), 0) AS chars_out
       FROM ai_log WHERE created_at >= datetime('now', '-7 days')`,
    ),
    aiByAction: db.prepare("SELECT action, COUNT(*) AS n FROM ai_log WHERE created_at >= datetime('now', '-7 days') GROUP BY action ORDER BY n DESC LIMIT 8"),
  };
  let disk = null;
  let diskAt = 0;

  function storage() {
    if (disk && now().getTime() - diskAt < CACHE_MS) return disk;
    const data = dirname(dbPath);
    const size = (p) => (existsSync(p) ? statSync(p).size : 0);
    disk = {
      db: { bytes: size(dbPath), wal: size(`${dbPath}-wal`) },
      files: dirUsage(join(data, 'files')),
      media: dirUsage(join(data, 'media')),
      documents: dirUsage(join(data, 'documents')),
      backups: dirUsage(backupDir(dbPath)),
    };
    diskAt = now().getTime();
    return disk;
  }

  function get() {
    const st = readStatus(dbPath);
    const copies = listBackups(dbPath);
    const last = copies.at(-1) ?? null;
    const ageH = last ? (now().getTime() - Date.parse(st.backup?.createdAt ?? 0)) / 3600e3 : null;
    const lead = q.undelivered.get();
    const mon = monitor.snapshot();
    return {
      checkedAt: now().toISOString(),
      startedAt: mon.startedAt,
      node: process.version,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      storage: storage(),
      backup: {
        copies: copies.length,
        last: last ? { name: last.name, bytes: last.bytes } : null,
        // свежая копия — не старше полутора суток (cron раз в день)
        fresh: ageH != null && ageH <= 36,
        ageHours: ageH != null && Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null,
        result: st.backup ?? null,
        check: st.check ?? null,
      },
      jobs: mon.jobs,
      leads: { recipients: leadRecipients, undelivered: lead.n, oldest: lead.oldest },
      ai: { week: q.ai.get(), byAction: q.aiByAction.all() },
      errors: mon.errors,
    };
  }

  return { get };
}
