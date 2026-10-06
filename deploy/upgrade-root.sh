#!/usr/bin/env bash
# One specific upgrade; preserves Kan data/configuration and never touches Redmine.
set +x
set -Eeuo pipefail
umask 077
export LC_ALL=C

PREVIOUS=20261006-task-control-2
RELEASE=20261006-task-control-3
DOMAIN=kanban.trisoft.ru
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
OLD=/opt/kanban/releases/$PREVIOUS
TARGET=/opt/kanban/releases/$RELEASE
BACKUP=/opt/kanban/backups/upgrade-$RELEASE
VHOST=/etc/nginx/sites-available/$DOMAIN
SCRATCH_DB=kan_restore_20261006_3
BUILDER=trisoft-kan-$RELEASE
MIGRATOR=trisoft-kan-ui3-migrate
STOPPED=false
MIGRATED=false
MAINTENANCE=false
COMMITTED=false
SUCCESS=false
SCRATCH_CREATED=false
BUILDER_CREATED=false

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run from the root console.'
[[ $(uname -m) == x86_64 ]] || fail 'Expected the verified amd64 server.'
for tool in docker nginx curl openssl flock sha256sum install cmp comm sort sed; do
  command -v "$tool" >/dev/null || fail "Missing tool: $tool"
done
exec 9>/opt/kanban/deploy.lock
flock -n 9 || fail 'Another Kan deployment is running.'
[[ -f $OLD/deploy/.env && ! -L $OLD ]] || fail 'Previous immutable release is missing.'
[[ ! -e $TARGET && ! -e $BACKUP ]] || fail 'Upgrade already staged/attempted. Inspect its backup and logs; do not rerun blindly.'
[[ -f $SOURCE/RELEASE.sha256 ]] || fail 'Release checksums are missing.'
(cd "$SOURCE" && sha256sum --check --quiet RELEASE.sha256)
(cd "$OLD" && sha256sum --check --quiet RELEASE.sha256)
# shellcheck source=deploy/wait-ready.sh
source "$SOURCE/deploy/wait-ready.sh"
[[ -f $VHOST && ! -L $VHOST ]] || fail 'Unexpected Kan vhost.'
[[ -L /etc/nginx/sites-enabled/$DOMAIN && $(readlink /etc/nginx/sites-enabled/$DOMAIN) == "$VHOST" ]] || fail 'Kan vhost is not enabled as expected.'
cmp -s "$OLD/deploy/nginx-https.conf" "$VHOST" || fail 'Kan vhost changed; inspect before upgrading.'
cmp -s "$OLD/deploy/kanban-bot-allow.conf" /etc/nginx/snippets/kanban-bot-allow.conf || fail 'Integration policy changed; inspect before upgrading.'
grep -qx "KAN_RELEASE=$PREVIOUS" "$OLD/deploy/.env" || fail 'Unexpected previous release configuration.'
grep -qx 'NEXT_PUBLIC_DISABLE_SIGN_UP=true' "$OLD/deploy/.env" || fail 'Registration must remain closed.'
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' trisoft-kan-postgres-1) == trisoft-kan ]] || fail 'Unexpected database owner.'
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' trisoft-kan-postgres-1) == trisoft-kan_postgres ]] || fail 'Unexpected database volume.'
[[ $(docker inspect --format '{{.Config.Image}}' trisoft-kan-web-1) == "trisoft-kan:$PREVIOUS" ]] || fail 'Unexpected running release.'
[[ $(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' trisoft-kan-web-1) == "$OLD/deploy/compose.yml" ]] || fail 'Unexpected running compose configuration.'
[[ $(docker inspect --format '{{json .HostConfig.PortBindings}}' trisoft-kan-web-1) == '{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3100"}]}' ]] || fail 'Kan must stay bound to loopback only.'
[[ $(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo) -ge 3500 ]] || fail 'At least 3.5 GiB available RAM is required.'
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 10485760 ]] || fail 'At least 10 GiB free space is required.'
docker buildx version >/dev/null
nginx -t
certificate_matches_host "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$DOMAIN" || fail 'Certificate hostname mismatch.'
wait_for_http_status "https://$DOMAIN/api/health" 200 3
wait_for_http_status "https://$DOMAIN/api/integrations/v1/boards" 403 3
wait_for_http_status https://redmine.trisoft.ru 200 3

install -d -m 700 "$TARGET" "$BACKUP"
cp -a "$SOURCE/." "$TARGET/"
chown -R root:root "$TARGET"
chmod -R go-w "$TARGET"
install -m 600 "$OLD/deploy/.env" "$BACKUP/previous.env"
sed "s/^KAN_RELEASE=$PREVIOUS$/KAN_RELEASE=$RELEASE/" "$BACKUP/previous.env" > "$TARGET/deploy/.env"
chmod 600 "$TARGET/deploy/.env"
install -m 600 "$VHOST" "$BACKUP/nginx-https.conf"
sed 's/proxy_pass http:\/\/127\.0\.0\.1:3100;/return 503;/' "$VHOST" > "$BACKUP/maintenance.conf"
DC_OLD=(docker compose --project-name trisoft-kan --env-file "$OLD/deploy/.env" -f "$OLD/deploy/compose.yml")
DC_NEW=(docker compose --project-name trisoft-kan --env-file "$TARGET/deploy/.env" -f "$TARGET/deploy/compose.yml")
"${DC_NEW[@]}" config --quiet

pg() { "${DC_OLD[@]}" exec -T postgres "$@"; }
fingerprint() { pg psql -X -w -U kan -d "$1" -At -v ON_ERROR_STOP=1 -v "mode=$2" < "$TARGET/deploy/upgrade-fingerprint.sql"; }
restore_vhost() {
  install -m 644 "$BACKUP/nginx-https.conf" "$VHOST.next-$RELEASE"
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
      "${DC_NEW[@]}" stop web || rollback_ok=false
      if [[ $MIGRATED == true ]]; then
        if docker inspect "$MIGRATOR" >/dev/null 2>&1; then docker stop "$MIGRATOR" || rollback_ok=false; fi
        # Restore only this validated Kan database, not a volume/Redmine database.
        if [[ $rollback_ok == true && -f $BACKUP/restore-verified ]]; then
          pg pg_restore -w -U kan -d kan --clean --if-exists --exit-on-error --single-transaction < "$BACKUP/kan.dump" || rollback_ok=false
          fingerprint kan full > "$BACKUP/rollback.fingerprint" || rollback_ok=false
          cmp -s "$BACKUP/before.full" "$BACKUP/rollback.fingerprint" || rollback_ok=false
        else rollback_ok=false; fi
      fi
      if [[ $rollback_ok == true ]]; then
        "${DC_OLD[@]}" up -d --no-deps --pull never web || rollback_ok=false
        wait_for_http_status http://127.0.0.1:3100/api/health 200 30 || rollback_ok=false
      fi
    fi
    if [[ $MAINTENANCE == true && $rollback_ok == true ]]; then restore_vhost || rollback_ok=false; fi
    printf 'Upgrade failed; previous release restored=%s. Backup retained: %s\n' "$rollback_ok" "$BACKUP" >&2
  elif [[ $SUCCESS != true ]]; then
    printf 'New release is committed. NO database rollback after reopening; inspect health/Nginx. Backup: %s\n' "$BACKUP" >&2
  fi
  if [[ $SCRATCH_CREATED == true ]]; then pg dropdb -w -U kan "$SCRATCH_DB"; fi
  return "$code"
}
trap cleanup EXIT

printf 'Building amd64 images while existing Kan and Redmine remain running.\n'
cd "$TARGET"
! docker buildx inspect "$BUILDER" >/dev/null 2>&1 || fail 'Upgrade builder already exists; inspect manually.'
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
[[ $(pg psql -X -w -U kan -d kan -At -c "SELECT count(*) FROM pg_database WHERE datname='$SCRATCH_DB';") == 0 ]] || fail 'Restore-test database already exists.'

printf 'Starting short maintenance window; Kan only.\n'
MAINTENANCE=true
install -m 644 "$BACKUP/maintenance.conf" "$VHOST.next-$RELEASE"
mv -- "$VHOST.next-$RELEASE" "$VHOST"
nginx -t
systemctl reload nginx
wait_for_http_status "https://$DOMAIN/api/health" 503 30
STOPPED=true
"${DC_OLD[@]}" stop web
pg pg_dump -w -U kan -d kan -Fc > "$BACKUP/kan.dump"
[[ -s $BACKUP/kan.dump ]] || fail 'Empty backup.'
fingerprint kan full > "$BACKUP/before.full"
fingerprint kan stable > "$BACKUP/before.stable"
pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT \"publicId\"||'|'||\"ownerMemberPublicId\" FROM card WHERE \"ownerMemberPublicId\" IS NOT NULL;" | sort > "$BACKUP/owners.before"
pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT \"cardId\"||'|'||\"workspaceMemberId\" FROM _card_workspace_members;" | sort > "$BACKUP/members.before"
pg createdb -w -U kan -T template0 "$SCRATCH_DB"
SCRATCH_CREATED=true
pg pg_restore -w -U kan -d "$SCRATCH_DB" --exit-on-error --single-transaction < "$BACKUP/kan.dump"
fingerprint "$SCRATCH_DB" full > "$BACKUP/restored.full"
cmp -s "$BACKUP/before.full" "$BACKUP/restored.full" || fail 'Restored backup differs; aborting upgrade.'
printf 'verified\n' > "$BACKUP/restore-verified"
pg dropdb -w -U kan "$SCRATCH_DB"
SCRATCH_CREATED=false

MIGRATED=true
"${DC_NEW[@]}" run --rm --no-deps --name "$MIGRATOR" migrate
migration_hash=$(sha256sum "$TARGET/packages/db/migrations/20261006142318_NativeTaskOwnership.sql" | awk '{print $1}')
[[ $(pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT EXISTS(SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash='$migration_hash');") == t ]] || fail 'Ownership migration was not recorded.'
fingerprint kan stable > "$BACKUP/after.stable"
cmp -s "$BACKUP/before.stable" "$BACKUP/after.stable" || fail 'Unexpected changes to business/account data.'
pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT \"publicId\"||'|'||\"ownerMemberPublicId\" FROM card WHERE \"ownerMemberPublicId\" IS NOT NULL;" | sort > "$BACKUP/owners.after"
pg psql -X -w -U kan -d kan -At -v ON_ERROR_STOP=1 -c "SELECT \"cardId\"||'|'||\"workspaceMemberId\" FROM _card_workspace_members;" | sort > "$BACKUP/members.after"
[[ -z $(comm -23 "$BACKUP/owners.before" "$BACKUP/owners.after") ]] || fail 'Existing primary owner lost.'
[[ -z $(comm -23 "$BACKUP/members.before" "$BACKUP/members.after") ]] || fail 'Existing native participant lost.'
"${DC_NEW[@]}" up -d --no-deps --pull never web
wait_for_http_status http://127.0.0.1:3100/api/health 200 30
[[ $(docker inspect --format '{{.Config.Image}}' trisoft-kan-web-1) == "trisoft-kan:$RELEASE" ]] || fail 'New image not running.'
# shellcheck disable=SC2016
"${DC_NEW[@]}" exec -T web /nodejs/bin/node -e '
  if(process.env.NEXT_PUBLIC_DISABLE_SIGN_UP!=="true")process.exit(1);
  const origin=process.env.NEXT_PUBLIC_BASE_URL;
  fetch("http://127.0.0.1:3000/api/auth/sign-up/email",{method:"POST",headers:{"content-type":"application/json",origin,host:new URL(origin).host,"x-forwarded-proto":"https"},body:JSON.stringify({name:"Closed signup probe",email:`probe-${require("node:crypto").randomUUID()}@invalid.example`,password:require("node:crypto").randomBytes(24).toString("hex")}),signal:AbortSignal.timeout(10000)}).then(r=>{if(r.status!==400)process.exit(1)}).catch(()=>process.exit(1));
'
# Commit BEFORE reopening. No automatic DB restore once clients can write.
COMMITTED=true
restore_vhost
wait_for_http_status "https://$DOMAIN/api/health" 200 30
wait_for_http_status "https://$DOMAIN/login" 200 10
wait_for_http_status "https://$DOMAIN/api/integrations/v1/boards" 403 10
wait_for_http_status https://redmine.trisoft.ru 200 10
cmp -s "$BACKUP/nginx-https.conf" "$VHOST" || fail 'Kan Nginx configuration not preserved.'
SUCCESS=true
printf 'success\n' > "$BACKUP/upgrade-success"
"${DC_NEW[@]}" ps -a
printf '\nKan upgraded to %s: https://%s. Accounts/data preserved; signup/integration API remain closed. Backup verified and retained: %s\n' "$RELEASE" "$DOMAIN" "$BACKUP"
