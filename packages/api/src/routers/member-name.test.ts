import { beforeEach, describe, expect, it, vi } from "vitest";

import * as memberRepo from "@kan/db/repository/member.repo";
import * as permissionRepo from "@kan/db/repository/permission.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { assertPermission } from "../utils/permissions";
import { memberRouter } from "./member";

vi.mock("@kan/db/repository/member.repo", async (original) => ({
  ...(await original<typeof memberRepo>()),
  getByPublicId: vi.fn(),
  updateDisplayName: vi.fn(),
}));
vi.mock("@kan/db/repository/permission.repo", async (original) => ({
  ...(await original<typeof permissionRepo>()),
  getMemberWithRole: vi.fn(),
}));
vi.mock("@kan/db/repository/workspace.repo", async (original) => ({
  ...(await original<typeof workspaceRepo>()),
  getByPublicId: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({ assertPermission: vi.fn() }));

const input = {
  workspacePublicId: "workspace001",
  memberPublicId: "member000001",
  name: "  Алексей Петров  ",
};
const member = {
  workspaceId: 1,
  userId: "target-account",
  status: "active",
  deletedAt: null,
};
const caller = (user: { id: string } | null = { id: "admin-account" }) =>
  memberRouter.createCaller({ user, db: {} } as never);

describe("administrator member rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceRepo.getByPublicId).mockResolvedValue({
      id: 1,
      deletedAt: null,
    } as never);
    vi.mocked(permissionRepo.getMemberWithRole).mockResolvedValue({
      role: "admin",
    } as never);
    vi.mocked(assertPermission).mockResolvedValue(undefined);
    vi.mocked(memberRepo.getByPublicId).mockResolvedValue(member as never);
    vi.mocked(memberRepo.updateDisplayName).mockResolvedValue({
      name: "Алексей Петров",
    });
  });
  it("renames by public member ID, trims whitespace and exposes no account IDs", async () => {
    const result = await caller().updateDisplayName(input);
    expect(result).toEqual({ success: true, name: "Алексей Петров" });
    expect(assertPermission).toHaveBeenCalledWith(
      {},
      "admin-account",
      1,
      "member:edit",
    );
    expect(memberRepo.updateDisplayName).toHaveBeenCalledWith(
      {},
      {
        workspaceId: 1,
        memberPublicId: input.memberPublicId,
        administratorUserId: "admin-account",
        name: "Алексей Петров",
      },
    );
  });
  it("requires authentication", async () => {
    await expect(caller(null).updateDisplayName(input)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(memberRepo.updateDisplayName).not.toHaveBeenCalled();
  });
  it.each(["member", "guest", null])(
    "rejects actor role %j even if member:edit is granted",
    async (role) => {
      vi.mocked(permissionRepo.getMemberWithRole).mockResolvedValue(
        role ? ({ role } as never) : undefined,
      );
      await expect(caller().updateDisplayName(input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(memberRepo.updateDisplayName).not.toHaveBeenCalled();
    },
  );
  it("respects revoked administrator member:edit permission", async () => {
    const { TRPCError } = await import("@trpc/server");
    vi.mocked(assertPermission).mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN" }),
    );
    await expect(caller().updateDisplayName(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(memberRepo.updateDisplayName).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    { ...member, workspaceId: 2 },
    { ...member, status: "invited" },
    { ...member, status: "paused" },
    { ...member, userId: null },
    { ...member, deletedAt: new Date() },
  ])("rejects unavailable or foreign target %j", async (target) => {
    vi.mocked(memberRepo.getByPublicId).mockResolvedValue(target as never);
    await expect(caller().updateDisplayName(input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(memberRepo.updateDisplayName).not.toHaveBeenCalled();
  });
  it.each([undefined, { id: 1, deletedAt: new Date() }])(
    "rejects missing or deleted workspace %j",
    async (workspace) => {
      vi.mocked(workspaceRepo.getByPublicId).mockResolvedValue(
        workspace as never,
      );
      await expect(caller().updateDisplayName(input)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(memberRepo.updateDisplayName).not.toHaveBeenCalled();
    },
  );
  it("reports a guarded write rejected after membership changed", async () => {
    vi.mocked(memberRepo.updateDisplayName).mockResolvedValue(undefined);
    await expect(caller().updateDisplayName(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it.each([
    "ab",
    "",
    "user@example.com",
    "Name <user@example.com>",
    "a".repeat(256),
    "Name\nSurname",
  ])("rejects invalid name %j before any write", async (name) => {
    await expect(
      caller().updateDisplayName({ ...input, name }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(memberRepo.updateDisplayName).not.toHaveBeenCalled();
  });
  it("rejects invalid public IDs", async () => {
    await expect(
      caller().updateDisplayName({ ...input, memberPublicId: "foreign" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(memberRepo.updateDisplayName).not.toHaveBeenCalled();
  });
});
