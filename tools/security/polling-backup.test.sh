#!/usr/bin/env bash
# Rehearsal in an isolated LOCAL database, never attached to production volumes.
set -Eeuo pipefail
umask 077
export LC_ALL=C
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
REHEARSAL=kan_polling_rehearsal_$(date +%s)
ARTIFACTS=$(mktemp -d /tmp/kan-polling-rehearsal.XXXXXXXX)
DC=(docker compose -f compose.local.yml)
[[ $("${DC[@]}" exec -T postgres printenv POSTGRES_PASSWORD) == kan-local-only ]]
[[ $("${DC[@]}" exec -T postgres printenv POSTGRES_DB) == kan ]]
pg() { "${DC[@]}" exec -T postgres "$@"; }
CREATED=false
cleanup() { if [[ $CREATED == true ]]; then pg dropdb -w -U kan "$REHEARSAL"; fi; }
trap cleanup EXIT
pg createdb -w -U kan -T template0 "$REHEARSAL"
CREATED=true
pg pg_dump -w -U kan -d kan -Fc > "$ARTIFACTS/local.dump"
pg pg_restore -w -U kan -d "$REHEARSAL" --exit-on-error --single-transaction < "$ARTIFACTS/local.dump"
# The local DB already contains the new schema. Remove it ONLY from our copy.
pg psql -X -w -U kan -d "$REHEARSAL" -v ON_ERROR_STOP=1 -c 'DROP TABLE public.task_control_redmine_request;' >/dev/null
fingerprint() { pg psql -X -w -U kan -d "$REHEARSAL" -At -v ON_ERROR_STOP=1 -v "mode=$1" < deploy/polling-fingerprint.sql; }
fingerprint full > "$ARTIFACTS/before.full"
fingerprint stable > "$ARTIFACTS/before.stable"
pg pg_dump -w -U kan -d "$REHEARSAL" -Fc > "$ARTIFACTS/before.dump"
pg psql -X -w -U kan -d "$REHEARSAL" -v ON_ERROR_STOP=1 < packages/db/migrations/20261006153952_AddRedminePollingQueue.sql >/dev/null
fingerprint stable > "$ARTIFACTS/after.stable"
cmp "$ARTIFACTS/before.stable" "$ARTIFACTS/after.stable"
[[ $(pg psql -X -w -U kan -d "$REHEARSAL" -At -c 'SELECT count(*) FROM public.task_control_redmine_request;') == 0 ]]
printf 'PASS polling migration preserves all old tables and task-control functions\n'
pg pg_restore -w -U kan -d "$REHEARSAL" --clean --if-exists --exit-on-error --single-transaction < "$ARTIFACTS/before.dump"
pg psql -X -w -U kan -d "$REHEARSAL" -v ON_ERROR_STOP=1 -c 'DROP TABLE IF EXISTS public.task_control_redmine_request;' >/dev/null
fingerprint full > "$ARTIFACTS/rollback.full"
cmp "$ARTIFACTS/before.full" "$ARTIFACTS/rollback.full"
printf 'PASS rollback restores full pre-migration fingerprint\nLocal-only evidence: %s\n' "$ARTIFACTS"
