// Загрузка и проверка сценария. Источник — config/scenario.json; вопросы можно
// вести в Google Таблице (опубликованной как CSV) — тогда они заменяют steps из JSON.

import { readFile } from 'node:fs/promises';

const STEP_TYPES = new Set(['choice', 'text', 'contact', 'consent']);

export async function loadScenarioFile(path) {
  return validateScenario(JSON.parse(await readFile(path, 'utf8')));
}

export function validateScenario(scenario) {
  if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
    throw new Error('В сценарии нет вопросов');
  }
  const seen = new Map();
  for (const step of scenario.steps) {
    const where = `шаг «${step.id}»`;
    if (!step.id || !/^[a-z0-9_]+$/.test(step.id)) throw new Error(`${where}: id — латиница, цифры и _`);
    if (seen.has(step.id)) throw new Error(`${where}: id повторяется`);
    if (!STEP_TYPES.has(step.type)) throw new Error(`${where}: неизвестный тип «${step.type}»`);
    if (!step.text) throw new Error(`${where}: нет текста вопроса`);
    if ((step.type === 'choice' || step.type === 'consent') && !step.options?.length) {
      throw new Error(`${where}: нет вариантов ответа`);
    }
    for (const [ref, values] of Object.entries(step.when ?? {})) {
      const target = seen.get(ref);
      if (!target) throw new Error(`${where}: условие ссылается на «${ref}», которого нет выше`);
      const known = new Set(target.options?.map((o) => o.value));
      const unknown = values.filter((v) => !known.has(v));
      if (unknown.length) throw new Error(`${where}: в условии неизвестные варианты ${unknown.join(', ')}`);
    }
    seen.set(step.id, step);
  }
  if (!scenario.steps.some((s) => s.type === 'contact')) {
    throw new Error('В сценарии должен быть вопрос с типом contact');
  }
  return scenario;
}

// ---------- Google Таблица ----------

export const CSV_COLUMNS = ['id', 'название', 'тип', 'вопрос', 'варианты', 'обязательный', 'показывать если', 'подсказка'];

/** Простой CSV-парсер (RFC 4180): кавычки, переводы строк внутри ячеек. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Строки таблицы → steps. Варианты: по одному в строке ячейки, «value: Подпись». */
export function stepsFromCsv(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const idx = Object.fromEntries(CSV_COLUMNS.map((c) => [c, header.findIndex((h) => h.trim().toLowerCase() === c)]));
  const missing = CSV_COLUMNS.filter((c) => idx[c] === -1);
  if (missing.length) throw new Error(`В таблице нет колонок: ${missing.join(', ')}`);

  return rows.map((r) => {
    const get = (c) => (r[idx[c]] ?? '').trim();
    const step = {
      id: get('id'),
      label: get('название') || get('id'),
      type: get('тип'),
      text: get('вопрос'),
      required: get('обязательный') === '1',
    };
    const options = get('варианты')
      .split(/\n|;/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^([a-z0-9_]+)\s*:\s*(.+)$/);
        if (!m) throw new Error(`шаг «${step.id}»: вариант «${line}» должен быть в виде «value: Подпись»`);
        return { value: m[1], label: m[2].trim() };
      });
    if (options.length) step.options = options;
    const when = get('показывать если');
    if (when) {
      step.when = Object.fromEntries(
        when.split(/\n|;/).filter(Boolean).map((cond) => {
          const [ref, values] = cond.split('=').map((s) => s.trim());
          return [ref, values.split(',').map((v) => v.trim())];
        }),
      );
    }
    const hint = get('подсказка');
    if (hint) step.placeholder = hint;
    return step;
  });
}

export function stepsToCsv(steps) {
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = [CSV_COLUMNS.join(',')];
  for (const s of steps) {
    lines.push([
      s.id,
      s.label ?? '',
      s.type,
      s.text,
      (s.options ?? []).map((o) => `${o.value}: ${o.label}`).join('\n'),
      s.required ? '1' : '',
      Object.entries(s.when ?? {}).map(([k, v]) => `${k}=${v.join(',')}`).join('\n'),
      s.placeholder ?? '',
    ].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Держит актуальный сценарий: базовый JSON + (опционально) вопросы из Google Таблицы.
 * Если таблица недоступна или заполнена с ошибкой — остаётся последняя рабочая версия.
 */
export async function createScenarioSource({ file, csvUrl, refreshMs = 5 * 60_000, log = console }) {
  const base = await loadScenarioFile(file);
  let currentScenario = base;

  async function refresh() {
    if (!csvUrl) return;
    try {
      const res = await fetch(csvUrl, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      currentScenario = validateScenario({ ...base, steps: stepsFromCsv(await res.text()) });
    } catch (err) {
      log.error({ err }, 'Не удалось обновить сценарий из Google Таблицы, работаю на прежней версии');
    }
  }

  await refresh();
  const timer = csvUrl ? setInterval(refresh, refreshMs) : null;
  timer?.unref();

  return {
    get: () => currentScenario,
    refresh,
    stop: () => timer && clearInterval(timer),
  };
}
