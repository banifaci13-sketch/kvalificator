#!/usr/bin/env bash
# Обновление до свежей версии из GitHub: sudo bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ Бэкап базы перед обновлением"
docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/backup.js --keep 14 || echo "! бэкап не сделан (сервер не запущен?)"

echo "▸ Загружаю изменения"
git pull --ff-only

# Лимит загрузки в nginx (наш сайт, другие не трогаем): фото, видео и вложения — до 120 МБ
for site in /etc/nginx/sites-available/kvalificator.conf /etc/nginx/conf.d/kvalificator.conf; do
  [[ -f "$site" ]] || continue
  if grep -qE 'client_max_body_size[[:space:]]+2m;' "$site"; then
    cp "$site" /tmp/kval-nginx.bak
    sed -i -E 's/client_max_body_size[[:space:]]+2m;/client_max_body_size 120m;/' "$site"
    if nginx -t 2>/dev/null; then
      systemctl reload nginx && echo "▸ nginx: загрузка файлов до 120 МБ"
    else
      cp /tmp/kval-nginx.bak "$site"
      echo "! nginx не принял новый лимит загрузки — оставил как было"
    fi
  fi
done

echo "▸ Пересобираю и перезапускаю"
docker compose up -d --build
docker image prune -f >/dev/null

echo "▸ Проверка"
# на небольшом сервере запуск и обновление базы занимают время — ждём до минуты
for i in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/health 2>/dev/null; then
    echo " — сервер работает"
    exit 0
  fi
  sleep 2
done
echo "! Сервер не ответил за минуту. Последние строки журнала:"
docker compose ps
docker compose logs --tail=60 app
exit 1
