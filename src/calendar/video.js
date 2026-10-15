// Ссылки на онлайн-встречи: Zoom (приложение Server-to-Server OAuth) и Яндекс Телемост (OAuth-токен
// приложения с правом telemost-api:conferences.create; API Телемоста доступен организациям Яндекс 360).
// Ключи — только в .env на сервере.

export class VideoError extends Error {}

const TIMEOUT = 15_000;

export function createVideo(config, { fetchImpl = fetch } = {}) {
  const zoom = config.zoom?.accountId && config.zoom?.clientId && config.zoom?.clientSecret ? config.zoom : null;
  const telemost = config.telemost?.token ? config.telemost : null;
  let zoomToken = null;

  async function call(url, init, service) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (err) {
      throw new VideoError(`${service} не отвечает: ${err.name === 'TimeoutError' ? 'нет ответа 15 секунд' : err.message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body.message || body.description || body.error_description || body.error || `код ${res.status}`;
      throw new VideoError(`${service}: ${reason}`);
    }
    return body;
  }

  async function zoomAccessToken() {
    if (zoomToken && zoomToken.until > Date.now()) return zoomToken.value;
    const basic = Buffer.from(`${zoom.clientId}:${zoom.clientSecret}`).toString('base64');
    const body = await call(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(zoom.accountId)}`,
      { method: 'POST', headers: { authorization: `Basic ${basic}` } },
      'Zoom',
    );
    // запас минута: токен живёт час
    zoomToken = { value: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
    return zoomToken.value;
  }

  return {
    available: { zoom: Boolean(zoom), telemost: Boolean(telemost) },

    /** { title, start: Date, duration, agenda, recurring } → { provider, link, hostLink, externalId } */
    async create(provider, { title, start, duration, agenda, recurring = false }) {
      if (provider === 'zoom') {
        if (!zoom) throw new VideoError('Zoom не подключён: нужны ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID и ZOOM_CLIENT_SECRET');
        const token = await zoomAccessToken();
        // время по Москве без «Z» плюс часовой пояс — так Zoom не сдвигает встречу
        const local = new Date(start.getTime() + 3 * 3600_000).toISOString().slice(0, 19);
        const m = await call(
          `https://api.zoom.us/v2/users/${encodeURIComponent(zoom.user || 'me')}/meetings`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              topic: title.slice(0, 200),
              // регулярная встреча — одна постоянная ссылка: повторяющаяся встреча Zoom без фиксированного времени
              ...(recurring ? { type: 3 } : { type: 2, start_time: local }),
              timezone: 'Europe/Moscow',
              duration,
              agenda: agenda?.slice(0, 2000) || undefined,
              settings: { join_before_host: false, waiting_room: true },
            }),
          },
          'Zoom',
        );
        if (!m.join_url) throw new VideoError('Zoom не вернул ссылку на встречу');
        return { provider, link: m.join_url, hostLink: m.start_url ?? null, externalId: m.id != null ? String(m.id) : null };
      }
      if (provider === 'telemost') {
        if (!telemost) throw new VideoError('Телемост не подключён: нужен TELEMOST_TOKEN');
        const c = await call(
          'https://cloud-api.yandex.net/v1/telemost-api/conferences',
          {
            method: 'POST',
            headers: { authorization: `OAuth ${telemost.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ waiting_room_level: telemost.waitingRoom || 'PUBLIC' }),
          },
          'Телемост',
        );
        if (!c.join_url) throw new VideoError('Телемост не вернул ссылку на встречу');
        return { provider, link: c.join_url, hostLink: null, externalId: c.id ?? null };
      }
      throw new VideoError('Неизвестный сервис видеосвязи');
    },
  };
}
