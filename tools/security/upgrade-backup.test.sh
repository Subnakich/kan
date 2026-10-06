#!/usr/bin/env bash
# Real local PostgreSQL rehearsal. Never operates on production or its DB name.
set -Eeuo pipefail
export LC_ALL=C
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$ROOT"
DB=kan_upgrade_rehearsal_$(date +%s)
ARTIFACTS=$(mktemp -d /tmp/kan-upgrade-rehearsal.XXXXXXXX)
DC=(docker compose -f compose.local.yml)
[[ $("${DC[@]}" exec -T postgres printenv POSTGRES_PASSWORD) == kan-local-only ]] || exit 1
[[ $("${DC[@]}" exec -T postgres printenv POSTGRES_DB) == kan ]] || exit 1
pg() { "${DC[@]}" exec -T postgres "$@"; }
CREATED=false
cleanup() { if [[ $CREATED == true ]]; then pg dropdb -w -U kan "$DB"; fi; }
trap cleanup EXIT
pg createdb -w -U kan -T template0 "$DB"
CREATED=true
pg pg_dump -w -U kan -d kan -Fc > "$ARTIFACTS/local.dump"
pg pg_restore -w -U kan -d "$DB" --exit-on-error --single-transaction < "$ARTIFACTS/local.dump"
pg psql -X -w -U kan -d "$DB" -v ON_ERROR_STOP=1 < packages/db/migrations/20261006105305_FixTaskControlInsert.sql >/dev/null
# Insert a realistic old Review card: native participant set, independent owner absent.
pg psql -X -w -U kan -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
WITH c AS (
  INSERT INTO card ("publicId",title,description,index,"listId","createdBy","cardNumber")
  SELECT 'rehearse0001','Legacy test','<p>Keep task</p>',0,l.id,b."createdBy",999999
  FROM list l JOIN board b ON b.id=l."boardId"
  WHERE l."taskRole"='review' AND b."taskControlEnabled" AND NOT b."isArchived"
    AND b."deletedAt" IS NULL AND l."deletedAt" IS NULL LIMIT 1 RETURNING id,"listId"
)
INSERT INTO _card_workspace_members ("cardId","workspaceMemberId")
SELECT c.id,(SELECT m.id FROM workspace_members m WHERE m."workspaceId"=b."workspaceId"
  AND m.status='active' AND m."deletedAt" IS NULL ORDER BY id LIMIT 1)
FROM c JOIN list l ON l.id=c."listId" JOIN board b ON b.id=l."boardId";
SQL
fingerprint() { pg psql -X -w -U kan -d "$DB" -At -v ON_ERROR_STOP=1 -v "mode=$1" < deploy/upgrade-fingerprint.sql; }
fingerprint full > "$ARTIFACTS/before.full"
fingerprint stable > "$ARTIFACTS/before.stable"
pg pg_dump -w -U kan -d "$DB" -Fc > "$ARTIFACTS/legacy.dump"
pg psql -X -w -U kan -d "$DB" -v ON_ERROR_STOP=1 < packages/db/migrations/20261006142318_NativeTaskOwnership.sql >/dev/null
fingerprint stable > "$ARTIFACTS/after.stable"
cmp "$ARTIFACTS/before.stable" "$ARTIFACTS/after.stable"
[[ $(pg psql -X -w -U kan -d "$DB" -At -c "SELECT \"ownerMemberPublicId\" IS NOT NULL FROM card WHERE \"publicId\"='rehearse0001';") == t ]]
printf 'PASS migration preserves business/account fingerprints while updating ownership/outbox\n'
pg pg_restore -w -U kan -d "$DB" --clean --if-exists --exit-on-error --single-transaction < "$ARTIFACTS/legacy.dump"
fingerprint full > "$ARTIFACTS/rollback.full"
cmp "$ARTIFACTS/before.full" "$ARTIFACTS/rollback.full"
[[ $(pg psql -X -w -U kan -d "$DB" -At -c "SELECT \"ownerMemberPublicId\" IS NULL FROM card WHERE \"publicId\"='rehearse0001';") == t ]]
printf 'PASS dump/restore rollback restores data, old owners, schema guard and migration journal\n'
printf 'Local-only evidence retained: %s\n' "$ARTIFACTS"
