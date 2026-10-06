import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  payloadHash,
} from "@kan/db/repository/task-control.repo";

import { taskImportSchema } from "./task-control";

describe("task-control contract", () => {
  it("hashes sorted object keys while preserving array order", () => {
    expect(payloadHash({ b: 1, a: { c: 2 } })).toBe(
      payloadHash({ a: { c: 2 }, b: 1 }),
    );
    expect(payloadHash([1, 2])).not.toBe(payloadHash([2, 1]));
  });
  it("round-trips an opaque cursor", () =>
    expect(decodeCursor(encodeCursor(123))).toBe(123));
  it.each(["hello", "dGFzay12MTo5MDA3MTk5MjU0NzQwOTky", "dGFzay12MTotMQ"])(
    "rejects invalid cursors: %s",
    (cursor) => expect(() => decodeCursor(cursor)).toThrow("Invalid cursor"),
  );
  it("requires explicit timezone for exact deadlines", () => {
    const due = taskImportSchema.shape.task.shape.due_at;
    expect(due.safeParse("2026-10-07T15:30:00+03:00").success).toBe(true);
    expect(due.safeParse("2026-10-07").success).toBe(false);
    expect(due.safeParse("2026-10-07T15:30:00").success).toBe(false);
  });
});
