import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as queue from "@kan/db/repository/redmine-request.repo";
import * as schema from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

import type { TestDbClient } from "./test-db";
import { createTestDb } from "./test-db";

describe("durable Redmine polling queue", () => {
  let db: TestDbClient;
  let listId: number;
  const boardId = "boardqueue01",
    actorId = "actorqueue01";
  beforeAll(async () => {
    db = await createTestDb();
    const [user] = await db
      .insert(schema.users)
      .values({
        id: randomUUID(),
        name: "Queue",
        email: "queue@test.local",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({
        publicId: "spacequeue01",
        name: "Queue",
        slug: "queue",
        createdBy: user!.id,
      })
      .returning();
    await db
      .insert(schema.workspaceMembers)
      .values({
        publicId: actorId,
        userId: user!.id,
        email: user!.email,
        workspaceId: workspace!.id,
        createdBy: user!.id,
        role: "admin",
        status: "active",
      });
    const [board] = await db
      .insert(schema.boards)
      .values({
        publicId: boardId,
        workspaceId: workspace!.id,
        name: "Queue",
        slug: "queue",
        taskControlEnabled: true,
      })
      .returning();
    const [list] = await db
      .insert(schema.lists)
      .values({
        publicId: "listqueue001",
        boardId: board!.id,
        name: "Review",
        index: 0,
        taskRole: "review",
      })
      .returning();
    listId = list!.id;
  }, 30_000);
  afterAll(async () => {
    if (db) await (db.$client as unknown as { close(): Promise<void> }).close();
  });
  async function newRequest(kind: queue.RequestKind = "projects") {
    const cardId = generateUID();
    await db
      .insert(schema.cards)
      .values({ publicId: cardId, title: "Queue test", listId, index: 0 });
    return queue.enqueue(db, {
      cardId,
      kind,
      actorId,
      nonce: generateUID(),
      payload: { method: "GET", path: "/test", body: null },
    });
  }
  it("replays a request key and rejects changed contents", async () => {
    const row = await newRequest();
    const input = {
      cardId: row.cardPublicId,
      kind: "options" as const,
      actorId,
      nonce: generateUID(),
      payload: { x: 1 },
    };
    const a = await queue.enqueue(db, input);
    expect((await queue.enqueue(db, input)).publicId).toBe(a.publicId);
    await expect(
      queue.enqueue(db, { ...input, payload: { x: 2 } }),
    ).rejects.toThrow("different parameters");
  });
  it("only one worker leases each request", async () => {
    const row = await newRequest();
    const results = await Promise.all([
      queue.claim(db, [boardId], 10),
      queue.claim(db, [boardId], 10),
    ]);
    expect(
      results.flat().filter((item) => item.publicId === row.publicId),
    ).toHaveLength(1);
    const ids = results.flat().map((item) => item.publicId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("acknowledgement is idempotent and cannot overwrite terminal result", async () => {
    const row = await newRequest();
    const claimed = (await queue.claim(db, [boardId], 10)).find(
      (r) => r.publicId === row.publicId,
    )!;
    const token = claimed.leaseToken!;
    await queue.settle(
      db,
      row.publicId,
      token,
      "completed",
      { items: [] },
      null,
    );
    expect(
      (
        await queue.settle(
          db,
          row.publicId,
          token,
          "completed",
          { items: [] },
          null,
        )
      ).state,
    ).toBe("completed");
    await expect(
      queue.settle(db, row.publicId, token, "completed", { items: [1] }, null),
    ).rejects.toThrow("Terminal");
    await expect(
      queue.settle(
        db,
        row.publicId,
        randomUUID(),
        "completed",
        { items: [] },
        null,
      ),
    ).rejects.toThrow("another worker");
  });
  it("expired reads can be leased again, invalidating the old token", async () => {
    const row = await newRequest();
    const old = (await queue.claim(db, [boardId], 10)).find(
      (r) => r.publicId === row.publicId,
    )!;
    await db
      .update(schema.redmineRequests)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.redmineRequests.publicId, row.publicId));
    const again = (await queue.claim(db, [boardId], 10)).find(
      (r) => r.publicId === row.publicId,
    )!;
    expect(again.leaseToken).not.toBe(old.leaseToken);
    await expect(
      queue.settle(db, row.publicId, old.leaseToken!, "completed", {}, null),
    ).rejects.toThrow("another worker");
  });
  it("expired export becomes unknown, never re-leased; original worker can reconcile", async () => {
    const row = await newRequest("export");
    const leased = (await queue.claim(db, [boardId], 10)).find(
      (r) => r.publicId === row.publicId,
    )!;
    await db
      .update(schema.redmineRequests)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.redmineRequests.publicId, row.publicId));
    expect(
      (await queue.claim(db, [boardId], 10)).some(
        (r) => r.publicId === row.publicId,
      ),
    ).toBe(false);
    expect((await queue.getRequest(db, row.publicId)).state).toBe("unknown");
    await queue.settle(
      db,
      row.publicId,
      leased.leaseToken!,
      "completed",
      { operation_id: "known" },
      null,
    );
  });
  it("another preview or actor cannot create a second export for a card", async () => {
    const row = await newRequest("export");
    const input = {
      cardId: row.cardPublicId,
      kind: "export" as const,
      actorId,
      nonce: generateUID(),
      payload: { preview_id: "different" },
    };
    expect((await queue.enqueue(db, input)).publicId).toBe(row.publicId);
    await expect(
      queue.enqueue(db, { ...input, actorId: "anotheractor" }),
    ).rejects.toThrow("another actor");
  });
  it("lease renewal requires the current unexpired token", async () => {
    const row = await newRequest();
    const leased = (await queue.claim(db, [boardId], 10)).find(
      (r) => r.publicId === row.publicId,
    )!;
    await expect(queue.renew(db, row.publicId, randomUUID())).rejects.toThrow(
      "another worker",
    );
    expect(
      (
        await queue.renew(db, row.publicId, leased.leaseToken!)
      ).leaseExpiresAt!.getTime(),
    ).toBeGreaterThan(Date.now());
    await db
      .update(schema.redmineRequests)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.redmineRequests.publicId, row.publicId));
    await expect(
      queue.renew(db, row.publicId, leased.leaseToken!),
    ).rejects.toThrow("expired");
  });
  it("board allowlist does not leak or lease another board", async () => {
    await newRequest();
    expect(await queue.claim(db, ["otherboard01"], 10)).toEqual([]);
  });
  it("public response never contains lease token or actor/private transport payload", async () => {
    const row = await newRequest();
    expect(Object.keys(queue.publicRequest(row))).not.toContain("leaseToken");
    expect(Object.keys(queue.publicRequest(row))).not.toContain("payload");
  });
});
