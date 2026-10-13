#!/usr/bin/env bash
# Установка квалификатора на чистый сервер Ubuntu 22.04/24.04.
# Запуск из папки проекта:  sudo bash deploy/install.sh
# Повторный запуск безопасен: существующий .env не перезаписывается без вашего согласия.

set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local q="$1" def="${2:-}" ans; read -r -p "$q${def:+ [$def]}: " ans; echo "${ans:-$def}"; }
ask_secret() { local q="$1" ans; read -r -s -p "$q: " ans; echo >&2; echo "$ans"; }

[[ $EUID -eq 0 ]] || die "Запустите от root: sudo bash deploy/install.sh"
[[ -f docker-compose.yml ]] || die "Запускайте из папки проекта (где лежит docker-compose.yml)"

# ---------- 1. Docker ----------
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Ставлю Docker из репозитория Ubuntu"
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 cron curl
  systemctl enable --now docker
else
  say "Docker уже установлен"
fi

# ---------- 2. Настройки ----------
write_env=yes
if [[ -f .env ]]; then
  [[ "$(ask 'Файл .env уже есть. Перезаписать? (yes/no)' no)" == yes ]] || write_env=no
fi

if [[ $write_env == yes ]]; then
  say "Настройки (Enter — пропустить необязательное)"
  DOMAIN=$(ask "Домен, на котором будет работать квалификатор (например kval.soroka-marketing.ru)")
  [[ -n "$DOMAIN" ]] || die "Домен обязателен"
  SITE=$(ask "Сайт, на который ставится виджет" "https://soroka-marketing.ru")
  ADMIN_EMAIL=$(ask "Ваша почта для входа в админку")
  PRIVACY=$(ask "Ссылка на политику обработки персональных данных" "$SITE/privacy")
  TG_TOKEN=$(ask "Токен Telegram-бота от @BotFather")
  TG_CHAT=$(ask "ID чата менеджеров в Telegram")
  TG_TEST=$(ask "ID тестового чата в Telegram")
  YA_ID=$(ask "Яндекс ID: ClientID приложения (oauth.yandex.ru)")
  YA_SECRET=""
  [[ -n "$YA_ID" ]] && YA_SECRET=$(ask_secret "Яндекс ID: Client secret")
  DOMAINS=$(ask "Почтовые домены сотрудников для входа через Яндекс без приглашения" "")

  for v in "$YA_SECRET" "$TG_TOKEN"; do [[ "$v" != *"'"* ]] || die "Секреты не должны содержать одинарную кавычку"; done
  www="${SITE/https:\/\//https://www.}"
  umask 077
  cat > .env <<ENV
DOMAIN=$DOMAIN
PUBLIC_URL=https://$DOMAIN
ALLOWED_ORIGINS=$SITE,$www,https://$DOMAIN
PRIVACY_POLICY_URL=$PRIVACY
LOG_LEVEL=info

ADMIN_ALLOWED_DOMAINS=$DOMAINS
YANDEX_CLIENT_ID=$YA_ID
YANDEX_CLIENT_SECRET='$YA_SECRET'

TELEGRAM_BOT_TOKEN='$TG_TOKEN'
TELEGRAM_MANAGER_CHAT_ID=$TG_CHAT
TELEGRAM_TEST_CHAT_ID=$TG_TEST

SCENARIO_CSV_URL=
LEAD_WEBHOOK_URL=
LEAD_WEBHOOK_SECRET=
ENV
  umask 022
  say ".env сохранён (доступен только root)"
fi

DOMAIN=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)

# ---------- 3. Проверка DNS ----------
say "Проверяю, что $DOMAIN указывает на этот сервер"
server_ip=$(curl -fsS4 --max-time 10 https://api.ipify.org || true)
domain_ip=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')
if [[ -z "$domain_ip" ]]; then
  warn "Домен $DOMAIN пока не резолвится. Добавьте A-запись на ${server_ip:-IP сервера} и подождите — HTTPS заработает, когда DNS обновится."
elif [[ -n "$server_ip" && "$domain_ip" != "$server_ip" ]]; then
  warn "$DOMAIN указывает на $domain_ip, а у сервера IP $server_ip. Проверьте A-запись."
else
  echo "  ✓ $DOMAIN → $domain_ip"
fi

# ---------- 4. Файрвол ----------
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null
  echo "  ✓ ufw: открыты 22, 80, 443"
fi

# ---------- 5. Запуск ----------
mkdir -p data
chown -R 1000:1000 data   # в контейнере сервер работает от пользователя node (uid 1000)
say "Собираю и запускаю (первый раз — пара минут)"
docker compose up -d --build

say "Жду, пока сервер ответит"
for _ in $(seq 1 30); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[[ ${ok:-0} == 1 ]] || { docker compose logs --tail 50 app; die "Сервер не запустился — см. лог выше"; }
echo "  ✓ сервер работает"

# ---------- 6. Первый сотрудник ----------
if [[ -n "${ADMIN_EMAIL:-}" ]]; then
  say "Создаю доступ в админку для $ADMIN_EMAIL"
  # Без терминала команда сама генерирует пароль и печатает его один раз
  if docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/admin.js add "$ADMIN_EMAIL" "$ADMIN_EMAIL" --password </dev/null; then
    warn "Сохраните пароль выше: он показывается один раз. Сменить: docker compose exec app node scripts/admin.js passwd $ADMIN_EMAIL"
  fi
fi

# ---------- 7. Ежедневный бэкап ----------
project=$(pwd)
cat > /etc/cron.d/kvalificator-backup <<CRON
# Копия базы квалификатора каждый день в 03:17, хранится 14 последних
17 3 * * * root cd $project && docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/backup.js --keep 14 >> /var/log/kvalificator-backup.log 2>&1
CRON
echo "  ✓ бэкап базы каждый день в 03:17 → $project/data/backups"

# ---------- 8. Проверка настроек ----------
say "Проверка настроек"
docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/check.js || true

cat <<DONE

Готово.
  Админка:       https://$DOMAIN/admin/
  Демо виджета:  https://$DOMAIN/demo.html
  Код виджета для сайта:
    <script src="https://$DOMAIN/widget.js" defer></script>

  Обновление:          sudo bash deploy/update.sh
  Сотрудники:          docker compose exec app node scripts/admin.js list
  Тестовая карточка:   docker compose exec app node scripts/check.js --send-test
DONE
