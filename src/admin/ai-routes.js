// API ИИ-помощника для презентаций: черновик документа по брифу, правка слайда.
// В модель уходит обезличенный текст: без названия клиента, имён, телефонов и почты.

import { AiError } from '../ai/client.js';
import { KINDS, ACTIONS, draftDeck, rewriteSlide, createMask } from '../ai/decks.js';
import { DocError, leadValues, fillVariables } from '../docs/library.js';

// Ответы квалификатора, которые помогают стратегу и не раскрывают личность клиента
const SKIP_STEPS = new Set(['company', 'name', 'contact', 'consent', 'participants']);

function leadFacts(lead, scenario) {
  return scenario.steps
    .filter((st) => !SKIP_STEPS.has(st.id) && st.type !== 'consent' && lead.answers[st.id] != null)
    .map((st) => {
      const v = lead.answers[st.id];
      const text = typeof v === 'object' ? v.raw ?? '' : st.options?.find((o) => o.value === v)?.label ?? String(v);
      return [st.label ?? st.id, text];
    })
    .filter(([, t]) => t);
}

export async function aiRoutes(api, { ai, library, db, scenarioSource }) {
  const log = db.raw.prepare('INSERT INTO ai_log (user_id, action, provider, model, chars_in, chars_out, replaced, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const record = (req, action, { charsIn = 0, charsOut = 0, replaced = 0, error = null }) =>
    log.run(req.user.id, action, ai.provider, ai.model, charsIn, charsOut, replaced, error ? 0 : 1, error);

  api.setErrorHandler((err, req, reply) => {
    if (err instanceof AiError) return reply.code(502).send({ error: err.message });
    if (err instanceof DocError) return reply.code(400).send({ error: err.message });
    throw err;
  });

  const limit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  api.get('/admin/api/ai', async () => ({
    enabled: ai.enabled,
    provider: ai.provider,
    model: ai.model,
    kinds: KINDS,
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, a.label])),
  }));

  api.post(
    '/admin/api/ai/draft',
    {
      config: limit,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: Object.keys(KINDS) },
            brief: { type: 'string', maxLength: 6000 },
            slides: { type: 'integer', minimum: 4, maximum: 14 },
            leadId: { type: 'integer' },
            title: { type: 'string', maxLength: 200 },
            client: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req) => {
      const { kind = 'kp', brief = '', slides = 8, leadId, title, client = '' } = req.body;
      const scenario = scenarioSource.get();
      const lead = leadId ? db.getLead(leadId) : null;
      if (leadId && !lead) throw new DocError('Заявка не найдена');
      if (!lead && brief.trim().length < 15) throw new DocError('Опишите задачу хотя бы парой предложений или выберите заявку');
      const values = leadValues(lead, scenario, req.user);
      // клиент из поля формы важнее названия из заявки: его подставим в {{client}}, а в модель он не уйдёт
      if (client.trim()) values.client = client.trim();
      const mask = createMask({ client: values.client, contact: values.contact_name });
      const facts = lead ? leadFacts(lead, scenario) : [];
      let res;
      try {
        res = await draftDeck(ai, { kind, brief, facts, slides, mask });
      } catch (err) {
        record(req, 'draft', { charsIn: brief.length, error: err.message });
        throw err;
      }
      // {{client}}, {{date}}, {{manager}} — как в шаблонах; незаполненные поймает проверка
      const spec = fillVariables(res.spec, Object.fromEntries(Object.entries(values).filter(([, v]) => v)));
      const doc = library.createDocument({ spec, title: title || spec.meta.title, leadId: lead?.id ?? null }, req.user.name);
      record(req, 'draft', { charsIn: brief.length, charsOut: JSON.stringify(spec).length, replaced: res.replaced });
      req.log.info({ by: req.user.login, doc: doc.id, slides: spec.slides.length, replaced: res.replaced }, 'ИИ: черновик документа');
      return { document: doc, replaced: res.replaced };
    },
  );

  api.post(
    '/admin/api/ai/slide',
    {
      config: limit,
      schema: {
        body: {
          type: 'object',
          required: ['documentId', 'index', 'action'],
          additionalProperties: false,
          properties: {
            documentId: { type: 'integer' },
            index: { type: 'integer', minimum: 0 },
            action: { type: 'string', enum: Object.keys(ACTIONS) },
            instruction: { type: 'string', maxLength: 1000 },
          },
        },
      },
    },
    async (req) => {
      const doc = library.getDocument(req.body.documentId);
      const slide = doc.spec.slides[req.body.index];
      if (!slide) throw new DocError('Слайд не найден');
      const lead = doc.lead_id ? db.getLead(doc.lead_id) : null;
      const values = leadValues(lead, scenarioSource.get(), req.user);
      // документ без заявки: клиент — из поля «Клиент» титульного слайда
      const client = values.client || doc.spec.slides.find((s) => s.type === 'cover')?.client || '';
      const mask = createMask({ client, contact: values.contact_name });
      const charsIn = JSON.stringify(slide).length;
      try {
        const res = await rewriteSlide(ai, { slide, action: req.body.action, instruction: req.body.instruction ?? '', mask });
        record(req, `slide:${req.body.action}`, { charsIn, charsOut: JSON.stringify(res.slide).length, replaced: res.replaced });
        return res;
      } catch (err) {
        record(req, `slide:${req.body.action}`, { charsIn, error: err.message });
        throw err;
      }
    },
  );
}
