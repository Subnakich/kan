#!/usr/bin/env bash
# Web-only upgrade of polling-4. No DB migration, env edit or proxy edit.
set +x
set -Eeuo pipefail
umask 077
export LC_ALL=C
RELEASE=20261007-invite-link-1
PREVIOUS=trisoft-kan:20261006-task-control-4-polling
ROOT=/opt/kanban
WEB=trisoft-kan-web-1
DB=trisoft-kan-postgres-1
DOMAIN=kanban.trisoft.ru
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
BACKUP=$ROOT/backups/upgrade-$RELEASE
BUILDER=trisoft-kan-$RELEASE
SWITCHED=false
SUCCESS=false
BUILDER_CREATED=false
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 0 ]] || fail 'This installer does not accept flags.'
[[ $EUID == 0 ]] || fail 'Run in the root console on the Kan server.'
[[ $(uname -m) == x86_64 ]] || fail 'Expected the verified amd64 Kan host.'
for tool in docker curl flock sha256sum python3 install cmp; do
  command -v "$tool" >/dev/null || fail "Missing tool: $tool"
done
[[ -d $ROOT && ! -L $ROOT && -f $ROOT/.env && ! -L $ROOT/.env && -f $ROOT/compose.yml && ! -L $ROOT/compose.yml ]] || fail 'Expected flat Kan installation missing.'
exec 9>"$ROOT/deploy.lock"
flock -n 9 || fail 'Another Kan deployment is running.'
[[ -f $SOURCE/RELEASE.sha256 ]] || fail 'Release manifest missing.'
(cd "$SOURCE" && sha256sum --check --quiet RELEASE.sha256)
# shellcheck source=deploy/wait-ready.sh
source "$SOURCE/deploy/wait-ready.sh"
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$WEB") == trisoft-kan ]] || fail 'Unexpected web project.'
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$WEB") == "$ROOT/compose.yml" ]] || fail 'Unexpected active Compose path.'
CURRENT=$(docker inspect --format '{{.Config.Image}}' "$WEB")
if [[ $CURRENT == "trisoft-kan:$RELEASE" && -f $BACKUP/upgrade-success ]]; then
  wait_for_http_status "https://$DOMAIN/api/health" 200 10
  printf 'Kan already runs this release; nothing changed. Backup: %s\n' "$BACKUP"
  exit 0
fi
[[ $CURRENT == "$PREVIOUS" ]] || fail 'Expected polling-4; do not install over an unexpected release.'
[[ ! -e $BACKUP ]] || fail 'Previous attempt exists; inspect backup/logs before retrying.'
OLD_IMAGE=$(docker inspect --format '{{.Image}}' "$WEB")
[[ $(docker image inspect --format '{{.Id}}' "$PREVIOUS") == "$OLD_IMAGE" ]] || fail 'Previous image tag changed.'
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$WEB") == '{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3100"}]}' ]] || fail 'Unexpected Kan port binding.'
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$DB") == trisoft-kan ]] || fail 'Unexpected DB owner.'
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$DB") == trisoft-kan_postgres ]] || fail 'Unexpected database volume.'
[[ $(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo) -ge 3500 ]] || fail 'At least 3.5 GiB available RAM required.'
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 10485760 ]] || fail 'At least 10 GiB free space required.'
docker buildx version >/dev/null
! docker buildx inspect "$BUILDER" >/dev/null 2>&1 || fail 'Release builder already exists; inspect manually.'
! docker image inspect "trisoft-kan:$RELEASE" >/dev/null 2>&1 || fail 'Release tag already exists; inspect manually.'
wait_for_http_status "https://$DOMAIN/api/health" 200 10
API_STATUS=$(curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/integrations/v1/capabilities")
[[ $API_STATUS == 401 || $API_STATUS == 403 ]] || fail 'Unauthenticated integration must remain closed.'
DC=(docker compose --project-name trisoft-kan --env-file "$ROOT/.env" -f "$ROOT/compose.yml")
[[ $("${DC[@]}" exec -T postgres psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.task_control_redmine_request') IS NOT NULL;") == t ]] || fail 'Polling queue migration missing.'
install -d -m 700 "$BACKUP" "$BACKUP/source"
cp -a "$SOURCE/." "$BACKUP/source/"
chown -R root:root "$BACKUP/source"
chmod -R go-w "$BACKUP/source"
SOURCE=$BACKUP/source
(cd "$SOURCE" && sha256sum --check --quiet RELEASE.sha256)
install -m 600 "$ROOT/.env" "$BACKUP/previous.env"
install -m 600 "$ROOT/compose.yml" "$BACKUP/previous-compose.yml"
printf '%s\n' "$OLD_IMAGE" > "$BACKUP/previous-image-id"
"${DC[@]}" config --format json > "$BACKUP/old-rendered.json" 2> "$BACKUP/compose-errors.log"
"${DC[@]}" config --no-interpolate --format json > "$BACKUP/unexpanded.json" 2>> "$BACKUP/compose-errors.log"
docker inspect --format '{{json .Config.Env}}' "$WEB" > "$BACKUP/running-env.json"
python3 "$SOURCE/deploy/flat-layout.py" runtime "$BACKUP/old-rendered.json" "$BACKUP/running-env.json"
python3 "$SOURCE/deploy/invite-upgrade-layout.py" prepare "$BACKUP/unexpanded.json" "$BACKUP/new-compose.yml"
DC_NEW=(docker compose --project-name trisoft-kan --env-file "$ROOT/.env" -f "$BACKUP/new-compose.yml")
"${DC_NEW[@]}" config --format json > "$BACKUP/new-rendered.json" 2>> "$BACKUP/compose-errors.log"
python3 "$SOURCE/deploy/invite-upgrade-layout.py" compare "$BACKUP/old-rendered.json" "$BACKUP/new-rendered.json"
others() {
  local id
  while read -r id; do
    [[ $(docker inspect --format '{{.Name}}' "$id") == /$WEB ]] && continue
    docker inspect --format '{{.Id}} {{.State.StartedAt}}' "$id"
  done < <(docker ps -aq)
}
others > "$BACKUP/other-containers.before"
sha256sum "/etc/nginx/sites-available/$DOMAIN" /etc/nginx/snippets/kanban-bot-allow.conf > "$BACKUP/nginx.before.sha256"
# Never restore this dump automatically: no schema changes, ongoing writes stay valid.
rollback() {
  [[ $(docker image inspect --format '{{.Id}}' "$PREVIOUS") == "$OLD_IMAGE" ]] || return 1
  install -m 600 "$BACKUP/previous-compose.yml" "$ROOT/compose.yml.rollback-$RELEASE" || return 1
  mv -- "$ROOT/compose.yml.rollback-$RELEASE" "$ROOT/compose.yml" || return 1
  "${DC[@]}" up -d --no-deps --no-build --pull never web >> "$BACKUP/rollback.log" 2>&1 || return 1
  wait_for_http_status http://127.0.0.1:3100/api/health 200 30
}
cleanup() {
  local code=$? rollback_ok=true
  trap - EXIT
  set +e
  if [[ $BUILDER_CREATED == true ]]; then docker buildx stop "$BUILDER" >> "$BACKUP/build.log" 2>&1; fi
  if [[ $SUCCESS != true && $SWITCHED == true ]]; then
    rollback || rollback_ok=false
    printf 'Upgrade failed; previous web restored=%s. Backup/logs: %s\n' "$rollback_ok" "$BACKUP" >&2
  elif [[ $SUCCESS != true ]]; then
    printf 'Upgrade stopped before switching; working Kan unchanged. Logs: %s\n' "$BACKUP" >&2
  fi
  return "$code"
}
trap cleanup EXIT
printf 'Building web while current Kan remains online. Logs: %s/build.log\n' "$BACKUP"
docker buildx create --name "$BUILDER" --driver docker-container \
  --driver-opt memory=3g,memory-swap=3g,cpu-quota=200000,cpu-period=100000,restart-policy=no >> "$BACKUP/build.log" 2>&1
BUILDER_CREATED=true
{
  docker buildx inspect --bootstrap "$BUILDER"
  docker buildx build --builder "$BUILDER" --load --platform linux/amd64 \
    --build-arg NODE_VERSION=22 --target web -t "trisoft-kan:$RELEASE" -f "$SOURCE/apps/web/Dockerfile" "$SOURCE"
  docker buildx stop "$BUILDER"
} >> "$BACKUP/build.log" 2>&1
docker run --rm "trisoft-kan:$RELEASE" -e "$(<"$SOURCE/tools/security/audit-runtime-image.cjs")" > "$BACKUP/image-audit.log" 2>&1
printf 'Backing up Kan database; no migrations are executed.\n'
"${DC[@]}" exec -T postgres pg_dump -w -U kan -d kan -Fc > "$BACKUP/kan.dump"
[[ -s $BACKUP/kan.dump ]] || fail 'Empty database backup.'
"${DC[@]}" exec -T postgres pg_restore -l < "$BACKUP/kan.dump" > "$BACKUP/dump-contents.txt"
# Reject configuration/container drift that happened during the build.
cmp -s "$BACKUP/previous.env" "$ROOT/.env" || fail 'Env changed during build.'
cmp -s "$BACKUP/previous-compose.yml" "$ROOT/compose.yml" || fail 'Compose changed during build.'
cmp -s "$BACKUP/running-env.json" <(docker inspect --format '{{json .Config.Env}}' "$WEB") || fail 'Web runtime changed during build.'
[[ $(docker inspect --format '{{.Image}}' "$WEB") == "$OLD_IMAGE" ]] || fail 'Active web image changed during build.'
sha256sum --check --quiet "$BACKUP/nginx.before.sha256"
printf 'Switching only Kan web; keeping DB, env, proxy and integration unchanged.\n'
SWITCHED=true
install -m 600 "$BACKUP/new-compose.yml" "$ROOT/compose.yml.next-$RELEASE"
mv -- "$ROOT/compose.yml.next-$RELEASE" "$ROOT/compose.yml"
"${DC[@]}" up -d --no-deps --no-build --pull never web >> "$BACKUP/switch.log" 2>&1
wait_for_http_status http://127.0.0.1:3100/api/health 200 30
[[ $(docker inspect --format '{{.Config.Image}}' "$WEB") == "trisoft-kan:$RELEASE" ]] || fail 'Unexpected new web image.'
docker inspect --format '{{json .Config.Env}}' "$WEB" > "$BACKUP/new-running-env.json"
python3 "$SOURCE/deploy/flat-layout.py" runtime "$BACKUP/old-rendered.json" "$BACKUP/new-running-env.json"
cmp -s "$BACKUP/previous.env" "$ROOT/.env" || fail 'Env was changed.'
sha256sum --check --quiet "$BACKUP/nginx.before.sha256"
while read -r id started; do
  [[ $(docker inspect --format '{{.State.StartedAt}}' "$id") == "$started" ]] || fail 'An existing non-web container changed.'
done < "$BACKUP/other-containers.before"
wait_for_http_status "https://$DOMAIN/api/health" 200 20
wait_for_http_status "https://$DOMAIN/login" 200 10
wait_for_http_status "https://$DOMAIN/api/integrations/v1/capabilities" "$API_STATUS" 10
SUCCESS=true
printf 'success\n' > "$BACKUP/upgrade-success"
printf 'Installed %s. Registration by active invite link enabled; public signup remains closed. Backup: %s\n' "$RELEASE" "$BACKUP"
