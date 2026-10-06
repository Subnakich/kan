#!/usr/bin/env bash
# Resume ONLY the verified first installation after its HTTPS readiness failure.
# Never rebuild images, run migrations, regenerate secrets or create accounts.
set +x
set -Eeuo pipefail
umask 077

RELEASE=20261006-task-control-2
DOMAIN=kanban.trisoft.ru
TARGET=/opt/kanban/releases/$RELEASE
AVAILABLE=/etc/nginx/sites-available/$DOMAIN
ENABLED=/etc/nginx/sites-enabled/$DOMAIN
SNIPPET=/etc/nginx/snippets/kanban-bot-allow.conf
HOOK=/etc/letsencrypt/renewal-hooks/deploy/kanban-nginx
RECOVERY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
CREATED_LINK=false
STARTED=false
SUCCESS=false

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run from the root console.'
(cd "$RECOVERY" && sha256sum --check --quiet RECOVERY.sha256)
# shellcheck source=deploy/wait-ready.sh
source "$RECOVERY/wait-ready.sh"
[[ -d $TARGET && -f $TARGET/deploy/.env ]] || fail 'Existing Kan release/configuration missing.'
[[ ! -e $ENABLED && ! -L $ENABLED ]] || fail 'Kan vhost is already enabled; inspect manually.'
[[ ! -e $TARGET/deploy/bootstrap.override.yml ]] || fail 'Account bootstrap was not completed; inspect manually.'
(cd "$TARGET" && sha256sum --check --quiet RELEASE.sha256)
cmp -s "$TARGET/deploy/nginx-https.conf" "$AVAILABLE" || fail 'Existing Kan vhost differs from the verified template.'
cmp -s "$TARGET/deploy/kanban-bot-allow.conf" "$SNIPPET" || fail 'Existing Kan API snippet changed; inspect manually.'
grep -qx 'NEXT_PUBLIC_DISABLE_SIGN_UP=true' "$TARGET/deploy/.env" || fail 'Public registration must remain closed.'
[[ ! -e $HOOK && ! -L $HOOK ]] || fail 'Renewal hook already exists; inspect manually.'
[[ -z $(ss -H -ltn 'sport = :3100') ]] || fail 'Port 3100 is occupied; inspect its owner.'
docker volume inspect trisoft-kan_postgres >/dev/null || fail 'Existing Kan database volume missing; refusing to create a new DB.'
docker image inspect "trisoft-kan:$RELEASE" >/dev/null || fail 'Existing Kan web image missing.'
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' trisoft-kan-postgres-1) == trisoft-kan ]] || fail 'Unexpected database container owner.'
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' trisoft-kan-postgres-1) == trisoft-kan_postgres ]] || fail 'Database container is not using the existing Kan volume.'
certificate_matches_host "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$DOMAIN" || fail 'Certificate hostname mismatch.'
openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -noout -checkend 3600 >/dev/null || fail 'Certificate expired or expiring.'
nginx -t
systemctl is-active --quiet nginx || fail 'Nginx is not active.'
[[ $(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://redmine.trisoft.ru) == 200 ]] || fail 'Redmine baseline check failed.'

cd "$TARGET"
DC=(docker compose --env-file deploy/.env -f deploy/compose.yml)
"${DC[@]}" config --quiet
cleanup() {
  local code=$?
  if [[ $SUCCESS != true ]]; then
    if [[ $CREATED_LINK == true && -L $ENABLED && $(readlink "$ENABLED") == "$AVAILABLE" ]]; then
      mv -- "$ENABLED" "$RECOVERY/disabled-kanban-link-$(date -u +%Y%m%dT%H%M%SZ)-$$"
      nginx -t && systemctl reload nginx || true
    fi
    if [[ $STARTED == true ]]; then "${DC[@]}" stop web postgres || true; fi
    printf 'Recovery stopped. Existing Kan data/configuration remain unchanged.\n' >&2
  fi
  return "$code"
}
trap cleanup EXIT

# Start only existing containers: no compose up, no migration or image build.
STARTED=true
"${DC[@]}" start postgres
for ((attempt=0; attempt<20; attempt++)); do
  if "${DC[@]}" exec -T postgres pg_isready -U kan -d kan >/dev/null 2>&1; then break; fi
  sleep 1
done
"${DC[@]}" exec -T postgres pg_isready -U kan -d kan >/dev/null
users=$("${DC[@]}" exec -T postgres psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM "user";')
[[ $users =~ ^[0-9]+$ && $users -ge 1 ]] || fail 'No existing account found; refusing account bootstrap.'
"${DC[@]}" start web
wait_for_http_status http://127.0.0.1:3100/api/health 200 30
# shellcheck disable=SC2016
"${DC[@]}" exec -T web /nodejs/bin/node -e '
  if(process.env.NEXT_PUBLIC_DISABLE_SIGN_UP!=="true")process.exit(1);
  const origin=process.env.NEXT_PUBLIC_BASE_URL;
  fetch("http://127.0.0.1:3000/api/auth/sign-up/email",{method:"POST",headers:{"content-type":"application/json",origin,host:new URL(origin).host,"x-forwarded-proto":"https"},body:JSON.stringify({name:"Closed signup probe",email:`probe-${require("node:crypto").randomUUID()}@invalid.example`,password:require("node:crypto").randomBytes(24).toString("hex")}),signal:AbortSignal.timeout(10000)}).then(r=>{if(r.status!==400)process.exit(1)}).catch(()=>process.exit(1));
'
ln -s "$AVAILABLE" "$ENABLED"
CREATED_LINK=true
nginx -t
systemctl reload nginx
# nginx -s reload only signals the master: wait for the new TLS workers.
wait_for_http_status "https://$DOMAIN/api/health" 200 30
wait_for_http_status "https://$DOMAIN/api/integrations/v1/boards" 403
[[ $(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://redmine.trisoft.ru) == 200 ]] || fail 'Redmine post-recovery check failed.'

install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
# shellcheck disable=SC2016
printf '#!/bin/sh\n[ "$RENEWED_LINEAGE" = "/etc/letsencrypt/live/kanban.trisoft.ru" ] || exit 0\n/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx\n' > "$HOOK"
chmod 755 "$HOOK"
SUCCESS=true
"${DC[@]}" ps -a
printf '\nKan is available at https://%s. Existing account/database preserved; sign-up and integration API remain closed.\n' "$DOMAIN"
