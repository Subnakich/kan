// Rehearse legacy data migration in a rolled-back local PostgreSQL transaction.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

assert.equal(
  process.env.POSTGRES_URL,
  "postgresql://kan:kan-local-only@postgres:5432/kan",
);
const db = new pg.Client({ connectionString: process.env.POSTGRES_URL });
await db.connect();
try {
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(712340)");
  await db.query(
    await readFile(
      "packages/db/migrations/20261006105305_FixTaskControlInsert.sql",
      "utf8",
    ),
  );
  const {
    rows: [context],
  } =
    await db.query(`SELECT l.id AS list_id, b."workspaceId" AS workspace_id, b."createdBy" AS creator
    FROM list l JOIN board b ON b.id=l."boardId" WHERE l."taskRole"='review' AND b."taskControlEnabled"
    AND NOT b."isArchived" AND b."deletedAt" IS NULL AND l."deletedAt" IS NULL
    AND (SELECT count(*) FROM workspace_members m WHERE m."workspaceId"=b."workspaceId" AND m.status='active' AND m."deletedAt" IS NULL)>1 LIMIT 1`);
  assert.ok(context, "Run ownership-test.mjs first to create local fixtures");
  const { rows: members } = await db.query(
    'SELECT id, "publicId" FROM workspace_members WHERE "workspaceId"=$1 AND status=\'active\' AND "deletedAt" IS NULL ORDER BY id LIMIT 2',
    [context.workspace_id],
  );
  const create = async (owner) =>
    (
      await db.query(
        `INSERT INTO card ("publicId", title, description, index, "listId", "createdBy", "cardNumber", "ownerMemberPublicId", "columnEnteredAt")
    VALUES ($1,'Legacy fixture','<p>Keep description</p>',0,$2,$3,9999,$4,'2026-09-01T07:00:00Z') RETURNING *`,
        [
          randomBytes(6).toString("hex"),
          context.list_id,
          context.creator,
          owner,
        ],
      )
    ).rows[0];
  const unassigned = await create(null);
  await db.query(
    'INSERT INTO _card_workspace_members ("cardId","workspaceMemberId") VALUES ($1,$2)',
    [unassigned.id, members[0].id],
  );
  const primary = await create(members[0].publicId);
  await db.query(
    'INSERT INTO _card_workspace_members ("cardId","workspaceMemberId") VALUES ($1,$2)',
    [primary.id, members[1].id],
  );
  const existing = await create(members[0].publicId);
  await db.query(
    await readFile(
      "packages/db/migrations/20261006142318_NativeTaskOwnership.sql",
      "utf8",
    ),
  );
  const { rows: after } = await db.query(
    "SELECT * FROM card WHERE id=ANY($1) ORDER BY id",
    [[unassigned.id, primary.id, existing.id]],
  );
  for (const row of after) {
    assert.equal(row.ownerMemberPublicId, members[0].publicId);
    assert.equal(row.dueDate, null);
    assert.equal(row.description, "<p>Keep description</p>");
    assert.equal(row.columnEnteredAt.toISOString(), "2026-09-01T07:00:00.000Z");
    assert.equal(
      row.columnVisitId,
      [unassigned, primary, existing].find((old) => old.id === row.id)
        .columnVisitId,
    );
  }
  const { rows: roster } = await db.query(
    'SELECT "workspaceMemberId" FROM _card_workspace_members WHERE "cardId"=$1',
    [primary.id],
  );
  assert.equal(roster.length, 2, "Preserve old primary and native participant");
  console.log(
    "PASS legacy primary owners become native participants without losing existing participants",
  );
  console.log("PASS previously unassigned single-participant card gains owner");
  console.log(
    "PASS migration preserves descriptions, optional deadlines and column timers",
  );
} finally {
  await db.query("ROLLBACK");
  await db.end();
}
