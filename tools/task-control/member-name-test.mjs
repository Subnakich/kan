import assert from "node:assert/strict";

import { base, integration, login, rpc } from "./client.mjs";

// New explicitly named local fixtures only. Never rename production accounts.
assert.ok(/^http:\/\/(localhost|127\.0\.0\.1|web)(:\d+)?$/.test(base));
const admin = await login();
const stamp = Date.now();
const email = `rename-${stamp}@kan.local`;
const target = await login(email, "Local-rename-fixture-2026!", email);
const workspace = await rpc(
  admin,
  "workspace.create",
  { name: `Member rename QA ${stamp}` },
  true,
);
const invite = await rpc(
  admin,
  "member.createInviteLink",
  { workspacePublicId: workspace.publicId },
  true,
);
await rpc(
  target,
  "member.acceptInviteLink",
  { inviteCode: invite.inviteCode },
  true,
);
const beforeUser = await rpc(target, "user.getUser", null);
const beforeWorkspace = await rpc(admin, "workspace.byId", {
  workspacePublicId: workspace.publicId,
});
const member = beforeWorkspace.members.find(
  (item) => item.user?.email === email,
);
assert.ok(member);
const board = await rpc(
  admin,
  "board.create",
  {
    workspacePublicId: workspace.publicId,
    name: "Member rename acceptance",
    lists: [],
    labels: [],
  },
  true,
);
await rpc(admin, "taskControl.enable", { boardPublicId: board.publicId }, true);
const { columns } = await rpc(admin, "taskControl.board", {
  boardPublicId: board.publicId,
});
const card = await rpc(
  admin,
  "card.create",
  {
    listPublicId: columns.find((column) => column.role === "review").publicId,
    title: "Name change preserves assignment",
    description: "Local verification",
    memberPublicIds: [member.publicId],
    labelPublicIds: [],
    position: "end",
    dueDate: null,
  },
  true,
);
const beforeCard = await rpc(admin, "taskControl.card", {
  cardPublicId: card.publicId,
});
const input = {
  workspacePublicId: workspace.publicId,
  memberPublicId: member.publicId,
  name: "  Алексей Петров — QA  ",
};
await assert.rejects(
  rpc(target, "member.updateDisplayName", input, true),
  /Only workspace administrators/,
);
await assert.rejects(
  rpc(
    admin,
    "member.updateDisplayName",
    { ...input, name: "person@example.com" },
    true,
  ),
  /3-255/,
);
assert.deepEqual(await rpc(admin, "member.updateDisplayName", input, true), {
  success: true,
  name: input.name.trim(),
});
const afterUser = await rpc(target, "user.getUser", null);
assert.deepEqual({ ...afterUser, name: beforeUser.name }, beforeUser);
const afterWorkspace = await rpc(admin, "workspace.byId", {
  workspacePublicId: workspace.publicId,
});
const afterMember = afterWorkspace.members.find(
  (item) => item.publicId === member.publicId,
);
assert.equal(afterMember.user.name, input.name.trim());
assert.equal(afterMember.user.email, email);
assert.equal(afterMember.user.id, member.user.id);
assert.equal(afterMember.role, member.role);
const afterCard = await rpc(admin, "taskControl.card", {
  cardPublicId: card.publicId,
});
assert.equal(
  afterCard.snapshot.owner_member_public_id,
  beforeCard.snapshot.owner_member_public_id,
);
assert.deepEqual(afterCard.snapshot, beforeCard.snapshot);
assert.equal(
  afterCard.members.find((item) => item.member_public_id === member.publicId)
    .name,
  input.name.trim(),
);
const members = await integration(`/boards/${board.publicId}/members`);
assert.equal(members.status, 200);
assert.equal(
  members.data.find((item) => item.member_public_id === member.publicId).name,
  input.name.trim(),
);
const outsider = await rpc(
  target,
  "workspace.create",
  { name: `Foreign rename QA ${stamp}` },
  true,
);
await assert.rejects(
  rpc(
    admin,
    "member.updateDisplayName",
    { ...input, workspacePublicId: outsider.publicId },
    true,
  ),
  /Only workspace administrators/,
);
const other = await rpc(
  admin,
  "workspace.create",
  { name: `Target boundary QA ${stamp}` },
  true,
);
await assert.rejects(
  rpc(
    admin,
    "member.updateDisplayName",
    { ...input, workspacePublicId: other.publicId },
    true,
  ),
  /Active member account not found/,
);
console.log(
  JSON.stringify({
    success: true,
    workspace: workspace.publicId,
    board: board.publicId,
    member: member.publicId,
    emailAndIdsUnchanged: true,
    cardAssignmentUnchanged: true,
    botMembersUpdated: true,
  }),
);
