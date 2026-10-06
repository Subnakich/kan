import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  base,
  hash,
  importPayload,
  integration,
  login,
  rpc,
} from "./client.mjs";
import { queuedMock } from "./mock-queue-client.mjs";

const cookie = await login();
const workspace = (await rpc(cookie, "workspace.all", null))[0].workspace;
const board = await rpc(
  cookie,
  "board.create",
  {
    workspacePublicId: workspace.publicId,
    name: `API audit ${Date.now()}`,
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
const columns = (
  await rpc(cookie, "taskControl.board", { boardPublicId: board.publicId })
).columns;
const member = (await integration(`/boards/${board.publicId}/members`)).data[0];
const role = (name) => columns.find((item) => item.role === name).publicId;
const move = (card, name, index = 0) =>
  rpc(
    cookie,
    "card.update",
    { cardPublicId: card, listPublicId: role(name), index },
    true,
  );
const snapshot = async (id) => (await integration(`/cards/${id}`)).data;
const tests = [];
async function check(name, run) {
  await run();
  tests.push(name);
  console.log(`PASS ${name}`);
}
const payload = importPayload(
  board.publicId,
  member,
  `audit-${Date.now()}`,
  "Audit task",
);
payload.task.labels = ["Meeting", "Meeting"];
payload.payload_hash = hash({
  board_id: payload.board_id,
  meeting: payload.meeting,
  task: payload.task,
});
let card;
await check("service token required", async () => {
  const res = await fetch(`${base}/api/integrations/v1/boards`);
  assert.equal(res.status, 401);
});
await check("concurrent import creates one card", async () => {
  const replies = await Promise.all(
    Array.from({ length: 4 }, () =>
      integration("/imports/cards", "POST", payload, payload.external_key),
    ),
  );
  assert.equal(replies.filter((item) => item.status === 201).length, 1);
  assert.equal(new Set(replies.map((item) => item.data.card_id)).size, 1);
  card = replies[0].data.card_id;
});
await check("different contents conflict", async () => {
  const changed = { ...payload, task: { ...payload.task, title: "Changed" } };
  changed.payload_hash = hash({
    board_id: changed.board_id,
    meeting: changed.meeting,
    task: changed.task,
  });
  assert.equal(
    (await integration("/imports/cards", "POST", changed, changed.external_key))
      .status,
    409,
  );
});
await check("import creates Review with native checklist", async () => {
  const task = await snapshot(card);
  assert.equal(task.column_role, "review");
  assert.equal(task.owner_member_public_id, member.member_public_id);
  assert.equal(task.checklist[0].items.length, 2);
  assert.equal(task.due_at, "2026-10-07T12:30:00.000Z");
  assert.deepEqual(
    task.labels.map((label) => label.name),
    ["Meeting"],
  );
});
await check("outsider cannot read or edit task control", async () => {
  const outsider = await login(
    "outsider@kan.local",
    "Kan-local-demo-2026!",
    "Outsider — local test",
  );
  await assert.rejects(
    rpc(outsider, "taskControl.card", { cardPublicId: card }),
    /permission/,
  );
  await assert.rejects(
    rpc(
      outsider,
      "taskControl.update",
      { cardPublicId: card, blocker_reason: "forbidden" },
      true,
    ),
    /permission/,
  );
});
await check(
  "exact deadline updates increment only the deadline revision",
  async () => {
    const before = await snapshot(card);
    await rpc(
      cookie,
      "card.update",
      { cardPublicId: card, dueDate: new Date("2026-10-07T15:45:00+03:00") },
      true,
    );
    const after = await snapshot(card);
    assert.equal(after.due_at, "2026-10-07T12:45:00.000Z");
    assert.equal(after.deadline_revision, before.deadline_revision + 1);
    assert.equal(after.column_visit_id, before.column_visit_id);
  },
);
await check("cannot bypass Review directly to Done", async () =>
  assert.rejects(move(card, "done"), /Queue first/),
);
const incomplete = importPayload(
  board.publicId,
  null,
  `incomplete-${Date.now()}`,
  "Needs clarification",
  null,
);
const missing = (
  await integration(
    "/imports/cards",
    "POST",
    incomplete,
    incomplete.external_key,
  )
).data.card_id;
await check("missing owner blocks confirmation, not the deadline", async () =>
  assert.rejects(move(missing, "queue"), /description and responsible person/),
);
await check(
  "native participant becomes owner and can confirm without a deadline",
  async () => {
    const before = await snapshot(missing);
    await rpc(
      cookie,
      "card.addOrRemoveMember",
      {
        cardPublicId: missing,
        workspaceMemberPublicId: member.member_public_id,
      },
      true,
    );
    const task = await snapshot(missing);
    assert.equal(task.owner_member_public_id, member.member_public_id);
    assert.equal(task.due_at, null);
    assert.ok(task.revision > before.revision);
    assert.equal(task.column_visit_id, before.column_visit_id);
    await move(missing, "queue");
    assert.equal((await snapshot(missing)).column_role, "queue");
  },
);
await check("confirmed task moves to Queue", async () => {
  await move(card, "queue");
  assert.equal((await snapshot(card)).column_role, "queue");
});
await check("Blocked requires a reason", async () =>
  assert.rejects(move(card, "blocked"), /blocker reason/),
);
await check("column visit changes only on movement", async () => {
  const before = await snapshot(card);
  await rpc(
    cookie,
    "card.addComment",
    { cardPublicId: card, comment: "<p>Audit comment</p>" },
    true,
  );
  await move(card, "queue");
  const after = await snapshot(card);
  assert.equal(after.column_visit_id, before.column_visit_id);
  assert.equal(after.column_entered_at, before.column_entered_at);
  assert.ok(after.revision > before.revision);
});
await check("Blocked and return create new visits", async () => {
  const before = await snapshot(card);
  await rpc(
    cookie,
    "taskControl.update",
    { cardPublicId: card, blocker_reason: "Waiting for test access" },
    true,
  );
  await move(card, "blocked");
  assert.notEqual(
    (await snapshot(card)).column_visit_id,
    before.column_visit_id,
  );
  await move(card, "queue");
  assert.notEqual(
    (await snapshot(card)).column_visit_id,
    before.column_visit_id,
  );
});
let preview;
await check("capabilities advertises polling queue", async () => {
  assert.ok(
    (await integration("/capabilities")).data.features.includes(
      "redmine_polling_queue_v1",
    ),
  );
});
await check("queue claim requires service token", async () => {
  const res = await fetch(
    `${base}/api/integrations/v1/redmine/requests/claim`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ board_ids: [board.publicId] }),
    },
  );
  assert.equal(res.status, 401);
});
await check(
  "queue result validates lease/schema and replays acknowledgement",
  async () => {
    const input = {
      cardPublicId: card,
      request_key: randomUUID().replaceAll("-", "").slice(0, 12),
      kind: "projects",
    };
    const first = await rpc(cookie, "taskControl.redmineRequest", input, true);
    assert.equal(
      (await rpc(cookie, "taskControl.redmineRequest", input, true)).request_id,
      first.request_id,
    );
    const replies = await Promise.all(
      [1, 2].map(() =>
        integration("/redmine/requests/claim", "POST", {
          board_ids: [board.publicId],
          limit: 10,
        }),
      ),
    );
    const jobs = replies
      .flatMap((r) => r.data.items)
      .filter((r) => r.request_id === first.request_id);
    assert.equal(jobs.length, 1);
    const job = jobs[0];
    const body = {
      lease_token: job.lease_token,
      state: "completed",
      result: { items: [], has_more: false, next_cursor: null, demo: true },
      error: null,
    };
    const path = `/redmine/requests/${first.request_id}/result`;
    assert.equal(
      (await integration(path, "POST", { ...body, lease_token: randomUUID() }))
        .status,
      409,
    );
    assert.equal(
      (await integration(path, "POST", { ...body, result: { invalid: true } }))
        .status,
      422,
    );
    assert.equal((await integration(path, "POST", body)).status, 200);
    assert.equal((await integration(path, "POST", body)).status, 200);
    assert.equal(
      (
        await integration(path, "POST", {
          ...body,
          result: { ...body.result, demo: false },
        })
      ).status,
      409,
    );
    const value = await rpc(cookie, "taskControl.redmineRequestStatus", {
      cardPublicId: card,
      request_id: first.request_id,
    });
    assert.equal(value.state, "completed");
    assert.equal(value.lease_token, undefined);
    assert.equal(value.result.kind, "projects");
  },
);
await check("queued mock export previews complete snapshot", async () => {
  preview = await queuedMock(cookie, card, "preview", {
    expected_revision: (await snapshot(card)).revision,
    project_id: 1,
    tracker_id: 1,
    status_id: 1,
    priority_id: 2,
    custom_fields: [],
  });
  assert.ok(preview.snapshot.comments.length);
  assert.ok(preview.snapshot.redmine.description.includes("12:45:00.000Z"));
});
await check("stale preview is rejected", async () => {
  await rpc(
    cookie,
    "card.addComment",
    { cardPublicId: card, comment: "<p>Changed after preview</p>" },
    true,
  );
  await assert.rejects(
    queuedMock(cookie, card, "export", { preview_id: preview.preview_id }),
    /Card changed/,
  );
});
await check(
  "repeated export creates one mock issue and keeps Queue",
  async () => {
    preview = await queuedMock(cookie, card, "preview", {
      expected_revision: (await snapshot(card)).revision,
      project_id: 1,
      tracker_id: 1,
      status_id: 1,
      priority_id: 2,
      custom_fields: [],
    });
    const first = await queuedMock(cookie, card, "export", {
      preview_id: preview.preview_id,
    });
    const again = await queuedMock(cookie, card, "export", {
      preview_id: preview.preview_id,
    });
    assert.equal(again.operation_id, first.operation_id);
    assert.equal((await snapshot(card)).column_role, "queue");
    assert.equal(
      (await snapshot(card)).redmine_link.display_id,
      first.redmine_link.display_id,
    );
  },
);
await check("required columns cannot be deleted", async () =>
  assert.rejects(
    rpc(cookie, "list.delete", { listPublicId: role("review") }, true),
    /required columns/,
  ),
);
await check("deletion leaves tombstone, not an active card", async () => {
  await rpc(cookie, "card.delete", { cardPublicId: missing }, true);
  assert.equal((await integration(`/cards/${missing}`)).status, 404);
  assert.equal(
    (
      await integration(
        "/imports/cards",
        "POST",
        incomplete,
        incomplete.external_key,
      )
    ).status,
    410,
  );
  assert.equal(
    (
      await integration(
        `/imports/cards?external_key=${encodeURIComponent(incomplete.external_key)}`,
      )
    ).data.status,
    "deleted",
  );
});
await check("durable changes include deletion and support resume", async () => {
  // Force at least two outbox pages, without consuming the user API rate limit.
  for (let i = 0; i < 30; i++) {
    const item = importPayload(
      board.publicId,
      member,
      `pagination-${Date.now()}-${i}`,
      `Pagination test ${i}`,
    );
    const reply = await integration(
      "/imports/cards",
      "POST",
      item,
      item.external_key,
    );
    assert.equal(reply.status, 201);
  }
  let cursor;
  let seen = false;
  let pages = 0;
  while (true) {
    const result = await integration(
      `/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    assert.equal(result.status, 200);
    seen ||= result.data.items.some(
      (item) => item.card_id === missing && item.kind === "deleted",
    );
    cursor = result.data.next_cursor;
    pages++;
    if (!result.data.has_more) break;
  }
  assert.ok(seen);
  assert.ok(pages >= 2);
  assert.equal(
    (await integration(`/changes?cursor=${encodeURIComponent(cursor)}`)).data
      .items.length,
    0,
  );
  console.log(`Outbox pages: ${pages}`);
});
await check(
  "archiving stops snapshot access and emits durable events",
  async () => {
    await rpc(
      cookie,
      "board.update",
      { boardPublicId: board.publicId, isArchived: true },
      true,
    );
    assert.equal((await integration(`/cards/${card}`)).status, 410);
    assert.equal(
      (await integration(`/boards/${board.publicId}/cards`)).status,
      410,
    );
  },
);
console.log(
  // The audit board remains recoverable in Archived; no demo/user content is deleted.
  JSON.stringify(
    { passed: tests.length, tests, board: board.publicId, mock_only: true },
    null,
    2,
  ),
);
