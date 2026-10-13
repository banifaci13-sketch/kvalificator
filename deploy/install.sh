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

# ---------- 0. Подкачка для маленьких серверов ----------
# На 1 ГБ памяти сборка образа и генерация PDF могут упасть без swap
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [[ $mem_mb -lt 2000 ]] && ! swapon --show | grep -q .; then
  say "Памяти ${mem_mb} МБ — добавляю файл подкачки 2 ГБ"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -qw vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-kvalificator.conf
fi

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
  ADMIN_LOGIN=$(ask "Логин администратора админки (латиница или e-mail)" "admin")
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
# getent возвращает ошибку, если домен ещё не резолвится, — это не повод прерывать установку
domain_ip=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
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

# ---------- 5. HTTPS: Caddy или уже установленный nginx ----------
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
env_get() { { grep -E "^$1=" .env || true; } | cut -d= -f2-; }

proxy_mode=caddy
busy=$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy || true)
if [[ -n "$busy" ]]; then
  if systemctl is-active --quiet nginx 2>/dev/null; then
    warn "На сервере работает nginx (порты 80/443 заняты им)."
    echo "    1 — работать через ваш nginx: квалификатор добавится как ещё один сайт, другие проекты не затрагиваются"
    echo "    2 — отключить nginx: только если на сервере больше нет сайтов"
    if [[ "$(ask "Ваш выбор" 1)" == 2 ]]; then
      systemctl disable --now nginx && echo "  ✓ nginx остановлен"
    else
      proxy_mode=nginx
    fi
  else
    warn "Порты 80/443 заняты другой программой:"
    echo "$busy" | sed 's/^/    /'
    for svc in apache2 httpd caddy lighttpd; do
      if systemctl is-active --quiet "$svc" 2>/dev/null && [[ "$(ask "Остановить и отключить $svc? (yes/no)" no)" == yes ]]; then
        systemctl disable --now "$svc" && echo "  ✓ $svc остановлен"
      fi
    done
  fi
  if [[ $proxy_mode == caddy ]]; then
    busy=$(ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v docker-proxy || true)
    [[ -z "$busy" ]] || die "Порты 80/443 всё ещё заняты. Освободите их или настройте прокси вручную (README → Развёртывание)."
  fi
fi

# Локальный порт приложения: 3100 или следующий свободный (на сервере могут быть другие проекты)
app_port=$(env_get APP_PORT); app_port=${app_port:-3100}
ours=$(docker compose port app 3000 2>/dev/null || true)
while ss -ltnH "( sport = :$app_port )" 2>/dev/null | grep -q . && [[ "$ours" != "127.0.0.1:$app_port" ]]; do
  app_port=$((app_port + 1))
done
set_env APP_PORT "$app_port"

if [[ $proxy_mode == nginx ]]; then
  set_env COMPOSE_PROFILES ""
  docker compose --profile caddy rm -sf caddy >/dev/null 2>&1 || true
  if [[ -d /etc/nginx/sites-available ]]; then
    site=/etc/nginx/sites-available/kvalificator.conf
    link=/etc/nginx/sites-enabled/kvalificator.conf
  else
    site=/etc/nginx/conf.d/kvalificator.conf
    link=""
  fi
  if [[ -f "$site" ]] && grep -q "managed by Certbot" "$site"; then
    # Конфиг уже дополнен certbot (HTTPS) — меняем только порт приложения
    sed -i -E "s|proxy_pass http://127\.0\.0\.1:[0-9]+;|proxy_pass http://127.0.0.1:$app_port;|" "$site"
  else
    cat > "$site" <<NGINX
# Квалификатор Soroka (deploy/install.sh). HTTPS добавляет certbot.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    client_max_body_size 120m;

    location / {
        proxy_pass http://127.0.0.1:$app_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGINX
  fi
  [[ -n "$link" ]] && ln -sf "$site" "$link"
  if ! nginx -t 2>/tmp/kval-nginx-test.log; then
    # Не ломаем другие сайты: убираем наш конфиг, если nginx его не принял
    rm -f "$site" ${link:+"$link"}
    cat /tmp/kval-nginx-test.log
    die "nginx не принял конфигурацию квалификатора — она удалена, другие сайты не затронуты. Пришлите вывод выше."
  fi
  systemctl reload nginx
  echo "  ✓ nginx: $DOMAIN → 127.0.0.1:$app_port ($site)"
else
  set_env COMPOSE_PROFILES caddy
fi

# ---------- 6. Запуск ----------
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

# ---------- 7. Первый администратор ----------
# Спрашиваем, если в админке ещё никого нет (в том числе при повторном запуске с прежним .env)
admin_cli() { docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/admin.js "$@" </dev/null; }
if [[ -z "$(admin_cli list 2>/dev/null)" && -z "${ADMIN_LOGIN:-}" ]]; then
  ADMIN_LOGIN=$(ask "Логин администратора админки (латиница или e-mail)" "admin")
fi
if [[ -n "${ADMIN_LOGIN:-}" && -z "$(admin_cli list 2>/dev/null)" ]]; then
  say "Создаю администратора $ADMIN_LOGIN"
  # Без терминала команда сама генерирует пароль и печатает его один раз
  if admin_cli add "$ADMIN_LOGIN" "Администратор" --admin; then
    warn "Сохраните пароль выше: он показывается один раз. Новый пароль: docker compose exec app node scripts/admin.js passwd $ADMIN_LOGIN"
  fi
fi

# ---------- HTTPS-сертификат для режима nginx ----------
if [[ $proxy_mode == nginx ]]; then
  if ! command -v certbot >/dev/null || ! dpkg -s python3-certbot-nginx >/dev/null 2>&1; then
    say "Ставлю certbot (сертификаты Let's Encrypt для nginx)"
    apt-get install -y -qq certbot python3-certbot-nginx
  fi
  if certbot certificates 2>/dev/null | grep -q "Domains:.*\b$DOMAIN\b"; then
    echo "  ✓ сертификат для $DOMAIN уже есть"
  elif [[ -n "$domain_ip" && "$domain_ip" == "$server_ip" ]]; then
    domains=(-d "$DOMAIN")
    www_ip=$(getent ahostsv4 "www.$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
    [[ "$www_ip" == "$server_ip" ]] && domains+=(-d "www.$DOMAIN")
    say "Выпускаю HTTPS-сертификат для ${domains[*]//-d /}"
    certbot --nginx "${domains[@]}" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
      || warn "Сертификат не выпущен. Повторите позже: certbot --nginx ${domains[*]} --redirect"
  else
    warn "DNS ещё не указывает на сервер — сертификат выпустите позже командой: certbot --nginx -d $DOMAIN -d www.$DOMAIN --redirect"
  fi
fi

# ---------- 8. Ежедневный бэкап ----------
project=$(pwd)
cat > /etc/cron.d/kvalificator-backup <<CRON
# Копия базы квалификатора каждый день в 03:17, хранится 14 последних
17 3 * * * root cd $project && docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/backup.js --keep 14 >> /var/log/kvalificator-backup.log 2>&1
CRON
echo "  ✓ бэкап базы каждый день в 03:17 → $project/data/backups"

# ---------- 9. Проверка настроек ----------
say "Проверка настроек"
docker compose exec -T app node --disable-warning=ExperimentalWarning scripts/check.js || true

cat <<DONE

Готово.
  Админка:       https://$DOMAIN/admin/
  Демо виджета:  https://$DOMAIN/demo.html
  Код виджета для сайта:
    <script src="https://$DOMAIN/widget.js" defer></script>

  Обновление:          sudo bash deploy/update.sh
  Сотрудники:          раздел «Сотрудники» в админке или docker compose exec app node scripts/admin.js list
  Тестовая карточка:   docker compose exec app node scripts/check.js --send-test
DONE
