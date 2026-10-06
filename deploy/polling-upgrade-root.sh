#!/usr/bin/env bash
# Flat-installation upgrade; saved integration settings require an explicit flag.
set +x
set -Eeuo pipefail
umask 077
export LC_ALL=C
RELEASE=20261006-task-control-4-polling
ROOT=/opt/kanban
DOMAIN=kanban.trisoft.ru
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
BACKUP=$ROOT/backups/upgrade-$RELEASE
WEB=trisoft-kan-web-1
DB=trisoft-kan-postgres-1
VHOST=/etc/nginx/sites-available/$DOMAIN
SCRATCH=kan_polling_restore_20261006_4
BUILDER=trisoft-kan-$RELEASE
MIGRATOR=trisoft-kan-polling4-migrate
STOPPED=false MIGRATED=false MAINTENANCE=false COMMITTED=false SUCCESS=false
SCRATCH_CREATED=false BUILDER_CREATED=false
fail() { printf '%s\n' "$*" >&2; exit 1; }
APPLY_INTEGRATION=strict RETRY_PREFLIGHT=false
for arg in "$@"; do
  case "$arg" in
    --apply-saved-integration) APPLY_INTEGRATION=apply ;;
    --retry-preflight) RETRY_PREFLIGHT=true ;;
    *) fail 'Unknown installer option.' ;;
  esac
done
[[ $EUID == 0 ]] || fail 'Run in the root console on the Kan server.'
[[ $(uname -m) == x86_64 ]] || fail 'Expected the verified amd64 host.'
for tool in docker nginx curl openssl flock sha256sum python3 install cmp; do
  command -v "$tool" >/dev/null || fail "Missing tool: $tool"
done
[[ -d $ROOT && ! -L $ROOT && -f $ROOT/.env && ! -L $ROOT/.env && -f $ROOT/compose.yml && ! -L $ROOT/compose.yml ]] || fail 'Expected flat installation missing.'
exec 9>"$ROOT/deploy.lock"
flock -n 9 || fail 'Another Kan deployment is running.'
[[ ! -e $BACKUP || $RETRY_PREFLIGHT == true ]] || fail 'Upgrade already staged/attempted; inspect backup/logs before retrying.'
[[ -f $SOURCE/RELEASE.sha256 ]] || fail 'Checksums missing.'
(cd "$SOURCE" && sha256sum --check --quiet RELEASE.sha256)
# shellcheck source=deploy/wait-ready.sh
source "$SOURCE/deploy/wait-ready.sh"
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$WEB") == "$ROOT/compose.yml" ]] || fail 'Web is not using flat Compose.'
OLD_TAG=$(docker inspect --format '{{.Config.Image}}' "$WEB")
[[ $OLD_TAG =~ ^trisoft-kan:20261006-task-control-[23]$ ]] || fail 'Unexpected current version; do not upgrade blindly.'
OLD_IMAGE=$(docker inspect --format '{{.Image}}' "$WEB")
[[ $(docker image inspect --format '{{.Id}}' "$OLD_TAG") == "$OLD_IMAGE" ]] || fail 'Old image tag changed.'
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$DB") == trisoft-kan ]] || fail 'Unexpected DB project.'
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$DB") == trisoft-kan_postgres ]] || fail 'Unexpected DB volume.'
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$WEB") == '{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3100"}]}' ]] || fail 'Unexpected web port exposure.'
[[ -f $VHOST && ! -L $VHOST && -L /etc/nginx/sites-enabled/$DOMAIN && $(readlink /etc/nginx/sites-enabled/$DOMAIN) == "$VHOST" ]] || fail 'Unexpected Kan vhost.'
[[ $(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo) -ge 3500 ]] || fail 'At least 3.5 GiB available RAM required.'
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 10485760 ]] || fail 'At least 10 GiB free space required.'
docker buildx version >/dev/null
nginx -t
certificate_matches_host "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$DOMAIN" || fail 'Certificate hostname mismatch.'
wait_for_http_status "https://$DOMAIN/api/health" 200 3
wait_for_http_status https://redmine.trisoft.ru 200 3
API_STATUS=$(curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/integrations/v1/capabilities")
[[ $API_STATUS == 403 || $API_STATUS == 401 ]] || fail 'Unauthenticated integration is unexpectedly open.'
DC=(docker compose --project-name trisoft-kan --env-file "$ROOT/.env" -f "$ROOT/compose.yml")
pg() { "${DC[@]}" exec -T postgres "$@"; }
ownership_hash=$(sha256sum "$SOURCE/packages/db/migrations/20261006142318_NativeTaskOwnership.sql" | awk '{print $1}')
[[ $(pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT EXISTS(SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash='$ownership_hash');") == t ]] || fail 'Previous ownership upgrade is missing; this installer adds only the polling queue.'
[[ $(pg psql -X -w -U kan -d kan -At -c "SELECT to_regclass('public.task_control_redmine_request') IS NULL;") == t ]] || fail 'Polling table already exists; inspect previous attempt.'
[[ $(pg psql -X -w -U kan -d kan -At -c "SELECT count(*) FROM pg_database WHERE datname='$SCRATCH';") == 0 ]] || fail 'Restore-test database already exists.'
! docker buildx inspect "$BUILDER" >/dev/null 2>&1 || fail 'Builder already exists; inspect previous attempt.'
! docker image inspect "trisoft-kan:$RELEASE" >/dev/null 2>&1 || fail 'Release image already exists; inspect previous attempt.'
if [[ -e $BACKUP ]]; then
  [[ -d $BACKUP && ! -L $BACKUP ]] || fail 'Unexpected preflight backup path.'
  for marker in kan.dump new-compose.yml maintenance.conf before.full restore-verified upgrade-success; do
    [[ ! -e $BACKUP/$marker ]] || fail 'Previous attempt passed preflight; automatic retry forbidden.'
  done
  [[ -f $BACKUP/source/RELEASE.sha256 && -f $BACKUP/old-rendered.json && -f $BACKUP/running-env.json ]] || fail 'Incomplete previous preflight; inspect manually.'
  cmp -s "$BACKUP/previous.env" "$ROOT/.env" || fail 'Saved env changed since failed preflight; inspect manually.'
  cmp -s "$BACKUP/previous-compose.yml" "$ROOT/compose.yml" || fail 'Compose changed since failed preflight; inspect manually.'
  cmp -s "$BACKUP/running-env.json" <(docker inspect --format '{{json .Config.Env}}' "$WEB") || fail 'Runtime changed since failed preflight; inspect manually.'
  ARCHIVED_PREFLIGHT=$(mktemp -d "$ROOT/backups/polling-preflight-XXXXXXXX")
  mv -- "$BACKUP" "$ARCHIVED_PREFLIGHT/attempt"
  printf 'Previous preflight preserved: %s/attempt\n' "$ARCHIVED_PREFLIGHT"
fi
install -d -m 700 "$BACKUP" "$BACKUP/source"
cp -a "$SOURCE/." "$BACKUP/source/"
chown -R root:root "$BACKUP/source"
chmod -R go-w "$BACKUP/source"
SOURCE=$BACKUP/source
install -m 600 "$ROOT/.env" "$BACKUP/previous.env"
install -m 600 "$ROOT/compose.yml" "$BACKUP/previous-compose.yml"
install -m 600 "$VHOST" "$BACKUP/nginx.conf"
install -m 600 /etc/nginx/snippets/kanban-bot-allow.conf "$BACKUP/bot-allow.conf"
"${DC[@]}" config --format json > "$BACKUP/old-rendered.json" 2> "$BACKUP/compose-errors.log"
"${DC[@]}" config --no-interpolate --format json > "$BACKUP/unexpanded.json" 2>> "$BACKUP/compose-errors.log"
docker inspect --format '{{json .Config.Env}}' "$WEB" > "$BACKUP/running-env.json"
GATEWAY=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}}' "$WEB" | awk 'NF' | sort -u)
[[ $GATEWAY =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Expected one verified Docker gateway.'
python3 "$SOURCE/deploy/polling-layout.py" authorize "$BACKUP/old-rendered.json" "$BACKUP/running-env.json" "$BACKUP/rollback-compose.yml" "$APPLY_INTEGRATION" "$GATEWAY"
if [[ $APPLY_INTEGRATION == apply ]]; then
  printf 'Applying explicitly approved saved service token, bot IP and trusted proxy; obsolete gateway is excluded.\n'
fi
python3 "$SOURCE/deploy/polling-layout.py" "$BACKUP/unexpanded.json" "$BACKUP/new-compose.yml" "$RELEASE"
DC_NEW=(docker compose --project-name trisoft-kan --env-file "$ROOT/.env" -f "$BACKUP/new-compose.yml")
"${DC_NEW[@]}" config --quiet 2>> "$BACKUP/compose-errors.log"
# Only snapshot IDs/start times of existing non-web containers; never their env.
while read -r id; do
  [[ $(docker inspect --format '{{.Name}}' "$id") == /$WEB ]] && continue
  docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$id"
done < <(docker ps -aq) > "$BACKUP/other-containers.before"
sed 's/proxy_pass http:\/\/127\.0\.0\.1:3100;/return 503;/' "$VHOST" > "$BACKUP/maintenance.conf"
! cmp -s "$VHOST" "$BACKUP/maintenance.conf" || fail 'Expected Kan proxy_pass not found.'
fingerprint() { pg psql -X -w -U kan -d "$1" -At -v ON_ERROR_STOP=1 -v "mode=$2" < "$SOURCE/deploy/polling-fingerprint.sql"; }
restore_vhost() {
  install -m 644 "$BACKUP/nginx.conf" "$VHOST.next-$RELEASE"
  mv -- "$VHOST.next-$RELEASE" "$VHOST"
  nginx -t && systemctl reload nginx
}
cleanup() {
  local code=$? rollback_ok=true
  trap - EXIT
  set +e
  if [[ $BUILDER_CREATED == true ]]; then docker buildx stop "$BUILDER"; fi
  if [[ $SUCCESS != true && $COMMITTED != true ]]; then
    if [[ $STOPPED == true ]]; then
      "${DC[@]}" stop web || rollback_ok=false
      if [[ $MIGRATED == true ]]; then
        if docker inspect "$MIGRATOR" >/dev/null 2>&1; then docker stop "$MIGRATOR" || rollback_ok=false; fi
        if [[ $rollback_ok == true && -f $BACKUP/restore-verified ]]; then
          pg pg_restore -w -U kan -d kan --clean --if-exists --exit-on-error --single-transaction < "$BACKUP/kan.dump" || rollback_ok=false
          pg psql -X -w -U kan -d kan -v ON_ERROR_STOP=1 -c 'DROP TABLE IF EXISTS public.task_control_redmine_request;' > "$BACKUP/rollback-additive-table.log" 2>&1 || rollback_ok=false
          fingerprint kan full > "$BACKUP/rollback.full" || rollback_ok=false
          cmp -s "$BACKUP/before.full" "$BACKUP/rollback.full" || rollback_ok=false
        else rollback_ok=false; fi
      fi
      if [[ $rollback_ok == true ]]; then
        install -m 600 "$BACKUP/rollback-compose.yml" "$ROOT/compose.yml" || rollback_ok=false
        "${DC[@]}" up -d --no-deps --no-build --pull never web || rollback_ok=false
        wait_for_http_status http://127.0.0.1:3100/api/health 200 30 || rollback_ok=false
      fi
    fi
    if [[ $MAINTENANCE == true && $rollback_ok == true ]]; then restore_vhost || rollback_ok=false; fi
    printf 'Upgrade failed; old web restored=%s. Backup/logs: %s\n' "$rollback_ok" "$BACKUP" >&2
  elif [[ $SUCCESS != true ]]; then
    printf 'New release reopened; NO automatic DB restore. Inspect health/proxy. Backup: %s\n' "$BACKUP" >&2
  fi
  if [[ $SCRATCH_CREATED == true ]]; then pg dropdb -w -U kan "$SCRATCH"; fi
  return "$code"
}
trap cleanup EXIT
printf 'Building amd64 images; existing Kan and Redmine remain online.\n'
cd "$SOURCE"
docker buildx create --name "$BUILDER" --driver docker-container \
  --driver-opt memory=3g,memory-swap=3g,cpu-quota=200000,cpu-period=100000,restart-policy=no
BUILDER_CREATED=true
docker buildx inspect --bootstrap "$BUILDER"
for target in web migrate; do
  image=trisoft-kan
  [[ $target != migrate ]] || image=trisoft-kan-migrate
  docker buildx build --builder "$BUILDER" --load --platform linux/amd64 \
    --build-arg NODE_VERSION=22 --target "$target" -t "$image:$RELEASE" -f apps/web/Dockerfile .
done
docker buildx stop "$BUILDER"
docker run --rm "trisoft-kan:$RELEASE" -e "$(<tools/security/audit-runtime-image.cjs)"
printf 'Starting Kan-only maintenance; verifying DB backup before migration.\n'
MAINTENANCE=true
install -m 644 "$BACKUP/maintenance.conf" "$VHOST.next-$RELEASE"
mv -- "$VHOST.next-$RELEASE" "$VHOST"
nginx -t
systemctl reload nginx
wait_for_http_status "https://$DOMAIN/api/health" 503 30
STOPPED=true
"${DC[@]}" stop web
pg pg_dump -w -U kan -d kan -Fc > "$BACKUP/kan.dump"
[[ -s $BACKUP/kan.dump ]] || fail 'Empty database backup.'
fingerprint kan full > "$BACKUP/before.full"
fingerprint kan stable > "$BACKUP/before.stable"
pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c 'SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id;' > "$BACKUP/journal.before"
pg createdb -w -U kan -T template0 "$SCRATCH"
SCRATCH_CREATED=true
pg pg_restore -w -U kan -d "$SCRATCH" --exit-on-error --single-transaction < "$BACKUP/kan.dump"
fingerprint "$SCRATCH" full > "$BACKUP/restored.full"
cmp -s "$BACKUP/before.full" "$BACKUP/restored.full" || fail 'Restored backup differs.'
printf 'verified\n' > "$BACKUP/restore-verified"
pg dropdb -w -U kan "$SCRATCH"
SCRATCH_CREATED=false
MIGRATED=true
"${DC_NEW[@]}" run --rm --no-deps --name "$MIGRATOR" migrate
migration_hash=$(sha256sum "$SOURCE/packages/db/migrations/20261006153952_AddRedminePollingQueue.sql" | awk '{print $1}')
[[ $(pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT EXISTS(SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash='$migration_hash');") == t ]] || fail 'Queue migration not recorded.'
[[ $(pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM public.task_control_redmine_request;') == 0 ]] || fail 'Unexpected nonempty queue before reopening.'
fingerprint kan stable > "$BACKUP/after.stable"
cmp -s "$BACKUP/before.stable" "$BACKUP/after.stable" || fail 'Existing account/task/member/function data changed.'
pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT id,hash,created_at FROM drizzle.__drizzle_migrations WHERE hash<>'$migration_hash' ORDER BY id;" > "$BACKUP/journal.after"
cmp -s "$BACKUP/journal.before" "$BACKUP/journal.after" || fail 'Unexpected migration journal changes.'
cmp -s "$BACKUP/previous.env" "$ROOT/.env" || fail 'Environment changed during deployment.'
install -m 600 "$BACKUP/new-compose.yml" "$ROOT/compose.yml"
"${DC[@]}" up -d --no-deps --no-build --pull never web
wait_for_http_status http://127.0.0.1:3100/api/health 200 30
[[ $(docker inspect --format '{{.Config.Image}}' "$WEB") == "trisoft-kan:$RELEASE" ]] || fail 'New image not running.'
# Check registration refusal without creating an account or logging secrets.
# shellcheck disable=SC2016
"${DC[@]}" exec -T web /nodejs/bin/node -e '
  if(process.env.NEXT_PUBLIC_DISABLE_SIGN_UP!=="true")process.exit(1);
  const origin=process.env.NEXT_PUBLIC_BASE_URL;
  fetch("http://127.0.0.1:3000/api/auth/sign-up/email",{method:"POST",headers:{"content-type":"application/json",origin,host:new URL(origin).host,"x-forwarded-proto":"https"},body:JSON.stringify({name:"Closed signup probe",email:`probe-${require("node:crypto").randomUUID()}@invalid.example`,password:require("node:crypto").randomBytes(24).toString("hex")}),signal:AbortSignal.timeout(10000)}).then(r=>{if(r.status!==400)process.exit(1)}).catch(()=>process.exit(1));
'
while read -r id started; do
  [[ $(docker inspect --format '{{.State.StartedAt}}' "$id") == "$started" ]] || fail 'Another existing container changed.'
done < "$BACKUP/other-containers.before"
cmp -s "$BACKUP/bot-allow.conf" /etc/nginx/snippets/kanban-bot-allow.conf || fail 'IP whitelist changed.'
# Commit BEFORE reopening: never undo user writes by restoring an old dump.
COMMITTED=true
restore_vhost
wait_for_http_status "https://$DOMAIN/api/health" 200 30
wait_for_http_status "https://$DOMAIN/login" 200 10
wait_for_http_status "https://$DOMAIN/api/integrations/v1/capabilities" "$API_STATUS" 10
wait_for_http_status "https://$DOMAIN/api/integrations/v1/redmine/requests/claim" "$API_STATUS" 10
wait_for_http_status https://redmine.trisoft.ru 200 10
cmp -s "$BACKUP/nginx.conf" "$VHOST" || fail 'Nginx configuration changed.'
SUCCESS=true
printf 'success\n' > "$BACKUP/upgrade-success"
printf '\nKan upgraded to %s. Data/env/whitelist preserved; bot worker not updated. Backup: %s\n' "$RELEASE" "$BACKUP"
