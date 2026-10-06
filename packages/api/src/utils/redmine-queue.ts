import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as queue from "@kan/db/repository/redmine-request.repo";
import {
  getSnapshot,
  TaskControlError,
} from "@kan/db/repository/task-control.repo";

import {
  exportSchema,
  optionsSchema,
  previewSchema,
  projectsSchema,
} from "./task-gateway";

const id = z.string().length(12);
const base = { cardPublicId: id, request_key: id };
export const redmineRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("projects"),
      cursor: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("options"),
      project_id: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("preview"),
      expected_revision: z.number().int().positive(),
      project_id: z.number().int().positive(),
      tracker_id: z.number().int().positive(),
      status_id: z.number().int().positive(),
      priority_id: z.number().int().positive(),
      custom_fields: z
        .array(
          z
            .object({
              id: z.number().int().positive(),
              value: z.string().max(10000),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("export"),
      preview_id: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("operation"),
      operation_id: z.string().min(1).max(200),
    })
    .strict(),
]);
export const redmineResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("projects"), data: projectsSchema }),
  z.object({ kind: z.literal("options"), data: optionsSchema }),
  z.object({ kind: z.literal("preview"), data: previewSchema }),
  z.object({ kind: z.literal("export"), data: exportSchema }),
  z.object({ kind: z.literal("operation"), data: exportSchema }),
]);

export function viewRequest(row: queue.RedmineRequest) {
  return {
    ...queue.publicRequest(row),
    result: row.result
      ? redmineResultSchema.parse({ kind: row.kind, data: row.result })
      : null,
  };
}

export async function createRedmineRequest(
  db: dbClient,
  input: z.infer<typeof redmineRequestSchema>,
  actor: string,
) {
  const { cardPublicId, request_key, kind, ...selection } = input;
  let method = "GET",
    path = "",
    body: Record<string, unknown> | null = null;
  let expectedRevision: number | undefined;
  const actorQuery = `actor_member_id=${encodeURIComponent(actor)}`;
  if (input.kind === "projects")
    path = `/redmine/projects?${actorQuery}${input.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : ""}`;
  if (input.kind === "options")
    path = `/redmine/projects/${input.project_id}/options?${actorQuery}`;
  if (input.kind === "preview") {
    method = "POST";
    path = "/redmine/exports/preview";
    body = { ...selection, card_id: cardPublicId, actor_member_id: actor };
    expectedRevision = input.expected_revision;
  }
  if (input.kind === "export") {
    const previous = await queue.exportRequest(db, cardPublicId, actor);
    if (previous) return viewRequest(previous);
    const row = await queue.findPreview(
      db,
      cardPublicId,
      actor,
      input.preview_id,
    );
    const preview = previewSchema.parse(row.result);
    if (
      preview.errors.length ||
      !Number.isFinite(Date.parse(preview.expires_at)) ||
      Date.parse(preview.expires_at) <= Date.now()
    )
      throw new TaskControlError("Preview expired or contains errors", 409);
    expectedRevision = row.expectedRevision;
    method = "POST";
    path = "/redmine/exports";
    body = { actor_member_id: actor, preview_id: input.preview_id };
  }
  if (input.kind === "operation") {
    const previous = await queue.exportRequest(db, cardPublicId, actor);
    if (
      !previous?.result ||
      exportSchema.parse(previous.result).operation_id !== input.operation_id
    )
      throw new TaskControlError(
        "Operation does not belong to this card/actor",
        403,
      );
    path = `/redmine/exports/${encodeURIComponent(input.operation_id)}?${actorQuery}`;
  }
  return viewRequest(
    await queue.enqueue(db, {
      kind,
      cardId: cardPublicId,
      actorId: actor,
      nonce: request_key,
      expectedRevision,
      payload: {
        method,
        path,
        body,
        idempotency_key:
          kind === "export"
            ? `kan:${process.env.TASK_CONTROL_INSTANCE_ID ?? "kan"}:${cardPublicId}`
            : null,
      },
    }),
  );
}

export const replySchema = z
  .object({
    lease_token: z.string().uuid(),
    state: z.enum(["completed", "failed", "unknown"]),
    result: z.record(z.unknown()).nullable(),
    error: z.string().min(1).max(2000).nullable(),
  })
  .strict();

export function validateReply(
  row: queue.RedmineRequest,
  input: z.infer<typeof replySchema>,
) {
  if (input.state !== "completed") {
    if (
      input.result !== null ||
      input.error === null ||
      (input.state === "unknown" && row.kind !== "export")
    )
      throw new TaskControlError("Invalid failure response", 422);
    return null;
  }
  if (input.error !== null || input.result === null)
    throw new TaskControlError("Invalid completed response", 422);
  const checked = redmineResultSchema.safeParse({
    kind: row.kind,
    data: input.result,
  });
  if (!checked.success)
    throw new TaskControlError(
      "Worker result does not match the request kind",
      422,
    );
  const parsed = checked.data;
  if (parsed.kind === "preview") {
    if (
      parsed.data.snapshot.card_id !== row.cardPublicId ||
      parsed.data.snapshot.revision !== row.expectedRevision ||
      !Number.isFinite(Date.parse(parsed.data.expires_at)) ||
      Date.parse(parsed.data.expires_at) > Date.now() + 11 * 60_000
    )
      throw new TaskControlError(
        "Preview snapshot mismatch or invalid expiry",
        409,
      );
  }
  if (parsed.kind === "operation") {
    const path = String(row.payload.path).split("?")[0] ?? "";
    if (
      decodeURIComponent(path.substring(path.lastIndexOf("/") + 1)) !==
      parsed.data.operation_id
    )
      throw new TaskControlError("Operation response mismatch", 409);
  }
  return parsed.data;
}

export async function assertCurrentRequest(
  db: dbClient,
  row: queue.RedmineRequest,
) {
  const card = await getSnapshot(db, row.cardPublicId);
  if (
    (row.kind === "preview" || row.kind === "export") &&
    card.revision !== row.expectedRevision
  )
    throw new TaskControlError(
      "Card changed after request; new preview required",
      409,
    );
}
