// API раздела «Медиапланы»: планы, нормативы агентства, Excel, вставка в презентацию.
// Подключается внутри авторизованной части админки (req.user уже есть).

import { DocError, slugify } from '../docs/library.js';
import { mediaplanXlsx } from '../mediaplan/xlsx.js';
import { mediaplanSheetFile, SHEET_FORMATS } from '../mediaplan/sheet.js';
import { BrowserUnavailable } from '../docs/browser.js';
import { MODELS } from '../mediaplan/calc.js';
import { LIMITS } from '../mediaplan/store.js';

const idParams = { type: 'object', properties: { id: { type: 'integer' } } };
const planBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 200 },
    client: { type: 'string', maxLength: 200 },
    leadId: { type: 'integer' },
    spec: { type: 'object' },
  },
};
const benchmarkBody = {
  type: 'object',
  additionalProperties: false,
  required: ['channel', 'note'],
  properties: {
    channel: { type: 'string', maxLength: 120 },
    model: { type: 'string', enum: MODELS.map(([id]) => id) },
    cpc: { type: ['number', 'null'] },
    cpm: { type: ['number', 'null'] },
    ctr: { type: ['number', 'null'] },
    cr: { type: ['number', 'null'] },
    note: { type: 'string', maxLength: 500 },
  },
};

export async function mediaplanRoutes(api, { mediaplans, brand }) {
  // утверждённый логотип бренда (PNG) — в шапку Excel; пока его нет, там текстовая подпись
  const logo = brand?.logo?.onLight?.mime === 'image/png' ? brand.logo.onLight.data : null;
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof DocError) return reply.code(400).send({ error: err.message });
    throw err;
  });

  const adminOnly = async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Нормативы меняет администратор' });
  };

  api.get('/admin/api/mediaplans', async () => ({ mediaplans: mediaplans.list(), models: MODELS, limits: LIMITS }));

  api.post('/admin/api/mediaplans', { schema: { body: planBody } }, async (req) => {
    const { title, client, leadId, spec } = req.body;
    return { mediaplan: mediaplans.create({ title, client, leadId, spec }, req.user.name) };
  });

  api.get('/admin/api/mediaplans/:id', { schema: { params: idParams } }, async (req) => ({ mediaplan: mediaplans.get(req.params.id) }));

  api.put('/admin/api/mediaplans/:id', { schema: { params: idParams, body: planBody }, bodyLimit: 200 * 1024 }, async (req) => ({
    mediaplan: mediaplans.update(req.params.id, req.body, req.user.name),
  }));

  api.post('/admin/api/mediaplans/:id/copy', { schema: { params: idParams } }, async (req) => {
    const p = mediaplans.get(req.params.id);
    return { mediaplan: mediaplans.create({ title: `${p.title} (копия)`.slice(0, 200), client: p.client, leadId: p.lead_id ?? null, spec: p.spec }, req.user.name) };
  });

  api.delete('/admin/api/mediaplans/:id', { schema: { params: idParams } }, async (req) => {
    mediaplans.remove(req.params.id);
    return { ok: true };
  });

  api.get('/admin/api/mediaplans/:id/xlsx', { schema: { params: idParams } }, async (req, reply) => {
    const plan = mediaplans.get(req.params.id);
    const buf = await mediaplanXlsx(plan, { benchmarks: mediaplans.usedBenchmarks(plan), author: req.user.name, logo });
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${slugify(plan.title)}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${plan.title}.xlsx`)}`)
      .send(buf);
  });

  // PDF (все сценарии) и картинки PNG/JPG (один сценарий) — в том же виде, что Excel
  api.get(
    '/admin/api/mediaplans/:id/export',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', required: ['format'], properties: { format: { type: 'string', enum: Object.keys(SHEET_FORMATS) }, scenario: { type: 'integer', minimum: 0 } } },
      },
    },
    async (req, reply) => {
      const plan = mediaplans.get(req.params.id);
      const { format } = req.query;
      const scenario = Math.min(req.query.scenario ?? 0, plan.spec.scenarios.length - 1);
      let buf;
      try {
        buf = await mediaplanSheetFile(plan, format, { brand, logo: brand?.logo?.onLight?.dataUri ?? null, author: req.user.name, scenario });
      } catch (err) {
        if (err instanceof BrowserUnavailable) return reply.code(503).send({ error: err.message });
        throw err;
      }
      const suffix = format === 'pdf' || plan.spec.scenarios.length === 1 ? '' : ` — ${plan.spec.scenarios[scenario].name}`;
      const name = `${plan.title}${suffix}.${format}`;
      return reply
        .header('content-type', SHEET_FORMATS[format])
        .header('content-disposition', `attachment; filename="${slugify(plan.title)}.${format}"; filename*=UTF-8''${encodeURIComponent(name)}`)
        .send(buf);
    },
  );

  api.post(
    '/admin/api/mediaplans/:id/to-document',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, properties: { scenario: { type: 'integer', minimum: 0 }, documentId: { type: 'integer' } } },
      },
    },
    async (req) => ({ document: mediaplans.toDocument(req.params.id, req.body, req.user) }),
  );

  // ---------- нормативы агентства ----------

  api.get('/admin/api/benchmarks', async () => ({ benchmarks: mediaplans.benchmarks() }));

  api.post('/admin/api/benchmarks', { preHandler: adminOnly, schema: { body: benchmarkBody } }, async (req) => ({
    benchmark: mediaplans.saveBenchmark(req.body, req.user.name),
  }));

  api.put('/admin/api/benchmarks/:id', { preHandler: adminOnly, schema: { params: idParams, body: benchmarkBody } }, async (req) => ({
    benchmark: mediaplans.saveBenchmark({ ...req.body, id: req.params.id }, req.user.name),
  }));

  api.delete('/admin/api/benchmarks/:id', { preHandler: adminOnly, schema: { params: idParams } }, async (req) => {
    mediaplans.removeBenchmark(req.params.id);
    return { ok: true };
  });
}
