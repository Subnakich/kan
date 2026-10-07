import assert from "node:assert/strict";

import { base, integration, login, rpc } from "./client.mjs";

// Writes only new, explicitly named local fixtures. Never run against production.
assert.ok(/^http:\/\/(localhost|127\.0\.0\.1|web)(:\d+)?$/.test(base));
const cookie = await login();
const workspace = await rpc(
  cookie,
  "workspace.create",
  {
    name: `Bulk review QA ${Date.now()}`,
  },
  true,
);
const board = await rpc(
  cookie,
  "board.create",
  {
    workspacePublicId: workspace.publicId,
    name: "Bulk review acceptance",
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
const members = (await integration(`/boards/${board.publicId}/members`)).data;
const create = async (title, description, assigned = true) =>
  (
    await rpc(
      cookie,
      "card.create",
      {
        title,
        description,
        listPublicId: column("review"),
        memberPublicIds: assigned ? [members[0].member_public_id] : [],
        labelPublicIds: [],
        position: "end",
        dueDate: null,
      },
      true,
    )
  ).publicId;
const ready = await create("Ready without deadline", "<p>Result checked</p>");
const missing = await create("Missing description", "<p><br></p>");
const noOwner = await create(
  "Missing responsible person",
  "<p>Result checked</p>",
  false,
);
const stale = await create("Changed after review", "<p>Original</p>");
const already = await create("Already confirmed", "<p>Result checked</p>");
const review = await rpc(cookie, "taskControl.reviewCards", {
  boardPublicId: board.publicId,
});
assert.deepEqual(review.find((card) => card.publicId === ready).problems, []);
assert.deepEqual(review.find((card) => card.publicId === missing).problems, [
  "description",
]);
assert.deepEqual(review.find((card) => card.publicId === noOwner).problems, [
  "owner",
]);
await rpc(
  cookie,
  "card.update",
  { cardPublicId: stale, title: "Changed title" },
  true,
);
await rpc(
  cookie,
  "card.update",
  { cardPublicId: already, listPublicId: column("queue") },
  true,
);
const entries = review.map((card) => ({
  cardPublicId: card.publicId,
  expectedRevision: card.revision,
}));
const { results } = await rpc(
  cookie,
  "taskControl.confirmReview",
  { boardPublicId: board.publicId, cards: entries },
  true,
);
assert.equal(results.find((card) => card.publicId === ready).confirmed, true);
for (const id of [missing, noOwner, stale, already]) {
  assert.equal(results.find((card) => card.publicId === id).confirmed, false);
}
assert.match(results.find((card) => card.publicId === stale).error, /changed/);
assert.match(
  results.find((card) => card.publicId === already).error,
  /no longer/,
);
const remaining = await rpc(cookie, "taskControl.reviewCards", {
  boardPublicId: board.publicId,
});
assert.equal(remaining.length, 3);
for (const id of [missing, noOwner, stale])
  assert.ok(remaining.some((card) => card.publicId === id));
const readySnapshot = (await integration(`/cards/${ready}`)).data;
assert.equal(readySnapshot.column_role, "queue");
assert.equal(readySnapshot.due_at, null);
const activity = await rpc(cookie, "card.byId", { cardPublicId: ready });
assert.ok(
  activity.activities.some((item) => item.type === "card.updated.list"),
);
const order = await rpc(cookie, "board.byId", {
  boardPublicId: board.publicId,
});
for (const list of order.lists)
  assert.deepEqual(
    list.cards.map((card) => card.index),
    list.cards.map((_, index) => index),
  );
const repeat = await rpc(
  cookie,
  "taskControl.confirmReview",
  {
    boardPublicId: board.publicId,
    cards: [entries.find((card) => card.cardPublicId === ready)],
  },
  true,
);
assert.equal(repeat.results[0].confirmed, false);
const outsiderBoard = await rpc(
  cookie,
  "board.create",
  {
    workspacePublicId: workspace.publicId,
    name: "Other board",
    lists: [],
    labels: [],
  },
  true,
);
const outside = await rpc(
  cookie,
  "taskControl.confirmReview",
  {
    boardPublicId: outsiderBoard.publicId,
    cards: [entries.find((card) => card.cardPublicId === missing)],
  },
  true,
).then(
  () => false,
  () => true,
);
assert.equal(outside, true, "regular boards cannot use bulk review");
await rpc(
  cookie,
  "taskControl.enable",
  { boardPublicId: outsiderBoard.publicId },
  true,
);
const crossBoard = await rpc(
  cookie,
  "taskControl.confirmReview",
  {
    boardPublicId: outsiderBoard.publicId,
    cards: [entries.find((card) => card.cardPublicId === missing)],
  },
  true,
);
assert.equal(crossBoard.results[0].confirmed, false);
assert.equal(
  (await integration(`/cards/${missing}`)).data.column_role,
  "review",
);
console.log(
  JSON.stringify({
    board: board.publicId,
    ready,
    missing,
    noOwner,
    stale,
    confirmed: 1,
    rejected: 4,
    checks:
      "partial failure, optional deadline, stale revision, repeated confirmation, activity and indices",
  }),
);
