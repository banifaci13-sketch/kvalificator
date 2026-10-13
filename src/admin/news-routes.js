// API «Новостей» и файлов сотрудников. Файл приходит «как есть» в теле запроса (без multipart)
// и пишется на диск потоком; видео отдаётся кусками (Range), чтобы его можно было перематывать.

import { NewsError, NEWS_KINDS, REACTIONS } from '../news/store.js';
import { FileError, UPLOAD_TYPES, FILE_LIMITS } from '../files/store.js';

const idParams = { type: 'object', properties: { id: { type: 'integer' } } };
const postBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: Object.keys(NEWS_KINDS) },
    title: { type: ['string', 'null'], maxLength: 200 },
    body: { type: ['string', 'null'], maxLength: 10000 },
    link: { type: ['string', 'null'], maxLength: 1000 },
    clientId: { type: ['integer', 'null'] },
    caseTask: { type: ['string', 'null'], maxLength: 2000 },
    caseResult: { type: ['string', 'null'], maxLength: 2000 },
    pinned: { type: 'boolean' },
    verified: { type: 'boolean' },
    fileIds: { type: 'array', maxItems: 10, items: { type: 'integer' } },
  },
};

export async function newsRoutes(api, { news, files }) {
  api.setErrorHandler((err, req, reply) => {
    if (err instanceof NewsError) return reply.code(400).send({ error: err.message });
    if (err instanceof FileError) return reply.code(err.status).send({ error: err.message });
    throw err;
  });

  // ---------- файлы ----------
  if (files) {
    // тело не разбираем — сразу отдаём поток в хранилище (оно само следит за размером)
    api.removeContentTypeParser(['text/plain']);
    api.addContentTypeParser(UPLOAD_TYPES, (req, payload, done) => done(null, payload));
    const maxBytes = Math.max(...Object.values(FILE_LIMITS)) + 1024 * 1024;

    api.post('/admin/api/files', { bodyLimit: maxBytes, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      if (!req.body || typeof req.body.pipe !== 'function') throw new FileError('Нужен файл', 415);
      const name = (() => {
        try {
          return decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
        } catch {
          return '';
        }
      })();
      const f = await files.save(req.body, { mime: req.headers['content-type'], name, user: req.user });
      return { file: { id: f.id, mime: f.mime, kind: f.kind, name: f.name, bytes: f.bytes } };
    });

    api.get('/admin/api/files/:id', { schema: { params: idParams } }, async (req, reply) => {
      const f = files.get(req.params.id, req.user);
      const inline = f.kind !== 'doc' || f.mime === 'application/pdf';
      reply
        .header('content-type', f.mime)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, max-age=86400')
        .header('accept-ranges', 'bytes')
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      const size = files.size(f);
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range && (range[1] !== '' || range[2] !== '')) {
        let start;
        let end;
        if (range[1] === '') {
          start = Math.max(0, size - Number(range[2]));
          end = size - 1;
        } else {
          start = Number(range[1]);
          end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
        }
        if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
        const { stream } = files.open(f, { start, end });
        return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(stream);
      }
      const { stream } = files.open(f);
      return reply.header('content-length', size).send(stream);
    });
  }

  // ---------- новости ----------
  api.get('/admin/api/news', {
    schema: { querystring: { type: 'object', properties: { before: { type: 'integer' }, kind: { type: 'string', enum: Object.keys(NEWS_KINDS) }, pinned: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
  }, async (req) => {
    const page = news.list(req.user.id, req.query);
    // открыл ленту — счётчик новых в меню обнуляется
    if (!req.query.before && !req.query.pinned) news.markSeen(req.user.id);
    return { ...page, kinds: NEWS_KINDS, reactions: REACTIONS, uploads: files ? { limits: FILE_LIMITS, types: UPLOAD_TYPES } : null };
  });
  api.get('/admin/api/news/unseen', async (req) => ({ unseen: news.unseen(req.user.id) }));
  api.get('/admin/api/news/:id', { schema: { params: idParams } }, async (req) => ({ post: news.get(req.params.id, req.user.id), comments: news.comments(req.params.id) }));
  api.post('/admin/api/news', { schema: { body: postBody } }, async (req) => ({ post: news.create(req.body, req.user) }));
  api.patch('/admin/api/news/:id', { schema: { params: idParams, body: { ...postBody, minProperties: 1 } } }, async (req) => ({ post: news.update(req.params.id, req.body, req.user) }));
  api.delete('/admin/api/news/:id', { schema: { params: idParams } }, async (req) => {
    news.remove(req.params.id, req.user);
    return { ok: true };
  });
  api.post('/admin/api/news/:id/comments', {
    schema: { params: idParams, body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 3000 } } } },
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req) => ({ comments: news.addComment(req.params.id, req.body.text, req.user) }));
  api.delete('/admin/api/news/comments/:id', { schema: { params: idParams } }, async (req) => ({ comments: news.removeComment(req.params.id, req.user) }));
  api.post('/admin/api/news/:id/react', {
    schema: { params: idParams, body: { type: 'object', required: ['emoji'], additionalProperties: false, properties: { emoji: { type: 'string', maxLength: 8 } } } },
  }, async (req) => ({ reactions: news.react(req.params.id, req.body.emoji, req.user) }));
}
