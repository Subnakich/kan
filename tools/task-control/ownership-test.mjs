// Real PostgreSQL + HTTP regression test. Creates isolated local demo fixtures.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

import { base, importPayload, integration, login, rpc } from "./client.mjs";

assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
assert.equal(
  process.env.POSTGRES_URL,
  "postgresql://kan:kan-local-only@postgres:5432/kan",
  "Run only in compose.local.yml web",
);
const db = new pg.Client({ connectionString: process.env.POSTGRES_URL });
await db.connect();
const tests = [];
const check = async (name, fn) => {
  await fn();
  tests.push(name);
  console.log(`PASS ${name}`);
};
try {
  const cookie = await login();
  const suffix = Date.now();
  const workspace = await rpc(
    cookie,
    "workspace.create",
    { name: `UI acceptance ${suffix}`, slug: `ui-${suffix}` },
    true,
  );
  const {
    rows: [stored],
  } = await db.query(
    'SELECT id, "createdBy" FROM workspace WHERE "publicId"=$1',
    [workspace.publicId],
  );
  const people = [];
  for (const name of ["Владимир — тест", "Ярослав — тест", "Саша — тест"]) {
    const id = randomUUID();
    const publicId = randomBytes(6).toString("hex");
    const email = `${publicId}@kan.local`;
    await db.query(
      'INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,$2,$3,true)',
      [id, name, email],
    );
    await db.query(
      `INSERT INTO workspace_members ("publicId", email, "userId", "workspaceId", "createdBy", role, "roleId", status)
      VALUES ($1,$2,$3,$4,$5,'member',(SELECT id FROM workspace_roles WHERE "workspaceId"=$4 AND name='member'),'active')`,
      [publicId, email, id, stored.id, stored.createdBy],
    );
    people.push({ member_public_id: publicId, name });
  }
  const board = await rpc(
    cookie,
    "board.create",
    {
      workspacePublicId: workspace.publicId,
      name: "Проверка интерфейса",
      lists: [],
      labels: [],
    },
    true,
  );
  await rpc(
    cookie,
    "taskControl.enable",
    { boardPublicId: board.publicId },
    true,
  );
  const { columns } = await rpc(cookie, "taskControl.board", {
    boardPublicId: board.publicId,
  });
  const column = (role) => columns.find((item) => item.role === role).publicId;
  const snapshot = async (card) => (await integration(`/cards/${card}`)).data;
  const toggle = (card, member) =>
    rpc(
      cookie,
      "card.addOrRemoveMember",
      { cardPublicId: card, workspaceMemberPublicId: member.member_public_id },
      true,
    );
  const move = (card, role) =>
    rpc(
      cookie,
      "card.update",
      { cardPublicId: card, listPublicId: column(role), index: 0 },
      true,
    );
  const create = async (title, members) =>
    (
      await rpc(
        cookie,
        "card.create",
        {
          title,
          description:
            "<p>Проверить результат и зафиксировать его в карточке.</p>",
          listPublicId: column("review"),
          labelPublicIds: [],
          memberPublicIds: members.map((member) => member.member_public_id),
          position: "end",
          dueDate: null,
        },
        true,
      )
    ).publicId;
  const imported = importPayload(
    board.publicId,
    people[0],
    `ownership-${suffix}`,
    "Импорт без срока",
    null,
  );
  const { data: importedCard, status } = await integration(
    "/imports/cards",
    "POST",
    imported,
    imported.external_key,
  );
  assert.equal(status, 201);
  await check(
    "imported responsible person is a native participant",
    async () => {
      const detail = await rpc(cookie, "card.byId", {
        cardPublicId: importedCard.card_id,
      });
      assert.deepEqual(
        detail.members.map((member) => member.publicId),
        [people[0].member_public_id],
      );
    },
  );
  const single = await create("Один участник, без срока", [people[0]]);
  await check(
    "single native participant automatically owns a new card",
    async () => {
      assert.equal(
        (await snapshot(single)).owner_member_public_id,
        people[0].member_public_id,
      );
    },
  );
  await check(
    "removing sole participant in Review clears ownership",
    async () => {
      const before = await snapshot(single);
      await toggle(single, people[0]);
      const after = await snapshot(single);
      assert.equal(after.owner_member_public_id, null);
      assert.ok(after.revision > before.revision);
      assert.equal(after.column_entered_at, before.column_entered_at);
      await toggle(single, people[0]);
    },
  );
  const multiple = await create("Несколько участников", people.slice(0, 2));
  await check(
    "multiple initial participants require an explicit primary",
    async () => {
      assert.equal((await snapshot(multiple)).owner_member_public_id, null);
      await assert.rejects(move(multiple, "queue"), /responsible person/);
    },
  );
  await check("primary selector lists only assigned participants", async () => {
    const detail = await rpc(cookie, "taskControl.card", {
      cardPublicId: multiple,
    });
    assert.deepEqual(
      detail.members.map((member) => member.member_public_id).sort(),
      people
        .slice(0, 2)
        .map((member) => member.member_public_id)
        .sort(),
    );
  });
  await check(
    "unassigned workspace member cannot become primary via API or SQL",
    async () => {
      await assert.rejects(
        rpc(
          cookie,
          "taskControl.update",
          {
            cardPublicId: multiple,
            owner_member_public_id: people[2].member_public_id,
          },
          true,
        ),
        /card participant/,
      );
      await assert.rejects(
        db.query(
          'UPDATE card SET "ownerMemberPublicId"=$1 WHERE "publicId"=$2',
          [people[2].member_public_id, multiple],
        ),
        /card participant/,
      );
    },
  );
  await check("choose primary and confirm without a deadline", async () => {
    await rpc(
      cookie,
      "taskControl.update",
      {
        cardPublicId: multiple,
        owner_member_public_id: people[1].member_public_id,
      },
      true,
    );
    await move(multiple, "queue");
    assert.equal((await snapshot(multiple)).due_at, null);
  });
  await check(
    "deadline can be set and cleared after confirmation",
    async () => {
      const before = await snapshot(multiple);
      await rpc(
        cookie,
        "card.update",
        {
          cardPublicId: multiple,
          dueDate: new Date("2026-10-08T17:45:00+03:00"),
        },
        true,
      );
      await rpc(
        cookie,
        "card.update",
        { cardPublicId: multiple, dueDate: null },
        true,
      );
      const after = await snapshot(multiple);
      assert.equal(after.due_at, null);
      assert.equal(after.deadline_revision, before.deadline_revision + 2);
      assert.equal(after.column_visit_id, before.column_visit_id);
    },
  );
  await check(
    "removing primary transfers ownership to sole remaining participant",
    async () => {
      await toggle(multiple, people[1]);
      assert.equal(
        (await snapshot(multiple)).owner_member_public_id,
        people[0].member_public_id,
      );
    },
  );
  await check(
    "confirmed card cannot lose its last responsible participant",
    async () => {
      await assert.rejects(toggle(multiple, people[0]), /responsible person/);
      assert.equal(
        (await rpc(cookie, "card.byId", { cardPublicId: multiple })).members
          .length,
        1,
      );
    },
  );
  // Leave a multiple-participant Review card for browser acceptance, not production.
  const review = await create("Подготовить итоги планерки", people.slice(0, 2));
  await rpc(
    cookie,
    "taskControl.update",
    {
      cardPublicId: review,
      owner_member_public_id: people[0].member_public_id,
    },
    true,
  );
  console.log(
    JSON.stringify(
      {
        passed: tests.length,
        board: board.publicId,
        review_card: review,
        single_card: single,
        local_only: true,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
