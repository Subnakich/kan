#!/usr/bin/env bash
# Relocate configuration only. No build, pull, migration, DB restore or deletion.
set +x
set -Eeuo pipefail
umask 077
export LC_ALL=C
ROOT=/opt/kanban
WEB=trisoft-kan-web-1
DB=trisoft-kan-postgres-1
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
HELPER=$HERE/flat-layout.py
BACKUP=
SWITCHED=false
COMMITTED=false
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run in the root terminal on the Kan server.'
for tool in docker python3 curl flock install cmp sha256sum; do
  command -v "$tool" >/dev/null || fail "Missing tool: $tool"
done
[[ -f $HELPER && -d $ROOT && ! -L $ROOT ]] || fail 'Expected Kan installation/helper missing.'
exec 9>"$ROOT/deploy.lock"
flock -n 9 || fail 'Another Kan deployment is running.'
LABEL='{{index .Config.Labels "com.docker.compose.project.config_files"}}'
OLD_COMPOSE=$(docker inspect --format "$LABEL" "$WEB")
if [[ $OLD_COMPOSE == "$ROOT/compose.yml" ]]; then
  [[ -f $ROOT/.env && -f $ROOT/compose.yml ]] || fail 'Flat installation incomplete.'
  printf 'Kan already uses /opt/kanban/compose.yml; nothing changed.\n'
  exit 0
fi
[[ $OLD_COMPOSE =~ ^/opt/kanban/releases/20261006-task-control-[23]/deploy/compose\.yml$ ]] || fail 'Unexpected active Compose path.'
OLD_ENV=$(dirname -- "$OLD_COMPOSE")/.env
[[ -f $OLD_ENV && ! -L $OLD_ENV && -f $OLD_COMPOSE && ! -L $OLD_COMPOSE ]] || fail 'Original files missing or symlinked.'
[[ ! -e $ROOT/.env && ! -e $ROOT/compose.yml ]] || fail 'Destination files exist; inspect previous attempt before retrying.'
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$DB") == trisoft-kan ]] || fail 'Unexpected DB project.'
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$DB") == trisoft-kan_postgres ]] || fail 'Unexpected DB volume.'
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' "$WEB") == '{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3100"}]}' ]] || fail 'Unexpected web port binding.'
OLD_IMAGE=$(docker inspect --format '{{.Image}}' "$WEB")
DB_ID=$(docker inspect --format '{{.Id}}' "$DB")
DC_OLD=(docker compose --project-name trisoft-kan --env-file "$OLD_ENV" -f "$OLD_COMPOSE")
DC_NEW=(docker compose --project-name trisoft-kan --env-file "$ROOT/.env" -f "$ROOT/compose.yml")
wait_http() {
  local url=$1 attempt code
  for ((attempt=0; attempt<15; attempt++)); do
    code=$(curl -sS --connect-timeout 2 --max-time 3 -o /dev/null -w '%{http_code}' "$url") || code=000
    [[ $code == 200 ]] && return 0
    sleep 1
  done
  return 1
}
probe() { curl -sS -L --connect-timeout 3 --max-time 10 -o /dev/null -w '%{http_code}' "$1"; }
others() {
  local id name
  while read -r id; do
    name=$(docker inspect --format '{{.Name}}' "$id")
    [[ $name == /$WEB ]] && continue
    docker inspect --format '{{.Id}} {{.Name}} {{.State.StartedAt}}' "$id"
  done < <(docker ps -aq)
}
wait_http https://kanban.trisoft.ru/api/health || fail 'Kan unhealthy before relocation.'
REDMINE_STATUS=$(probe https://redmine.trisoft.ru)
[[ $REDMINE_STATUS == 200 ]] || fail 'Redmine preflight failed.'
API_STATUS=$(probe https://kanban.trisoft.ru/api/integrations/v1/boards)
BACKUP=$(mktemp -d "$ROOT/backups/flat-layout-XXXXXXXX")
printf 'Backup: %s\n' "$BACKUP"
install -m 600 "$OLD_ENV" "$BACKUP/previous.env"
install -m 600 "$OLD_COMPOSE" "$BACKUP/previous-compose.yml"
printf '%s\n' "$OLD_COMPOSE" > "$BACKUP/previous-compose-path"
others | sort > "$BACKUP/other-containers.before"
"${DC_OLD[@]}" config --format json > "$BACKUP/old-rendered.json" 2> "$BACKUP/compose-errors.log"
"${DC_OLD[@]}" config --no-interpolate --format json > "$BACKUP/unexpanded.json" 2>> "$BACKUP/compose-errors.log"
docker inspect --format '{{json .Config.Env}}' "$WEB" > "$BACKUP/running-env.json"
python3 "$HELPER" runtime "$BACKUP/old-rendered.json" "$BACKUP/running-env.json"
python3 "$HELPER" prepare "$BACKUP/unexpanded.json" "$BACKUP/new-compose.yml"
install -m 600 "$BACKUP/previous.env" "$ROOT/.env"
install -m 600 "$BACKUP/new-compose.yml" "$ROOT/compose.yml"
"${DC_NEW[@]}" config --format json > "$BACKUP/new-rendered.json" 2>> "$BACKUP/compose-errors.log"
python3 "$HELPER" compare "$BACKUP/old-rendered.json" "$BACKUP/new-rendered.json"
cmp -s "$OLD_ENV" "$ROOT/.env" || fail 'Env copy mismatch.'
# Check all named images locally; never download or rebuild one during relocation.
python3 - "$BACKUP/new-rendered.json" <<'PY' > "$BACKUP/images.list"
import json, sys
for service in json.load(open(sys.argv[1]))['services'].values():
    print(service['image'])
PY
while read -r image; do docker image inspect "$image" >/dev/null; done < "$BACKUP/images.list"
WEB_TAG=$(python3 - "$BACKUP/new-rendered.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))['services']['web']['image'])
PY
)
[[ $(docker image inspect --format '{{.Id}}' "$WEB_TAG") == "$OLD_IMAGE" ]] || fail 'Image tag no longer matches running web; refusing switch.'
rollback() {
  local status=$?
  trap - EXIT
  if [[ $SWITCHED == true && $COMMITTED == false ]]; then
    printf 'Checks failed; restoring original web configuration (no database restore).\n' >&2
    if "${DC_OLD[@]}" up -d --no-deps --no-build --pull never --force-recreate web > "$BACKUP/rollback.log" 2>&1 &&
       wait_http https://kanban.trisoft.ru/api/health; then
      printf 'Original web restored. New files retained for inspection: %s\n' "$BACKUP" >&2
    else
      printf 'Rollback needs attention. Logs retained in %s\n' "$BACKUP" >&2
    fi
  fi
  exit "$status"
}
trap rollback EXIT
SWITCHED=true
"${DC_NEW[@]}" up -d --no-deps --no-build --pull never --force-recreate web > "$BACKUP/switch.log" 2>&1
wait_http http://127.0.0.1:3100/api/health || fail 'Local health failed.'
wait_http https://kanban.trisoft.ru/api/health || fail 'HTTPS health failed.'
[[ $(probe https://kanban.trisoft.ru/login) == 200 ]] || fail 'Login page failed.'
[[ $(probe https://kanban.trisoft.ru/api/integrations/v1/boards) == "$API_STATUS" ]] || fail 'Integration access policy changed.'
[[ $(probe https://redmine.trisoft.ru) == "$REDMINE_STATUS" ]] || fail 'Redmine availability changed.'
[[ $(docker inspect --format '{{.Image}}' "$WEB") == "$OLD_IMAGE" ]] || fail 'Web image changed.'
[[ $(docker inspect --format '{{.Id}}' "$DB") == "$DB_ID" ]] || fail 'Database container changed.'
[[ $(docker inspect --format "$LABEL" "$WEB") == "$ROOT/compose.yml" ]] || fail 'Web did not switch to permanent Compose.'
others | sort > "$BACKUP/other-containers.after"
cmp -s "$BACKUP/other-containers.before" "$BACKUP/other-containers.after" || fail 'Another container changed during relocation; inspect.'
cmp -s "$OLD_ENV" "$ROOT/.env" || fail 'Env changed during relocation; inspect.'
COMMITTED=true
printf 'verified\n' > "$BACKUP/success"
printf 'Kan now uses /opt/kanban/compose.yml and /opt/kanban/.env. Data, image and other containers preserved.\n'
