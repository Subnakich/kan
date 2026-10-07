import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as repo from "@kan/db/repository/task-control.repo";

import { assertPermission } from "../utils/permissions";
import { taskControlRouter } from "./task-control";

vi.mock("@kan/db/repository/task-control.repo", async (original) => ({
  ...(await original<typeof repo>()),
  getBoard: vi.fn(),
  reviewCards: vi.fn(),
  confirmReview: vi.fn(),
}));
vi.mock("../utils/permissions", () => ({ assertPermission: vi.fn() }));

const boardPublicId = "board0000001";
const item = (id: string) => ({ cardPublicId: id, expectedRevision: 2 });
const caller = (user: { id: string } | null = { id: "reviewer" }) =>
  taskControlRouter.createCaller({ user, db: {} } as never);

describe("bulk review session boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repo.getBoard).mockResolvedValue({ workspaceId: 1 } as never);
    vi.mocked(assertPermission).mockResolvedValue(undefined);
    vi.mocked(repo.confirmReview).mockResolvedValue({
      publicId: "card00000001",
    });
  });
  it("requires an authenticated user", async () => {
    await expect(
      caller(null).confirmReview({
        boardPublicId,
        cards: [item("card00000001")],
      }),
    ).rejects.toThrow(TRPCError);
    expect(repo.confirmReview).not.toHaveBeenCalled();
  });
  it("checks card:edit before processing any card", async () => {
    vi.mocked(assertPermission).mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN" }),
    );
    await expect(
      caller().confirmReview({ boardPublicId, cards: [item("card00000001")] }),
    ).rejects.toThrow(TRPCError);
    expect(assertPermission).toHaveBeenCalledWith(
      {},
      "reviewer",
      1,
      "card:edit",
    );
    expect(repo.confirmReview).not.toHaveBeenCalled();
  });
  it("continues after a validation failure and returns individual results", async () => {
    vi.mocked(repo.confirmReview).mockRejectedValueOnce(
      new repo.TaskControlError(
        "Card changed. Reload and review it again",
        409,
      ),
    );
    const result = await caller().confirmReview({
      boardPublicId,
      cards: [item("card00000001"), item("card00000002")],
    });
    expect(result.results).toEqual([
      {
        publicId: "card00000001",
        confirmed: false,
        error: "Card changed. Reload and review it again",
      },
      { publicId: "card00000002", confirmed: true, error: null },
    ]);
    expect(repo.confirmReview).toHaveBeenLastCalledWith(
      {},
      boardPublicId,
      item("card00000002"),
      "reviewer",
    );
  });
  it("does not expose SQL or other unexpected error details", async () => {
    vi.mocked(repo.confirmReview).mockRejectedValueOnce(
      new Error("private SQL payload"),
    );
    const result = await caller().confirmReview({
      boardPublicId,
      cards: [item("card00000001")],
    });
    expect(JSON.stringify(result)).not.toContain("private SQL");
    expect(result.results[0]?.confirmed).toBe(false);
  });
  it.each([
    { name: "empty", cards: [] },
    { name: "duplicate", cards: [item("card00000001"), item("card00000001")] },
    {
      name: "oversized",
      cards: Array.from({ length: 101 }, (_, i) =>
        item(String(i).padStart(12, "0")),
      ),
    },
  ])("rejects $name selections", async ({ cards }) => {
    await expect(
      caller().confirmReview({ boardPublicId, cards }),
    ).rejects.toThrow();
    expect(repo.confirmReview).not.toHaveBeenCalled();
  });
  it("checks viewing permission for the review list", async () => {
    vi.mocked(repo.reviewCards).mockResolvedValue([]);
    expect(await caller().reviewCards({ boardPublicId })).toEqual([]);
    expect(assertPermission).toHaveBeenCalledWith(
      {},
      "reviewer",
      1,
      "card:view",
    );
  });
});
