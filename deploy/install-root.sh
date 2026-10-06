#!/usr/bin/env bash
# First installation only. Never upgrades, stops or mounts Redmine.
set +x
set -Eeuo pipefail
umask 077

RELEASE=20261006-task-control-2
DOMAIN=kanban.trisoft.ru
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TARGET=/opt/kanban/releases/$RELEASE
BACKUP=/opt/kanban/backups/first-install-$RELEASE
AVAILABLE=/etc/nginx/sites-available/$DOMAIN
ENABLED=/etc/nginx/sites-enabled/$DOMAIN
SNIPPET=/etc/nginx/snippets/kanban-bot-allow.conf
ACME=/var/www/kanban-acme
STARTED=false
VHOST_CREATED=false
SUCCESS=false
BUILDER=trisoft-kan-$RELEASE
BUILDER_CREATED=false

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run this script from the root console.'
[[ $(uname -m) == x86_64 ]] || fail 'Expected the verified Ubuntu amd64 server.'
[[ -f $SOURCE/RELEASE.sha256 ]] || fail 'Release checksums are missing.'
(cd "$SOURCE" && sha256sum --check --quiet RELEASE.sha256)
# shellcheck source=deploy/wait-ready.sh
source "$SOURCE/deploy/wait-ready.sh"
for tool in docker nginx certbot curl openssl ss tar install apt-get; do
  command -v "$tool" >/dev/null || fail "Missing required tool: $tool"
done
docker compose version >/dev/null
docker info >/dev/null
nginx -t
systemctl is-active --quiet nginx || fail 'Nginx is not active.'
[[ ! -e $TARGET && ! -L $TARGET ]] || fail 'Release already exists; inspect it before retrying.'
[[ ! -e $AVAILABLE && ! -L $AVAILABLE && ! -e $ENABLED && ! -L $ENABLED ]] || fail 'Kan vhost already exists; refusing to overwrite it.'
[[ ! -e $SNIPPET && ! -L $SNIPPET ]] || fail 'Kan API snippet already exists.'
[[ -z $(ss -H -ltn 'sport = :3100') ]] || fail 'Port 3100 is occupied.'
[[ $(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo) -ge 3500 ]] || fail 'At least 3.5 GiB available RAM is required for the build.'
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 10485760 ]] || fail 'At least 10 GiB free disk space is required.'
[[ $(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://redmine.trisoft.ru) == 200 ]] || fail 'Redmine baseline check failed.'
[[ -t 0 ]] || fail 'Interactive terminal required for the first account.'

printf 'First Kan account (credentials stay on this server).\n'
read -r -p 'Name: ' ADMIN_NAME
read -r -p 'Email: ' ADMIN_EMAIL
read -r -s -p 'Password (at least 12 characters): ' ADMIN_PASSWORD
printf '\n'
read -r -s -p 'Repeat password: ' REPEATED_PASSWORD
printf '\n'
[[ -n $ADMIN_NAME && $ADMIN_EMAIL == *@*.* ]] || fail 'Invalid name or email.'
[[ ${#ADMIN_PASSWORD} -ge 12 && $ADMIN_PASSWORD == "$REPEATED_PASSWORD" ]] || fail 'Passwords must match and have at least 12 characters.'
unset REPEATED_PASSWORD

install -d -m 700 "$TARGET" "$BACKUP"
cp -a "$SOURCE/." "$TARGET/"
chown -R root:root "$TARGET"
chmod -R go-w "$TARGET"
(cd "$TARGET" && sha256sum --check --quiet RELEASE.sha256)
tar -C /etc -czf "$BACKUP/nginx-before.tar.gz" nginx
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' > "$BACKUP/containers-before.txt"
cd "$TARGET"
DC=(docker compose --env-file deploy/.env -f deploy/compose.yml)

cleanup() {
  local code=$?
  unset ADMIN_PASSWORD
  if [[ $BUILDER_CREATED == true ]]; then
    docker buildx stop "$BUILDER" || true
  fi
  if [[ $SUCCESS != true ]]; then
    printf 'Installation stopped; Kan data and backup remain in %s.\n' "$TARGET" >&2
    if [[ $VHOST_CREATED == true ]]; then
      [[ ! -L $ENABLED ]] || mv -- "$ENABLED" "$BACKUP/disabled-kanban-link"
      nginx -t && systemctl reload nginx || true
    fi
    if [[ $STARTED == true ]]; then
      "${DC[@]}" stop web postgres migrate || true
    fi
  fi
  return "$code"
}
trap cleanup EXIT

{
  printf 'KAN_RELEASE=%s\n' "$RELEASE"
  printf 'KAN_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'NEXT_PUBLIC_DISABLE_SIGN_UP=true\n'
  printf 'TASK_CONTROL_SERVICE_TOKEN=\nTASK_CONTROL_ALLOWED_IPS=\nTASK_CONTROL_TRUSTED_PROXIES=\nTASK_CONTROL_GATEWAY_URL=\nTASK_CONTROL_GATEWAY_TOKEN=\n'
} > deploy/.env
chmod 600 deploy/.env
"${DC[@]}" config --quiet
printf 'Building Kan images on amd64. Redmine is not stopped or rebuilt.\n'
if ! docker buildx version >/dev/null 2>&1; then
  # Verified on this Ubuntu host: this adds only Buildx, not Docker Engine.
  apt-get update
  plan=$(LC_ALL=C apt-get --simulate install --no-install-recommends docker-buildx)
  printf '%s\n' "$plan"
  [[ $plan == *'0 upgraded, 1 newly installed, 0 to remove'* ]] || fail 'Buildx install would change other packages; review manually.'
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker-buildx
fi
! docker buildx inspect "$BUILDER" >/dev/null 2>&1 || fail 'Kan builder already exists; review before retrying.'
docker buildx create --name "$BUILDER" --driver docker-container \
  --driver-opt memory=3g,memory-swap=3g,cpu-quota=200000,cpu-period=100000,restart-policy=no
BUILDER_CREATED=true
docker buildx inspect --bootstrap "$BUILDER"
docker buildx build --builder "$BUILDER" --load --platform linux/amd64 \
  --build-arg NODE_VERSION=22 --target web -t "trisoft-kan:$RELEASE" -f apps/web/Dockerfile .
docker buildx build --builder "$BUILDER" --load --platform linux/amd64 \
  --build-arg NODE_VERSION=22 --target migrate -t "trisoft-kan-migrate:$RELEASE" -f apps/web/Dockerfile .
docker buildx stop "$BUILDER"
# Fail closed if the advisory registry is unavailable or reports High/Critical.
docker run --rm "trisoft-kan:$RELEASE" -e "$(<tools/security/audit-runtime-image.cjs)"

# Certificate first: the domain serves 503, not the application, during bootstrap.
install -d -m 755 "$ACME" /etc/nginx/snippets
install -m 644 deploy/nginx-http.conf "$AVAILABLE"
ln -s "$AVAILABLE" "$ENABLED"
VHOST_CREATED=true
nginx -t
systemctl reload nginx
# Reuse the existing Certbot account; do not accept new legal terms implicitly.
certbot certonly --webroot -w "$ACME" -d "$DOMAIN" --non-interactive --keep-until-expiring
[[ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]] || fail 'Certificate missing.'
certificate_matches_host "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$DOMAIN" || fail 'Certificate hostname mismatch.'

wait_for_web() {
  local attempt
  for ((attempt=0; attempt<90; attempt++)); do
    if curl -fsS --max-time 3 http://127.0.0.1:3100/api/health >/dev/null; then return; fi
    sleep 2
  done
  fail 'Kan health check failed. Inspect only the trisoft-kan compose logs.'
}

# A temporary override opens registration only on the loopback application.
printf 'services:\n  web:\n    environment:\n      NEXT_PUBLIC_DISABLE_SIGN_UP: "false"\n' > deploy/bootstrap.override.yml
STARTED=true
"${DC[@]}" -f deploy/bootstrap.override.yml up -d
wait_for_web
printf '%s\0%s\0%s\0' "$ADMIN_NAME" "$ADMIN_EMAIL" "$ADMIN_PASSWORD" |
  "${DC[@]}" exec -T web /nodejs/bin/node -e "$(<deploy/bootstrap-account.cjs)"
unset ADMIN_PASSWORD
"${DC[@]}" up -d --no-deps web
wait_for_web
# shellcheck disable=SC2016
# JavaScript template literals are evaluated by Node, not by the shell.
"${DC[@]}" exec -T web /nodejs/bin/node -e '
  if (process.env.NEXT_PUBLIC_DISABLE_SIGN_UP !== "true") process.exit(1);
  fetch("http://127.0.0.1:3000/api/auth/sign-up/email", {
    method:"POST", headers:{"content-type":"application/json",origin:process.env.NEXT_PUBLIC_BASE_URL,host:new URL(process.env.NEXT_PUBLIC_BASE_URL).host,"x-forwarded-proto":"https"},
    body:JSON.stringify({name:"Closed signup probe",email:`probe-${require("node:crypto").randomUUID()}@invalid.example`,password:require("node:crypto").randomBytes(24).toString("hex")})
  }).then(r=>{if(r.status!==400)process.exit(1)}).catch(()=>process.exit(1));
'
mv deploy/bootstrap.override.yml "$BACKUP/bootstrap.override.used.yml"

# Both API protections remain closed until the user configures the bot's IP/token.
install -m 644 deploy/kanban-bot-allow.conf "$SNIPPET"
install -m 644 deploy/nginx-https.conf "$AVAILABLE"
nginx -t
systemctl reload nginx
wait_for_http_status "https://$DOMAIN/api/health" 200
wait_for_http_status "https://$DOMAIN/api/integrations/v1/boards" 403
[[ $(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://redmine.trisoft.ru) == 200 ]] || fail 'Redmine post-install check failed.'

# Renewal hook reloads Nginx only for this new certificate.
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
[[ ! -e /etc/letsencrypt/renewal-hooks/deploy/kanban-nginx ]] || fail 'Renewal hook already exists.'
# shellcheck disable=SC2016
# Expand RENEWED_LINEAGE only when Certbot later executes the hook.
printf '#!/bin/sh\n[ "$RENEWED_LINEAGE" = "/etc/letsencrypt/live/kanban.trisoft.ru" ] || exit 0\n/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/kanban-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/kanban-nginx
SUCCESS=true
"${DC[@]}" ps -a
printf '\nKan is available at https://%s\nSign up and bot API are closed. Bot integration, SMTP and S3 are not configured.\n' "$DOMAIN"
