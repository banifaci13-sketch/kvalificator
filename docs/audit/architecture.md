# Архитектура: как есть и куда встраивать новое

## Как устроено сейчас

```
браузер (admin/*.js, без фреймворка; опрос раз в 3–20 с)        сайт: widget/widget.js     Telegram
        │ JSON, cookie kval_admin                                      │                       │
        ▼                                                              ▼                       ▼
src/http/server.js — Fastify: CORS, rate-limit (по сессии / IP), статика, API виджета     src/channels/telegram.js
        │
        ├── src/admin/routes.js — вход, сессии, CSP, область «нужен вход» (onRequest: requireUser)
        │      ├── crm-routes.js        → src/crm/store.js (клиенты, доски, задачи, чек-листы, вложения)
        │      │                          src/crm/money.js (счета, оплаты, напоминания)
        │      ├── calendar-routes.js   → src/calendar/store.js, video.js (Zoom, Телемост), assistant/followup.js
        │      ├── docs-routes.js       → src/docs/* (library, templates, build, render-html/pptx, qa, media, browser)
        │      ├── mediaplan-routes.js  → src/mediaplan/* (calc, store, xlsx, sheet)
        │      ├── ai-routes.js         → src/ai/client.js (YandexGPT | Claude), ai/decks.js
        │      ├── assistant-routes.js  → src/assistant/* (phrases → commands → actions; kb; search; when)
        │      ├── news-routes.js       → src/news/store.js, src/files/store.js
        │      └── chat-routes.js       → src/chat/store.js
        │
        ├── src/core/* — квалификатор (сценарий, движок, оценка); src/notify/* — Telegram, вебхук, колокольчик
        └── src/storage/db.js — node:sqlite, 25 миграций (PRAGMA user_version), WAL, foreign_keys, busy_timeout 5 с

Фон (src/index.js, setInterval в том же процессе):
  досылка лидов (5 мин) · счета и напоминания об оплате (1 ч) · напоминания о встречах и план дня (1 мин)
  · обновление вопросов из Google Таблицы · горячий лид → задача (по событию)

Данные на диске (том ./data): kvalificator.db (+wal) · files/ · media/ · documents/<id>/ · backups/
```

**Стиль модулей.** Фабрика `createX({ db, … })` возвращает функции. SQL-запросы подготовлены заранее, строки в
них не склеиваются. Ошибки предметной области — свой класс (`CrmError`, `ChatError`, …), маршрут превращает их
в 400. Новые модули нужно писать так же.

**Время.**

- Встречи хранятся в UTC, интерфейс показывает их по Москве.
- Сроки задач — дата и время по Москве (`due`, `due_time`), дедлайн считается как `…+03:00`.
- Служебные метки — `datetime('now')`, то есть UTC.

Менять это не нужно. Для данных из Директа и Метрики — хранить дату отчёта, как её отдаёт API, и часовой пояс
кабинета в метаданных.

## Куда встраиваются модули из ТЗ

| Модуль ТЗ | Где | Опирается на | Новые таблицы (миграции 26+) |
|---|---|---|---|
| Состояние системы (эт. 1) | `src/ops/status.js`, маршрут в `routes.js` (область `staff`), `admin/system.js` | `scripts/backup.js`, фоновые задачи из `src/index.js` | нет: статус бэкапа — файл `data/backups/status.json`; отметки фоновых задач — в памяти |
| Бэкап файлов и проверка восстановления (эт. 1) | `scripts/backup.js`, `scripts/restore-check.js`, `deploy/install.sh` (cron) | `VACUUM INTO`, контентная адресация файлов (sha256 — файл не меняется) | нет |
| Очередь фоновых заданий (эт. 1–3) | `src/jobs/queue.js` (SQLite) | `db.js`, `src/index.js` | `jobs` |
| Журнал действий и корзина (эт. 1–2) | `src/audit/log.js` | store-модули | `audit_log`; `deleted_at` у `documents` и `mediaplans` |
| Контекст клиента (эт. 2) | `src/assistant/context.js` | `crm`, `calendar`, `money` (уже с правами), `kb`, `mediaplans`, `library` | нет (собирается запросами); кэш — в памяти |
| Инструменты ассистента и предпросмотр (эт. 2) | `src/assistant/tools.js` поверх `actions.js` | `phrases.js` → `commands.js` → `actions.js` | `assistant_runs` (без текстов) |
| Директ и Метрика (эт. 3) | `src/ads/direct.js`, `src/ads/metrika.js`, `src/ads/sync.js`, `src/admin/ads-routes.js` | очередь, шифрование токенов (`node:crypto`, ключ в `.env`) | `ad_connections`, `ad_sync_runs`, `ad_stats_daily`, `ad_goals` |
| KPI и отчёты (эт. 4) | `src/ads/kpi.js`, `admin/kpi.js`; отчёт — новый шаблон в `templates/decks` + `src/docs/library.js` | `ad_stats_daily`, `mediaplans` | `report_snapshots` |
| Сквозной процесс (эт. 5) | расширение `src/assistant/kb.js` (регламент → задачи) и `crm` | существующие регламенты, `task_links` | `client_stage` или поле у `clients` |
| Сигналы (эт. 6) | `src/ads/alerts.js` | KPI, `notify`, `crm.createTask` | `alerts` |
| Главная по ролям (эт. 7) | `admin/home.js` — набор карточек по настройке пользователя | `/admin/api/home` | нет (настройка в `prefs`) |

## Зависимости

```
аудит ─▶ бэкапы + состояние системы ─▶ очередь ─▶ Директ/Метрика (только чтение) ─▶ KPI ─▶ отчёты ─▶ сигналы
      └▶ журнал действий ─▶ инструменты ассистента + предпросмотр ─▶ контекст клиента ─▶ многошаговые сценарии
```

Ветка ассистента от рекламной ветки не зависит. Её можно вести параллельно, пока Яндекс рассматривает заявку
на доступ к API Директа.
