import type { CollisionDetection } from "@dnd-kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBoardCollisionDetection } from "./collision";

const detectors = vi.hoisted(() => ({
  pointerWithin: vi.fn<CollisionDetection>(),
  rectIntersection: vi.fn<CollisionDetection>(),
  closestCenter: vi.fn<CollisionDetection>(),
}));
vi.mock("@dnd-kit/core", () => ({
  ...detectors,
  getFirstCollision: (items: { id: string }[]) => items[0]?.id,
}));

const container = (
  id: string,
  data: { type: string; listPublicId?: string },
) => ({
  id,
  data: { current: data },
});
const columns = [
  container("queue", { type: "LIST" }),
  container("queue-body", { type: "LIST_BODY", listPublicId: "queue" }),
  container("progress", { type: "LIST" }),
  container("progress-body", { type: "LIST_BODY", listPublicId: "progress" }),
];
const detect = (containers = columns, type = "CARD") =>
  createBoardCollisionDetection({ current: null })({
    active: { data: { current: { type } } },
    droppableContainers: containers,
  } as unknown as Parameters<CollisionDetection>[0]);

describe("board card drop targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectors.pointerWithin.mockReturnValue([]);
    detectors.rectIntersection.mockReturnValue([]);
    detectors.closestCenter.mockReturnValue([]);
  });
  it("accepts a header or padding drop into an empty column", () => {
    detectors.pointerWithin.mockReturnValue([{ id: "progress" }]);
    expect(detect()).toEqual([{ id: "progress-body" }]);
  });
  it("resolves the header to a card in that column only", () => {
    detectors.pointerWithin.mockReturnValue([{ id: "progress" }]);
    detectors.closestCenter.mockReturnValue([{ id: "target-card" }]);
    expect(
      detect([
        ...columns,
        container("source-card", { type: "CARD", listPublicId: "queue" }),
        container("target-card", { type: "CARD", listPublicId: "progress" }),
      ]),
    ).toEqual([{ id: "target-card" }]);
    expect(
      detectors.closestCenter.mock.calls[0]?.[0].droppableContainers,
    ).toEqual([
      container("target-card", { type: "CARD", listPublicId: "progress" }),
    ]);
  });
  it("preserves body and direct-card drops", () => {
    detectors.pointerWithin.mockReturnValue([{ id: "queue-body" }]);
    expect(detect()).toEqual([{ id: "queue-body" }]);
    detectors.pointerWithin.mockReturnValue([{ id: "a-card" }]);
    expect(
      detect([
        ...columns,
        container("a-card", { type: "CARD", listPublicId: "queue" }),
      ]),
    ).toEqual([{ id: "a-card" }]);
  });
  it("does not route a card to a column with no body", () => {
    detectors.pointerWithin.mockReturnValue([{ id: "missing" }]);
    expect(detect([container("missing", { type: "LIST" })])).toEqual([]);
  });
  it("keeps list reordering limited to list targets", () => {
    detectors.closestCenter.mockReturnValue([{ id: "progress" }]);
    expect(detect(columns, "LIST")).toEqual([{ id: "progress" }]);
    expect(detectors.pointerWithin).not.toHaveBeenCalled();
    expect(
      detectors.closestCenter.mock.calls[0]?.[0].droppableContainers,
    ).toEqual(columns.filter((item) => item.data.current.type === "LIST"));
  });
});
