// Документы и шаблоны: встроенные шаблоны из templates/decks, свои — в базе.
// Переменные {{client}}, {{date}}… подставляются при создании документа (из формы или карточки лида).

import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SLIDE_TYPES } from './templates.js';
import { buildDeck } from './build.js';

const MAX_SLIDES = 40;
const VAR_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

export class DocError extends Error {}

export function createDocLibrary({ db, brand, templatesDir, dataDir, media = null }) {
  // картинки из медиатеки: в превью — ссылки, в выгрузке и проверке — внутри файла
  const prepare = (spec, { inline = true } = {}) => (media ? media.hydrate(spec, { inline }) : spec);

  const q = {
    listTemplates: db.prepare('SELECT * FROM doc_templates ORDER BY updated_at DESC'),
    getTemplate: db.prepare('SELECT * FROM doc_templates WHERE id = ?'),
    insertTemplate: db.prepare('INSERT INTO doc_templates (name, description, variables, spec, created_by) VALUES (?, ?, ?, ?, ?)'),
    updateTemplate: db.prepare("UPDATE doc_templates SET name = ?, description = ?, variables = ?, spec = ?, updated_at = datetime('now') WHERE id = ?"),
    deleteTemplate: db.prepare('DELETE FROM doc_templates WHERE id = ?'),
    listDocs: db.prepare(
      `SELECT d.id, d.title, d.template, d.lead_id, d.created_by, d.updated_by, d.created_at, d.updated_at,
              json_array_length(d.spec, '$.slides') AS slides,
              (SELECT COUNT(*) FROM document_exports e WHERE e.document_id = d.id) AS exports
       FROM documents d ORDER BY d.updated_at DESC LIMIT 200`,
    ),
    docsByLead: db.prepare('SELECT id, title, template, updated_at FROM documents WHERE lead_id = ? ORDER BY id DESC'),
    getDoc: db.prepare('SELECT * FROM documents WHERE id = ?'),
    insertDoc: db.prepare('INSERT INTO documents (title, spec, template, lead_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)'),
    updateDoc: db.prepare("UPDATE documents SET title = ?, spec = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?"),
    deleteDoc: db.prepare('DELETE FROM documents WHERE id = ?'),
    deleteDocExports: db.prepare('DELETE FROM document_exports WHERE document_id = ?'),
    insertExport: db.prepare('INSERT INTO document_exports (document_id, format, file, bytes, sha256, manifest, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    listExports: db.prepare('SELECT id, format, bytes, created_by, created_at, manifest FROM document_exports WHERE document_id = ? ORDER BY id DESC LIMIT 20'),
    getExport: db.prepare('SELECT * FROM document_exports WHERE id = ?'),
  };

  // ---------- шаблоны ----------

  function builtins() {
    if (!existsSync(templatesDir)) return [];
    return readdirSync(templatesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(resolve(templatesDir, f), 'utf8')))
      // брифы — отдельной группой после основных шаблонов
      .sort((a, b) => (a.group === 'brief') - (b.group === 'brief'));
  }

  const summarize = (t) => ({
    id: t.id,
    name: t.name,
    description: t.description ?? '',
    group: t.group ?? null,
    builtin: Boolean(t.builtin),
    variables: t.variables,
    slides: t.spec.slides.length,
    types: t.spec.slides.map((s) => s.type),
    updated_at: t.updated_at ?? null,
    created_by: t.created_by ?? null,
  });

  function getTemplate(id) {
    const value = String(id);
    if (value.startsWith('builtin:')) {
      const t = builtins().find((b) => b.id === value.slice(8));
      if (!t) throw new DocError('Шаблон не найден');
      return { ...t, id: value, builtin: true };
    }
    const row = q.getTemplate.get(Number(value));
    if (!row) throw new DocError('Шаблон не найден');
    return { ...row, id: String(row.id), builtin: false, variables: JSON.parse(row.variables), spec: JSON.parse(row.spec) };
  }

  function listTemplates() {
    const own = q.listTemplates.all().map((r) => ({ ...r, id: String(r.id), variables: JSON.parse(r.variables), spec: JSON.parse(r.spec) }));
    return [...builtins().map((t) => ({ ...t, id: `builtin:${t.id}`, builtin: true })), ...own].map(summarize);
  }

  /** Свой шаблон: из документа или с нуля. Переменные определяются по {{…}} в тексте. */
  function saveTemplate({ id = null, name, description = '', spec, variables = null, known = [] }, user) {
    validateSpec(spec);
    const vars = variables ?? detectVariables(spec, known);
    const args = [String(name).trim().slice(0, 120) || 'Без названия', String(description).slice(0, 500), JSON.stringify(vars), JSON.stringify(spec)];
    if (id) {
      if (String(id).startsWith('builtin:')) throw new DocError('Встроенный шаблон менять нельзя — сохраните копию');
      if (!q.updateTemplate.run(...args, Number(id)).changes) throw new DocError('Шаблон не найден');
      return getTemplate(id);
    }
    const { lastInsertRowid } = q.insertTemplate.run(...args, user);
    return getTemplate(lastInsertRowid);
  }

  function deleteTemplate(id) {
    if (String(id).startsWith('builtin:')) throw new DocError('Встроенный шаблон удалить нельзя');
    if (!q.deleteTemplate.run(Number(id)).changes) throw new DocError('Шаблон не найден');
  }

  // ---------- документы ----------

  const parseDoc = (row) => row && { ...row, spec: JSON.parse(row.spec) };

  function createDocument({ templateId = null, values = {}, title = null, spec = null, leadId = null }, user) {
    let source = spec;
    if (templateId) source = fillVariables(getTemplate(templateId).spec, values);
    if (!source) source = { meta: {}, slides: [] };
    validateSpec(source, { allowEmpty: true });
    const docTitle = String(title ?? source.meta?.title ?? 'Новый документ').slice(0, 200);
    const { lastInsertRowid } = q.insertDoc.run(docTitle, JSON.stringify(source), templateId, leadId, user, user);
    return getDocument(lastInsertRowid);
  }

  function getDocument(id) {
    const doc = parseDoc(q.getDoc.get(Number(id)));
    if (!doc) throw new DocError('Документ не найден');
    return doc;
  }

  function updateDocument(id, { title, spec }, user) {
    const doc = getDocument(id);
    const next = spec ?? doc.spec;
    validateSpec(next, { allowEmpty: true });
    q.updateDoc.run(String(title ?? doc.title).slice(0, 200), JSON.stringify(next), user, doc.id);
    return getDocument(id);
  }

  /** Копия документа: те же слайды и шаблон, без истории выгрузок. */
  function copyDocument(id, user) {
    const doc = getDocument(id);
    const title = `${doc.title} (копия)`.slice(0, 200);
    const { lastInsertRowid } = q.insertDoc.run(title, JSON.stringify(doc.spec), doc.template ?? null, doc.lead_id ?? null, user, user);
    return getDocument(lastInsertRowid);
  }

  function deleteDocument(id) {
    getDocument(id);
    q.deleteDocExports.run(Number(id));
    q.deleteDoc.run(Number(id));
  }

  /** Проверка и выгрузка; файл сохраняется в data/documents/<id>/, запись — в истории выгрузок. */
  async function exportDocument(id, format, { force = false } = {}, user) {
    const doc = getDocument(id);
    if (!doc.spec.slides.length) throw new DocError('В документе нет слайдов');
    const { qa, files, manifest } = await buildDeck(prepare({ ...doc.spec, meta: { ...doc.spec.meta, title: doc.title } }), brand, { formats: [format], force });
    const buf = files[format];
    const dir = join(dataDir, 'documents', String(doc.id));
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const file = join(dir, `${stamp}.${format}`);
    writeFileSync(file, buf);
    const { lastInsertRowid } = q.insertExport.run(doc.id, format, file, buf.length, manifest.files[format].sha256, JSON.stringify(manifest), user);
    return { exportId: Number(lastInsertRowid), qa, manifest };
  }

  function getExport(id) {
    const row = q.getExport.get(Number(id));
    if (!row) throw new DocError('Файл не найден');
    const doc = getDocument(row.document_id);
    return { ...row, manifest: JSON.parse(row.manifest), filename: `${slugify(doc.title)}.${row.format}`, title: doc.title };
  }

  return {
    prepare,
    listTemplates,
    getTemplate,
    saveTemplate,
    deleteTemplate,
    listDocuments: () => q.listDocs.all(),
    documentsForLead: (leadId) => q.docsByLead.all(leadId),
    getDocument,
    createDocument,
    copyDocument,
    updateDocument,
    deleteDocument,
    exportDocument,
    listExports: (id) => q.listExports.all(Number(id)).map((e) => ({ ...e, manifest: JSON.parse(e.manifest) })),
    getExport,
  };
}

// ---------- переменные ----------

// Подписи стандартных переменных — те же, что во встроенных шаблонах
const KNOWN_VARIABLES = {
  client: { label: 'Клиент', from: 'lead.company' },
  service: { label: 'Услуга', from: 'lead.service' },
  task: { label: 'Задача клиента', from: 'lead.task' },
  budget: { label: 'Бюджет', from: 'lead.budget' },
  industry: { label: 'Сфера', from: 'lead.industry' },
  contact_name: { label: 'Контактное лицо', from: 'lead.name' },
  date: { label: 'Дата', from: 'today' },
  manager: { label: 'Менеджер', from: 'user.name' },
};

/** Переменные {{…}} в тексте; подписи берутся из прежнего описания шаблона или стандартных. */
export function detectVariables(spec, known = []) {
  const keys = new Set();
  walk(spec, (s) => {
    for (const m of s.matchAll(VAR_RE)) keys.add(m[1]);
  });
  const prev = Object.fromEntries(known.map((v) => [v.key, v]));
  return [...keys].map((key) => prev[key] ?? { key, ...(KNOWN_VARIABLES[key] ?? { label: key, from: '' }) });
}

/** Подставляет значения {{key}}; незаполненные переменные остаются — проверка их поймает. */
export function fillVariables(spec, values) {
  const replace = (s) =>
    s.replace(VAR_RE, (m, key) => {
      const v = values[key];
      return v == null || String(v).trim() === '' ? m : String(v);
    });
  return mapStrings(structuredClone(spec), replace);
}

/** Значения переменных из карточки лида и текущего сотрудника. */
export function leadValues(lead, scenario, user) {
  const label = (id) => {
    const v = lead?.answers?.[id];
    if (v == null) return '';
    if (typeof v === 'object') return v.raw ?? '';
    return scenario.steps.find((s) => s.id === id)?.options?.find((o) => o.value === v)?.label ?? String(v);
  };
  return {
    client: label('company'),
    service: label('service'),
    task: label('task'),
    budget: label('budget'),
    industry: label('industry'),
    contact_name: label('name'),
    date: new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }),
    manager: user?.name ?? '',
  };
}

export function validateSpec(spec, { allowEmpty = false } = {}) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.slides)) throw new DocError('Неверная структура документа');
  if (!allowEmpty && !spec.slides.length) throw new DocError('В документе нет слайдов');
  if (spec.slides.length > MAX_SLIDES) throw new DocError(`Не больше ${MAX_SLIDES} слайдов в одном документе`);
  spec.slides.forEach((s, i) => {
    if (!s || !SLIDE_TYPES[s.type]) throw new DocError(`Слайд ${i + 1}: неизвестный тип`);
  });
  if (JSON.stringify(spec).length > 500_000) throw new DocError('Документ слишком большой');
}

function walk(obj, fn) {
  if (typeof obj === 'string') return fn(obj);
  if (Array.isArray(obj)) return obj.forEach((v) => walk(v, fn));
  if (obj && typeof obj === 'object') Object.values(obj).forEach((v) => walk(v, fn));
}

function mapStrings(obj, fn) {
  if (typeof obj === 'string') return fn(obj);
  if (Array.isArray(obj)) return obj.map((v) => mapStrings(v, fn));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, mapStrings(v, fn)]));
  return obj;
}

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

export function slugify(title) {
  const s = String(title)
    .toLowerCase()
    .split('')
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return s || 'document';
}
