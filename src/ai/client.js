// Языковая модель для помощника: YandexGPT (Yandex Cloud, данные остаются в России) или Claude.
// Выбор — AI_PROVIDER или по тому, какой ключ задан. Ключи — только в .env на сервере.

export class AiError extends Error {}

const TIMEOUT = 120_000;

export function createAi(config, { fetchImpl = fetch } = {}) {
  const provider = config?.provider ?? null;
  const ready =
    (provider === 'yandexgpt' && config.yandexApiKey && config.yandexFolderId) ||
    (provider === 'anthropic' && config.anthropicApiKey);
  if (!ready) return { enabled: false, provider: null, model: null, complete: async () => { throw new AiError('ИИ не подключён: задайте ключ YandexGPT или Claude в настройках сервера'); } };

  const model = provider === 'yandexgpt' ? config.yandexModel : config.anthropicModel;

  async function call(url, init, name, timeoutMs = TIMEOUT) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new AiError(`${name} не ответил: ${err.name === 'TimeoutError' ? `нет ответа ${Math.round(timeoutMs / 1000)} с` : err.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AiError(`${name}: ${body.error?.message ?? body.message ?? body.error ?? `код ${res.status}`}`);
    return body;
  }

  return {
    enabled: true,
    provider,
    model,
    /**
     * system — инструкция; user — запрос; history — прошлые реплики диалога [{ role: 'user'|'assistant', text }];
     * lite — лёгкая модель (быстрый разбор поручений). Возвращает { text, usage }.
     */
    async complete({ system, user, history = [], maxTokens = 4000, temperature = 0.3, lite = false, timeoutMs = TIMEOUT }) {
      const turns = [...history.filter((m) => m.text), { role: 'user', text: user }];
      if (provider === 'yandexgpt') {
        const uri = lite && config.yandexLiteModel ? config.yandexLiteModel : model;
        const body = await call(
          'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
          {
            method: 'POST',
            headers: { authorization: `Api-Key ${config.yandexApiKey}`, 'x-folder-id': config.yandexFolderId, 'content-type': 'application/json' },
            body: JSON.stringify({
              modelUri: `gpt://${config.yandexFolderId}/${uri}`,
              completionOptions: { stream: false, temperature, maxTokens: String(maxTokens) },
              messages: [{ role: 'system', text: system }, ...turns.map((m) => ({ role: m.role, text: m.text }))],
            }),
          },
          'YandexGPT',
          timeoutMs,
        );
        const text = body.result?.alternatives?.[0]?.message?.text;
        if (!text) throw new AiError('YandexGPT вернул пустой ответ');
        return { text, usage: body.result?.usage ?? null };
      }
      const body = await call(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: { 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: turns.map((m) => ({ role: m.role, content: m.text })) }),
        },
        'Claude',
        timeoutMs,
      );
      const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (!text) throw new AiError('Claude вернул пустой ответ');
      return { text, usage: body.usage ?? null };
    },
  };
}

/** JSON из ответа модели: без обёртки ```json и пояснений вокруг. */
export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AiError('ИИ ответил не в том формате — попробуйте ещё раз');
  const body = text.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    // частые огрехи моделей: запятая перед скобкой, «умные» кавычки вокруг ключей
    try {
      return JSON.parse(body.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"'));
    } catch {
      throw new AiError('ИИ ответил не в том формате — попробуйте ещё раз');
    }
  }
}
