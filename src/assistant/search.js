// Поиск в интернете для ассистента — Yandex Search API (сервис Yandex Cloud, работает из России).
// Два способа подряд, как в боте «Сара»: новый API v2 (POST, JSON) и, если он недоступен, XML-выдача (GET).
// Ответ — несколько результатов: заголовок, адрес, фрагмент текста.

export class SearchError extends Error {}

const TIMEOUT = 15_000;

const decodeEntities = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** Результаты из XML-выдачи Яндекса: <doc> с <url>, <title>, <passages>/<headline>. */
export function parseYandexXml(xml) {
  const error = /<error[^>]*>([\s\S]*?)<\/error>/i.exec(xml);
  if (error && !/<doc[\s>]/i.test(xml)) throw new SearchError(`Поиск Яндекса: ${decodeEntities(error[1])}`);
  const docs = [];
  for (const m of xml.matchAll(/<doc[\s>][\s\S]*?<\/doc>/gi)) {
    const d = m[0];
    const url = /<url>([\s\S]*?)<\/url>/i.exec(d)?.[1];
    if (!url) continue;
    const title = decodeEntities(/<title>([\s\S]*?)<\/title>/i.exec(d)?.[1] ?? url);
    const passages = [...d.matchAll(/<passage>([\s\S]*?)<\/passage>/gi)].map((p) => decodeEntities(p[1]));
    const headline = decodeEntities(/<headline>([\s\S]*?)<\/headline>/i.exec(d)?.[1] ?? '');
    docs.push({ title, url: decodeEntities(url), snippet: (passages.join(' … ') || headline).slice(0, 600) });
  }
  return docs;
}

export function createSearch(config, { fetchImpl = fetch } = {}) {
  const { apiKey, folderId } = config ?? {};
  if (!apiKey || !folderId) {
    return {
      enabled: false,
      search: async () => {
        throw new SearchError('Поиск в интернете не подключён: нужен ключ Yandex Cloud с ролью search-api.webSearch.user');
      },
    };
  }

  async function v2(query, count) {
    const res = await fetchImpl('https://searchapi.api.cloud.yandex.net/v2/web/search', {
      method: 'POST',
      headers: { authorization: `Api-Key ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: { searchType: 'SEARCH_TYPE_RU', queryText: query, familyMode: 'FAMILY_MODE_MODERATE' },
        folderId,
        responseFormat: 'FORMAT_XML',
        groupSpec: { groupMode: 'GROUP_MODE_DEEP', groupsOnPage: String(count), docsInGroup: '1' },
        l10n: 'LOCALIZATION_RU',
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new SearchError(body.message ?? `код ${res.status}`);
    if (!body.rawData) throw new SearchError('пустой ответ');
    // ответ в base64; кириллицу собираем из байтов как UTF-8
    return parseYandexXml(Buffer.from(body.rawData, 'base64').toString('utf8'));
  }

  async function xml(query, count) {
    const url = new URL('https://yandex.ru/search/xml');
    url.search = new URLSearchParams({
      folderid: folderId,
      apikey: apiKey,
      query,
      l10n: 'ru',
      sortby: 'rlv',
      filter: 'moderate',
      groupby: `attr=d.mode=deep.groups-on-page=${count}.docs-in-group=1`,
    }).toString();
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const text = await res.text();
    if (!res.ok) throw new SearchError(`код ${res.status}`);
    return parseYandexXml(text);
  }

  return {
    enabled: true,
    /** Поиск: { results: [{ title, url, snippet }] }. */
    async search(query, { count = 5 } = {}) {
      const q = String(query).trim().slice(0, 400);
      if (!q) throw new SearchError('Пустой запрос');
      let first;
      try {
        return { results: (await v2(q, count)).slice(0, count) };
      } catch (err) {
        first = err;
      }
      try {
        return { results: (await xml(q, count)).slice(0, count) };
      } catch (err) {
        throw new SearchError(`Поиск Яндекса не ответил: ${first.message}; ${err.message}`);
      }
    },
  };
}
