// API раздела «Документы»: шаблоны, документы, превью, проверка, выгрузка, КП из лида.
// Подключается внутри авторизованной части админки (req.user уже есть).

import { createReadStream } from 'node:fs';
import { DocError, leadValues } from '../docs/library.js';
import { QaError, FORMATS } from '../docs/build.js';
import { runQa } from '../docs/qa.js';
import { BrowserUnavailable } from '../docs/browser.js';
import { renderDeckHtml } from '../docs/render-html.js';
import { slideCatalog, emptySlide, CHART_TYPES } from '../docs/schema.js';
import { MediaError, MAX_BYTES } from '../docs/media.js';

const MIME = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html; charset=utf-8',
};

const idParams = { type: 'object', properties: { id: { type: 'integer' } } };
const specSchema = { type: 'object', required: ['slides'], properties: { meta: { type: 'object' }, slides: { type: 'array', maxItems: 40 } } };

export async function docsRoutes(api, { library, brand, db, scenarioSource, media = null }) {
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof DocError || err instanceof MediaError) return reply.code(400).send({ error: err.message });
    if (err instanceof BrowserUnavailable) {
      req.log.error({ err }, 'Chromium недоступен');
      return reply.code(503).send({ error: err.message });
    }
    throw err;
  });

  api.get('/admin/api/slide-types', async () => ({
    types: slideCatalog(),
    chartTypes: CHART_TYPES,
    empty: Object.fromEntries(slideCatalog().map((t) => [t.type, emptySlide(t.type)])),
    brand: { label: brand.label, status: brand.status, logo: Boolean(brand.logo.onLight) },
  }));

  // ---------- шаблоны ----------

  // Подписи переменных шаблона-основы (шаблон могли удалить — тогда стандартные)
  const templateVariables = (id) => {
    if (!id) return [];
    try {
      return library.getTemplate(id).variables;
    } catch {
      return [];
    }
  };

  api.get('/admin/api/templates', async () => ({ templates: library.listTemplates() }));

  api.get('/admin/api/templates/:id', async (req) => ({ template: library.getTemplate(req.params.id) }));

  api.post(
    '/admin/api/templates',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 120 },
            description: { type: 'string', maxLength: 500 },
            fromDocument: { type: 'integer' },
            fromTemplate: { type: 'string', maxLength: 40 },
            spec: specSchema,
          },
        },
      },
    },
    async (req) => {
      const { name, description = '', fromDocument, fromTemplate, spec } = req.body;
      let source = spec;
      let variables = null;
      let known = [];
      if (fromDocument) {
        const doc = library.getDocument(fromDocument);
        source = doc.spec;
        known = templateVariables(doc.template);
      }
      if (fromTemplate) {
        const t = library.getTemplate(fromTemplate);
        source = t.spec;
        variables = t.variables;
      }
      if (!source) throw new DocError('Нужен документ или шаблон-основа');
      return { template: library.saveTemplate({ name, description, spec: source, variables, known }, req.user.name) };
    },
  );

  api.put(
    '/admin/api/templates/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string', maxLength: 120 }, description: { type: 'string', maxLength: 500 }, spec: specSchema },
        },
      },
    },
    async (req) => {
      const current = library.getTemplate(req.params.id);
      return {
        template: library.saveTemplate(
          {
            id: req.params.id,
            name: req.body.name ?? current.name,
            description: req.body.description ?? current.description,
            spec: req.body.spec ?? current.spec,
            variables: req.body.spec ? null : current.variables,
            known: current.variables,
          },
          req.user.name,
        ),
      };
    },
  );

  api.delete('/admin/api/templates/:id', async (req) => {
    library.deleteTemplate(req.params.id);
    return { ok: true };
  });

  // ---------- документы ----------

  api.get('/admin/api/documents', async () => ({ documents: library.listDocuments() }));

  api.post(
    '/admin/api/documents',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            templateId: { type: 'string', maxLength: 40 },
            title: { type: 'string', maxLength: 200 },
            values: { type: 'object', additionalProperties: { type: 'string', maxLength: 2000 } },
            leadId: { type: 'integer' },
            // для правки шаблона: {{переменные}} остаются как есть, дата и менеджер не подставляются
            keepVariables: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const { templateId, title, leadId, keepVariables } = req.body;
      let values = req.body.values ?? {};
      if (keepVariables) {
        values = {};
      } else if (leadId) {
        const lead = db.getLead(leadId);
        if (!lead) throw new DocError('Лид не найден');
        // из лида — то, что не задано вручную
        values = { ...leadValues(lead, scenarioSource.get(), req.user), ...Object.fromEntries(Object.entries(values).filter(([, v]) => v)) };
      } else {
        values = { ...leadValues(null, scenarioSource.get(), req.user), ...Object.fromEntries(Object.entries(values).filter(([, v]) => v)) };
      }
      return { document: library.createDocument({ templateId, values, title, leadId }, req.user.name) };
    },
  );

  api.get('/admin/api/documents/:id', { schema: { params: idParams } }, async (req) => ({
    document: library.getDocument(req.params.id),
    exports: library.listExports(req.params.id).map(({ manifest, ...e }) => ({ ...e, qaOk: manifest.qa.ok, forced: manifest.qa.forced })),
  }));

  api.put(
    '/admin/api/documents/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 200 }, spec: specSchema } },
      },
      bodyLimit: 600 * 1024,
    },
    async (req) => ({ document: library.updateDocument(req.params.id, req.body, req.user.name) }),
  );

  api.post('/admin/api/documents/:id/copy', { schema: { params: idParams } }, async (req) => ({ document: library.copyDocument(req.params.id, req.user.name) }));

  api.delete('/admin/api/documents/:id', { schema: { params: idParams } }, async (req) => {
    library.deleteDocument(req.params.id);
    return { ok: true };
  });

  // Превью для редактора: свой CSP (стили документа встроены), без доступа к остальной админке
  // ?slide=N — один слайд (с нуля) для редактора, без параметра — весь документ
  const previewQuery = { type: 'object', properties: { slide: { type: 'integer', minimum: 0 } } };
  api.get('/admin/api/documents/:id/preview', { schema: { params: idParams, querystring: previewQuery } }, async (req, reply) => {
    const doc = library.getDocument(req.params.id);
    const { slide } = req.query;
    const html = doc.spec.slides.length && (slide == null || slide < doc.spec.slides.length)
      ? renderDeckHtml(library.prepare({ ...doc.spec, meta: { ...doc.spec.meta, title: doc.title } }, { inline: false }), brand, slide == null ? { mode: 'screen' } : { mode: 'print', only: [slide] })
      : '<!doctype html><meta charset="utf-8"><body style="font:16px sans-serif;color:#5F6B72;padding:40px">Добавьте первый слайд</body>';
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'; font-src data:; script-src 'unsafe-inline'; frame-ancestors 'self'")
      .header('x-frame-options', 'SAMEORIGIN')
      .send(html);
  });

  api.post('/admin/api/documents/:id/qa', { schema: { params: idParams } }, async (req) => {
    const doc = library.getDocument(req.params.id);
    if (!doc.spec.slides.length) throw new DocError('В документе нет слайдов');
    return { qa: await runQa(library.prepare(doc.spec), brand) };
  });

  api.post(
    '/admin/api/documents/:id/export',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['format'], additionalProperties: false, properties: { format: { type: 'string', enum: FORMATS }, force: { type: 'boolean' } } },
      },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      // Выгрузка с ошибками проверки (черновик) — только администратору
      const force = Boolean(req.body.force) && req.user.role === 'admin';
      try {
        const res = await library.exportDocument(req.params.id, req.body.format, { force }, req.user.name);
        req.log.info({ doc: req.params.id, format: req.body.format, by: req.user.login, forced: res.manifest.qa.forced }, 'Выгрузка документа');
        return { exportId: res.exportId, qa: res.qa };
      } catch (err) {
        if (err instanceof QaError) return reply.code(422).send({ error: err.message, qa: err.qa, canForce: req.user.role === 'admin' });
        throw err;
      }
    },
  );

  api.get('/admin/api/exports/:id', { schema: { params: idParams } }, async (req, reply) => {
    const e = library.getExport(req.params.id);
    return reply
      .header('content-type', MIME[e.format])
      .header('content-disposition', `attachment; filename="${e.filename}"; filename*=UTF-8''${encodeURIComponent(`${e.title}.${e.format}`)}`)
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'")
      .send(createReadStream(e.file));
  });

  // ---------- медиатека: фото и креативы ----------

  if (media) {
    // картинка приходит «как есть» в теле запроса: без multipart и лишних зависимостей
    api.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (req, body, done) => done(null, body));

    api.post('/admin/api/media', { bodyLimit: MAX_BYTES, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      if (!Buffer.isBuffer(req.body)) throw new MediaError('Нужен файл JPG или PNG');
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).slice(0, 200);
      return { media: media.save(req.body, { name, user: req.user }) };
    });

    api.get('/admin/api/media', async () => ({ media: media.list() }));

    api.get('/admin/api/media/:id', { schema: { params: idParams } }, async (req, reply) => {
      const m = media.get(req.params.id);
      // номер навсегда привязан к одному файлу — браузер может хранить его долго
      return reply.header('content-type', m.mime).header('cache-control', 'private, max-age=31536000, immutable').send(media.read(m));
    });

    api.delete('/admin/api/media/:id', { schema: { params: idParams } }, async (req) => {
      media.remove(req.params.id, req.user);
      return { ok: true };
    });
  }

  // ---------- документы из лида ----------

  api.get('/admin/api/leads/:id/documents', { schema: { params: idParams } }, async (req) => ({ documents: library.documentsForLead(req.params.id) }));
}
