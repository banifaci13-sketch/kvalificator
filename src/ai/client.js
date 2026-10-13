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

  async function call(url, init, name) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      throw new AiError(`${name} не ответил: ${err.name === 'TimeoutError' ? 'нет ответа 2 минуты' : err.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AiError(`${name}: ${body.error?.message ?? body.message ?? body.error ?? `код ${res.status}`}`);
    return body;
  }

  return {
    enabled: true,
    provider,
    model,
    /** system — инструкция; user — запрос. Возвращает { text, usage }. */
    async complete({ system, user, maxTokens = 4000, temperature = 0.3 }) {
      if (provider === 'yandexgpt') {
        const body = await call(
          'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
          {
            method: 'POST',
            headers: { authorization: `Api-Key ${config.yandexApiKey}`, 'x-folder-id': config.yandexFolderId, 'content-type': 'application/json' },
            body: JSON.stringify({
              modelUri: `gpt://${config.yandexFolderId}/${model}`,
              completionOptions: { stream: false, temperature, maxTokens: String(maxTokens) },
              messages: [
                { role: 'system', text: system },
                { role: 'user', text: user },
              ],
            }),
          },
          'YandexGPT',
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
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
        },
        'Claude',
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
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AiError('ИИ ответил не в том формате — попробуйте ещё раз');
  }
}
