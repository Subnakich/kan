import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import { redmineRequests, workspaceMembers } from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

import {
  cardAccess,
  getSnapshot,
  payloadHash,
  TaskControlError,
} from "./task-control.repo";

export type RedmineRequest = typeof redmineRequests.$inferSelect;
export type RequestKind =
  | "projects"
  | "options"
  | "preview"
  | "export"
  | "operation";
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 10;

export function requestKey(
  kind: RequestKind,
  card: string,
  actor: string,
  nonce: string,
) {
  // An export is never blindly enqueued a second time, even by another actor.
  return payloadHash(
    kind === "export" ? { kind, card } : { kind, card, actor, nonce },
  );
}

export function publicRequest(row: RedmineRequest) {
  return {
    request_id: row.publicId,
    card_id: row.cardPublicId,
    kind: row.kind,
    state: row.state,
    result: row.result,
    error: row.error,
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function getRequest(db: dbClient, id: string) {
  const row = await db.query.redmineRequests.findFirst({
    where: eq(redmineRequests.publicId, id),
  });
  if (!row) throw new TaskControlError("Redmine request not found", 404);
  return row;
}

export async function requestActor(db: dbClient, row: RedmineRequest) {
  const card = await cardAccess(db, row.cardPublicId);
  const member = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.publicId, row.actorMemberPublicId),
      eq(workspaceMembers.workspaceId, card.list.board.workspaceId),
      eq(workspaceMembers.status, "active"),
      isNull(workspaceMembers.deletedAt),
    ),
  });
  if (!member?.userId)
    throw new TaskControlError("Request actor is no longer active", 403);
  return { userId: member.userId, workspaceId: member.workspaceId };
}

export async function enqueue(
  db: dbClient,
  input: {
    kind: RequestKind;
    cardId: string;
    actorId: string;
    nonce: string;
    payload: Record<string, unknown>;
    expectedRevision?: number;
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM card WHERE "publicId" = ${input.cardId} FOR UPDATE`,
    );
    const card = await getSnapshot(tx as unknown as dbClient, input.cardId);
    const key = requestKey(
      input.kind,
      input.cardId,
      input.actorId,
      input.nonce,
    );
    const hash = payloadHash(input.payload);
    const existing = await tx.query.redmineRequests.findFirst({
      where: eq(redmineRequests.requestKey, key),
    });
    if (existing) {
      if (existing.actorMemberPublicId !== input.actorId)
        throw new TaskControlError("Export belongs to another actor", 409);
      if (input.kind !== "export" && existing.payloadHash !== hash)
        throw new TaskControlError(
          "Request key reused with different parameters",
          409,
        );
      return existing;
    }
    if (input.kind === "export" && card.redmine_link)
      throw new TaskControlError("Card is already exported", 409);
    const pending = await tx
      .select({ id: redmineRequests.publicId })
      .from(redmineRequests)
      .where(
        and(
          eq(redmineRequests.cardPublicId, input.cardId),
          eq(redmineRequests.actorMemberPublicId, input.actorId),
          inArray(redmineRequests.state, ["queued", "leased"]),
        ),
      )
      .limit(20);
    if (pending.length >= 20)
      throw new TaskControlError(
        "Too many pending requests; wait for the bot",
        429,
      );
    if (
      input.expectedRevision !== undefined &&
      card.revision !== input.expectedRevision
    )
      throw new TaskControlError("Card changed; request a new preview", 409);
    const [row] = await tx
      .insert(redmineRequests)
      .values({
        publicId: generateUID(),
        requestKey: key,
        payloadHash: hash,
        kind: input.kind,
        cardPublicId: input.cardId,
        boardPublicId: card.board_id,
        workspacePublicId: card.workspace_id,
        actorMemberPublicId: input.actorId,
        expectedRevision: input.expectedRevision ?? card.revision,
        payload: input.payload,
      })
      .returning();
    if (!row) throw new TaskControlError("Request creation failed", 500);
    return row;
  });
}

export async function findPreview(
  db: dbClient,
  cardId: string,
  actorId: string,
  previewId: string,
) {
  const row = await db.query.redmineRequests.findFirst({
    where: and(
      eq(redmineRequests.cardPublicId, cardId),
      eq(redmineRequests.actorMemberPublicId, actorId),
      eq(redmineRequests.kind, "preview"),
      eq(redmineRequests.state, "completed"),
      sql`${redmineRequests.result}->>'preview_id' = ${previewId}`,
    ),
  });
  if (!row)
    throw new TaskControlError(
      "Preview does not belong to this card/actor",
      409,
    );
  return row;
}

export async function exportRequest(
  db: dbClient,
  cardId: string,
  actorId: string,
) {
  return db.query.redmineRequests.findFirst({
    where: and(
      eq(redmineRequests.cardPublicId, cardId),
      eq(redmineRequests.kind, "export"),
      eq(redmineRequests.actorMemberPublicId, actorId),
    ),
  });
}

export async function claim(db: dbClient, boardIds: string[], limit: number) {
  return db.transaction(async (tx) => {
    const now = new Date();
    // A timeout after a write might mean the issue exists. NEVER re-lease it.
    await tx
      .update(redmineRequests)
      .set({
        state: "unknown",
        error: "Export lease expired; bot journal reconciliation required",
        updatedAt: now,
      })
      .where(
        and(
          inArray(redmineRequests.boardPublicId, boardIds),
          eq(redmineRequests.kind, "export"),
          eq(redmineRequests.state, "leased"),
          lt(redmineRequests.leaseExpiresAt, now),
        ),
      );
    await tx
      .update(redmineRequests)
      .set({
        state: "failed",
        error: "Bot retry limit reached",
        updatedAt: now,
      })
      .where(
        and(
          inArray(redmineRequests.boardPublicId, boardIds),
          ne(redmineRequests.kind, "export"),
          eq(redmineRequests.state, "leased"),
          lt(redmineRequests.leaseExpiresAt, now),
          sql`${redmineRequests.attempts} >= ${MAX_ATTEMPTS}`,
        ),
      );
    const rows = await tx
      .select()
      .from(redmineRequests)
      .where(
        and(
          inArray(redmineRequests.boardPublicId, boardIds),
          or(
            eq(redmineRequests.state, "queued"),
            and(
              ne(redmineRequests.kind, "export"),
              eq(redmineRequests.state, "leased"),
              lt(redmineRequests.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(redmineRequests.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed: RedmineRequest[] = [];
    for (const row of rows) {
      const [updated] = await tx
        .update(redmineRequests)
        .set({
          state: "leased",
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          attempts: row.attempts + 1,
          updatedAt: now,
        })
        .where(eq(redmineRequests.publicId, row.publicId))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

export async function renew(db: dbClient, id: string, token: string) {
  const now = new Date();
  const [row] = await db
    .update(redmineRequests)
    .set({ leaseExpiresAt: new Date(now.getTime() + LEASE_MS), updatedAt: now })
    .where(
      and(
        eq(redmineRequests.publicId, id),
        eq(redmineRequests.leaseToken, token),
        eq(redmineRequests.state, "leased"),
        sql`${redmineRequests.leaseExpiresAt} > ${now}`,
      ),
    )
    .returning();
  if (!row)
    throw new TaskControlError(
      "Lease expired or belongs to another worker",
      409,
    );
  return row;
}

export async function settle(
  db: dbClient,
  id: string,
  token: string,
  state: "completed" | "failed" | "unknown",
  result: Record<string, unknown> | null,
  error: string | null,
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(redmineRequests)
      .where(eq(redmineRequests.publicId, id))
      .for("update");
    if (!row) throw new TaskControlError("Request not found", 404);
    if (row.leaseToken !== token)
      throw new TaskControlError("Lease belongs to another worker", 409);
    // Idempotent acknowledgement after a lost HTTP response.
    if (
      row.state === state &&
      payloadHash(row.result) === payloadHash(result) &&
      row.error === error
    )
      return row;
    if (row.state === "completed" || row.state === "failed")
      throw new TaskControlError("Terminal result cannot be replaced", 409);
    if (
      row.state !== "leased" &&
      !(row.kind === "export" && row.state === "unknown")
    )
      throw new TaskControlError("Request is not leased", 409);
    const [updated] = await tx
      .update(redmineRequests)
      .set({ state, result, error, updatedAt: new Date() })
      .where(eq(redmineRequests.publicId, id))
      .returning();
    if (!updated) throw new TaskControlError("Acknowledgement failed", 500);
    return updated;
  });
}
