// Постмит: список договорённостей со встречи — в задачи. Каждая строка — задача; исполнитель
// и срок берутся из текста: «Олег — креативы до пятницы», «медиаплан на ноябрь, Ира, к 20.10».

import { parseWhen } from './when.js';
import { findPerson, tidyTitle } from './commands.js';

const PRIO = [[/(?:^|\s)(?:критично|аврал|горит)(?=\s|[,.!]|$)/i, 4], [/(?:^|\s)(?:срочно|важно)(?=\s|[,.!]|$)/i, 3]];

/** Текст списком → [{ title, assigneeId, assigneeName, due, dueTime, priority }]. */
export function parseFollowup(text, { team = [], now = new Date() } = {}) {
  const lines = String(text ?? '')
    .split(/\n|;/)
    .map((l) => l.replace(/^\s*(?:[-*•–—]|\d+[.)]|\[[ x]?\])\s*/i, '').trim())
    .filter((l) => l.length > 1);
  return lines.slice(0, 50).map((line) => {
    let rest = line;
    let priority = 0;
    for (const [re, p] of PRIO) if (re.test(rest)) ((priority = Math.max(priority, p)), (rest = rest.replace(re, ' ')));
    const person = findPerson(rest, team);
    if (person) rest = rest.replace(new RegExp(`(?:^|[\\s,(])(?:ответственн\\S*:?\\s*|на\\s+|для\\s+)?${person.word}(?=[\\s,):—–-]|$)`, 'i'), ' ');
    const w = parseWhen(rest, now);
    const title = tidyTitle(w.rest.replace(/^[\s,:—–-]+|[\s,:—–-]+$/g, '').replace(/\s*[,—–-]\s*$/g, '').replace(/\s{2,}/g, ' '));
    return { title: title || tidyTitle(line), assigneeId: person?.user.id ?? null, assigneeName: person?.user.name ?? null, due: w.date, dueTime: w.date ? w.time : null, priority };
  });
}
