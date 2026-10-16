#!/usr/bin/env bash
# Автообновление: раз в 5 минут проверяет ветку на GitHub и, если там есть новые изменения,
# запускает обычное обновление (deploy/update.sh: бэкап → git pull → пересборка → перезапуск).
#
#   bash deploy/auto-update.sh --install   — включить (cron каждые 5 минут, журнал /var/log/kvalificator-update.log)
#   bash deploy/auto-update.sh --remove    — выключить
#   bash deploy/auto-update.sh             — проверить и обновить сейчас (так его и вызывает cron)
set -euo pipefail
cd "$(dirname "$0")/.."
project=$(pwd)
cron=/etc/cron.d/kvalificator-autoupdate

case "${1:-}" in
  --install)
    cat > "$cron" <<CRON
# Автообновление кабинета из GitHub каждые 5 минут (deploy/auto-update.sh)
*/5 * * * * root bash $project/deploy/auto-update.sh >> /var/log/kvalificator-update.log 2>&1
CRON
    echo "✓ Автообновление включено: каждые 5 минут. Журнал: /var/log/kvalificator-update.log"
    exit 0
    ;;
  --remove)
    rm -f "$cron"
    echo "✓ Автообновление выключено"
    exit 0
    ;;
esac

# одно обновление за раз: если предыдущее ещё идёт — выходим
exec 9>/tmp/kvalificator-auto-update.lock
flock -n 9 || exit 0

branch=$(git rev-parse --abbrev-ref HEAD)
git fetch -q origin "$branch"
[[ "$(git rev-parse HEAD)" == "$(git rev-parse FETCH_HEAD)" ]] && exit 0

echo "$(date '+%F %T') ▸ новые изменения в $branch:"
git log --oneline HEAD..FETCH_HEAD | head -10
bash deploy/update.sh
echo "$(date '+%F %T') ✓ обновлено до $(git rev-parse --short HEAD)"
