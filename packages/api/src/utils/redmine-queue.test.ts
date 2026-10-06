import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { RedmineRequest } from "@kan/db/repository/redmine-request.repo";
import { requestKey } from "@kan/db/repository/redmine-request.repo";

import {
  redmineRequestSchema,
  replySchema,
  validateReply,
} from "./redmine-queue";

describe("Redmine polling contract", () => {
  const base = { cardPublicId: "card00000001", request_key: "nonce0000001" };
  const row = {
    kind: "preview",
    cardPublicId: base.cardPublicId,
    expectedRevision: 5,
  } as RedmineRequest;
  const preview = {
    preview_id: "preview",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    snapshot: { card_id: base.cardPublicId, revision: 5 },
    warnings: [],
    errors: [],
  };
  const reply = {
    lease_token: randomUUID(),
    state: "completed" as const,
    result: preview,
    error: null,
  };
  it("rejects actor spoofing and arbitrary transport URLs", () => {
    expect(
      redmineRequestSchema.safeParse({
        ...base,
        kind: "projects",
        actor_member_id: "spoof",
      }).success,
    ).toBe(false);
    expect(
      redmineRequestSchema.safeParse({
        ...base,
        kind: "projects",
        url: "https://attacker",
      }).success,
    ).toBe(false);
  });
  it("requires complete preview selection and a fixed public nonce", () => {
    expect(
      redmineRequestSchema.safeParse({ ...base, kind: "preview" }).success,
    ).toBe(false);
    expect(
      redmineRequestSchema.safeParse({
        ...base,
        kind: "projects",
        request_key: "short",
      }).success,
    ).toBe(false);
  });
  it("validates bot response and binds preview to card and revision", () => {
    expect(validateReply(row, reply)).toEqual(preview);
    expect(() =>
      validateReply(row, {
        ...reply,
        result: {
          ...preview,
          snapshot: { card_id: "anothercard1", revision: 5 },
        },
      }),
    ).toThrow("mismatch");
    expect(() =>
      validateReply(row, {
        ...reply,
        result: {
          ...preview,
          snapshot: { card_id: base.cardPublicId, revision: 6 },
        },
      }),
    ).toThrow("mismatch");
  });
  it("rejects wrong result shape, excessive preview expiry and invalid failure", () => {
    expect(() =>
      validateReply(row, { ...reply, result: { items: [] } }),
    ).toThrow();
    expect(() =>
      validateReply(row, {
        ...reply,
        result: {
          ...preview,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    ).toThrow();
    expect(() =>
      validateReply(row, { ...reply, state: "failed", result: null }),
    ).toThrow("Invalid failure");
    expect(
      replySchema.safeParse({ ...reply, lease_token: "wrong" }).success,
    ).toBe(false);
  });
  it("export dedupe is independent of nonce/actor, reads are actor-scoped", () => {
    expect(requestKey("export", "card", "alice", "one")).toBe(
      requestKey("export", "card", "bob", "two"),
    );
    expect(requestKey("projects", "card", "alice", "one")).not.toBe(
      requestKey("projects", "card", "bob", "one"),
    );
  });
});
