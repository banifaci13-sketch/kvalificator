// Chromium для PDF и проверок вёрстки. Один процесс на сервер, закрывается после простоя,
// чтобы не держать память на маленьком сервере.

import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium-browser', // Alpine (Docker-образ)
  '/usr/bin/chromium',
  '/opt/pw-browsers/chromium',
].filter(Boolean);

const IDLE_MS = 60_000;
let browserPromise = null;
let idleTimer = null;
let users = 0;

/** Chromium нет или он не запускается — проверка и PDF недоступны, остальное работает. */
export class BrowserUnavailable extends Error {}

export function chromiumPath() {
  const path = CANDIDATES.find((p) => existsSync(p));
  if (!path) throw new BrowserUnavailable('На сервере нет Chromium — проверка и PDF недоступны. Обновите сервер: bash deploy/update.sh');
  return path;
}

/** Выполняет fn(page) на свежей странице; браузер переиспользуется. */
export async function withPage(fn, { viewport = { width: 1920, height: 1080 }, scale = 1 } = {}) {
  clearTimeout(idleTimer);
  users++;
  browserPromise ??= Promise.resolve()
    .then(() => chromium.launch({
      executablePath: chromiumPath(),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    }))
    .catch((err) => {
      // следующая попытка запустит браузер заново, а не вернёт ту же ошибку
      browserPromise = null;
      throw err instanceof BrowserUnavailable ? err : new BrowserUnavailable(`Chromium не запустился: ${err.message.split('\n')[0]}`);
    });
  let browser;
  try {
    browser = await browserPromise;
  } catch (err) {
    users--;
    throw err;
  }
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
  try {
    const page = await context.newPage();
    // Документ самодостаточный: любые внешние запросы — ошибка шаблона, не грузим их
    await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
    return await fn(page);
  } finally {
    await context.close();
    users--;
    if (!users) idleTimer = setTimeout(closeBrowser, IDLE_MS).unref();
  }
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const p = browserPromise;
  browserPromise = null;
  if (p) await (await p).close().catch(() => {});
}
