// Вход через Яндекс ID (OAuth 2.0, authorization code).
// Приложение регистрируется на https://oauth.yandex.ru/client/new с доступами
// «Доступ к адресу электронной почты» и «Доступ к логину, имени и фамилии».

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';
const INFO_URL = 'https://login.yandex.ru/info?format=json';

export function createYandexOAuth({ clientId, clientSecret, redirectUri }) {
  return {
    authorizeUrl(state) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'login:email login:info',
        state,
      });
      return `${AUTHORIZE_URL}?${params}`;
    },

    /** Код из callback → профиль пользователя Яндекса. */
    async fetchProfile(code) {
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret }),
        signal: AbortSignal.timeout(15_000),
      });
      const token = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !token.access_token) {
        throw new Error(`Яндекс не выдал токен: ${token.error_description ?? token.error ?? tokenRes.status}`);
      }
      const infoRes = await fetch(INFO_URL, {
        headers: { authorization: `OAuth ${token.access_token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!infoRes.ok) throw new Error(`Яндекс не отдал профиль: HTTP ${infoRes.status}`);
      return infoRes.json();
    },
  };
}
