// Регламенты агентства — база знаний ассистента. Описания процессов (как готовим КП, как запускаем
// рекламу, как сдаём отчёт) хранятся текстом; к вопросу подбираются самые подходящие фрагменты.

export class KbError extends Error {}

const STOP = new Set(['как', 'что', 'это', 'для', 'при', 'или', 'если', 'когда', 'где', 'кто', 'чем', 'надо', 'нужно', 'можно', 'есть', 'так', 'все', 'мне', 'нам', 'наш', 'наши', 'над', 'под', 'про', 'его', 'она', 'они', 'еще', 'уже', 'там', 'тут']);
// основа слова: первые 5 букв — «отчёт», «отчёты», «отчётом» совпадают
const stems = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => w.slice(0, 5));

/** Документ — на фрагменты по абзацам, не длиннее ~900 знаков; заголовок раздела идёт с фрагментом. */
export function chunk(doc, max = 900) {
  const parts = [];
  let head = doc.title;
  let buf = '';
  const flush = () => {
    if (buf.trim()) parts.push({ docId: doc.id, title: doc.title, section: head, text: buf.trim() });
    buf = '';
  };
  for (const raw of String(doc.body).split(/\n\s*\n/)) {
    let block = raw.trim();
    // заголовок раздела «# …» — новый фрагмент; текст под ним в том же абзаце остаётся
    const h = /^#{1,4}\s+(.+)(?:\n([\s\S]*))?$/.exec(block);
    if (h) {
      flush();
      head = h[1].trim();
      block = (h[2] ?? '').trim();
      if (!block) continue;
    }
    if ((buf + block).length > max) flush();
    buf += `${block}\n\n`;
  }
  flush();
  return parts;
}

/**
 * Регламент — план работ: раздел «# Шаг 1. Бриф» становится задачей, пункты списка под ним —
 * её чек-листом, обычный текст — описанием. Пункты до первого заголовка — отдельный шаг.
 */
export function outline(doc) {
  const clean = (s) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\s+/g, ' ').trim();
  const steps = [];
  let cur = null;
  for (const raw of String(doc.body ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = /^#{1,4}\s+(.+)/.exec(line);
    if (head) {
      cur = { title: clean(head[1]).slice(0, 300), items: [], notes: [] };
      steps.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: doc.title, items: [], notes: [] };
      steps.push(cur);
    }
    const item = /^(?:[-*•]|\d+[.)]|\[[ x]\])\s+(.+)/i.exec(line);
    if (item) cur.items.push(clean(item[1]).slice(0, 300));
    else cur.notes.push(clean(line));
  }
  // вступление без пунктов — не отдельный шаг, а пояснение ко всем
  const intro = steps[0]?.title === doc.title && !steps[0].items.length && steps.length > 1 ? steps.shift().notes : [];
  return steps.filter((s) => s.items.length || s.notes.length || s.title !== doc.title).map((s) => (intro.length ? { ...s, intro } : s));
}

export function createKb({ db }) {
  const q = {
    list: db.prepare('SELECT id, title, length(body) AS size, updated_by, updated_at FROM kb_docs ORDER BY title COLLATE NOCASE'),
    all: db.prepare('SELECT * FROM kb_docs'),
    get: db.prepare('SELECT * FROM kb_docs WHERE id = ?'),
    insert: db.prepare('INSERT INTO kb_docs (title, body, updated_by) VALUES (?, ?, ?)'),
    update: db.prepare("UPDATE kb_docs SET title = ?, body = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?"),
    remove: db.prepare('DELETE FROM kb_docs WHERE id = ?'),
  };
  const get = (id) => {
    const d = q.get.get(Number(id));
    if (!d) throw new KbError('Регламент не найден');
    return d;
  };
  const check = (v) => {
    const title = String(v.title ?? '').trim().slice(0, 200);
    const body = String(v.body ?? '').trim();
    if (!title) throw new KbError('Назовите регламент');
    if (!body) throw new KbError('Добавьте описание процесса');
    if (body.length > 100_000) throw new KbError('Регламент слишком длинный — разделите на несколько');
    return { title, body };
  };
  return {
    list: () => q.list.all(),
    get,
    create(v, user) {
      const d = check(v);
      return get(q.insert.run(d.title, d.body, user.name).lastInsertRowid);
    },
    update(id, v, user) {
      const cur = get(id);
      const d = check({ title: v.title ?? cur.title, body: v.body ?? cur.body });
      q.update.run(d.title, d.body, user.name, cur.id);
      return get(id);
    },
    remove: (id) => q.remove.run(get(id).id),
    /** Фрагменты регламентов, подходящие к вопросу: [{ title, section, text }]. */
    search(query, { limit = 4, budget = 3500 } = {}) {
      const want = new Set(stems(query));
      if (!want.size) return [];
      const scored = q
        .all.all()
        .flatMap((d) => chunk(d))
        .map((c) => {
          const words = stems(`${c.section} ${c.text}`);
          let score = 0;
          for (const w of want) if (words.includes(w)) score += 1 + (stems(c.section).includes(w) ? 1 : 0);
          return { ...c, score };
        })
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);
      const out = [];
      let used = 0;
      for (const c of scored) {
        if (out.length >= limit || used + c.text.length > budget) break;
        out.push(c);
        used += c.text.length;
      }
      return out;
    },
  };
}
