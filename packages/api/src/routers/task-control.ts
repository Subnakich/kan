import { timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as redmineQueue from "@kan/db/repository/redmine-request.repo";
import * as repo from "@kan/db/repository/task-control.repo";
import { generateDownloadUrl } from "@kan/shared/utils";

import {
  createTRPCRouter,
  protectedProcedure,
  serviceProcedure,
} from "../trpc";
import { assertPermission } from "../utils/permissions";
import {
  assertCurrentRequest,
  createRedmineRequest,
  redmineRequestSchema,
  replySchema,
  validateReply,
  viewRequest,
} from "../utils/redmine-queue";
import { exportSchema } from "../utils/task-gateway";

const publicId = z.string().length(12);
// These procedures are session RPCs or use the dedicated bearer-token adapter.
// Do not expose them through the native user-key /api/v1 OpenAPI adapter.
const routeMeta = (
  method: "GET" | "POST" | "PUT",
  path: `/${string}`,
  summary: string,
) => ({
  openapi: {
    method,
    path,
    summary,
    enabled: false,
    protect: true,
    tags: ["Task control"],
  },
});
const dateTime = z.string().datetime({ offset: true });
const cardInput = z.object({ cardPublicId: publicId });
function sessionUserId(user: { id: string } | null | undefined) {
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return user.id;
}
async function exportActor(
  ctx: { db: dbClient; user?: { id: string } | null },
  cardId: string,
) {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  const card = await repo.cardAccess(ctx.db, cardId);
  if (!card.list.board.taskControlEnabled || card.list.board.isArchived)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Active task-control board required",
    });
  await assertPermission(
    ctx.db,
    ctx.user.id,
    card.list.board.workspaceId,
    "card:edit",
  );
  return repo.actorMember(ctx.db, card.list.board.workspaceId, ctx.user.id);
}
export const taskImportSchema = z
  .object({
    external_key: z.string().min(1).max(512),
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
    board_id: publicId,
    meeting: z
      .object({
        id: z.string().min(1).max(200),
        title: z.string().max(500),
        started_at: dateTime.nullable(),
        timezone: z.literal("Europe/Moscow"),
        source_ref: z.string().max(2000).nullable(),
      })
      .strict(),
    task: z
      .object({
        id: z.string().min(1).max(200),
        title: z.string().min(1).max(500),
        description: z.string().max(50000),
        acceptance_criteria: z.array(z.string().max(2000)).max(100),
        assignee: z
          .object({ member_public_id: publicId, name: z.string().max(255) })
          .strict()
          .nullable(),
        due_at: dateTime.nullable(),
        due_text: z.string().max(1000).nullable(),
        labels: z.array(z.string().max(255)).max(50),
        checklist: z.array(z.string().max(500)).max(100),
        source: z
          .object({
            quote: z.string().max(10000),
            timestamp: z.string().max(100).nullable(),
          })
          .strict(),
        review_notes: z.array(z.string().max(2000)).max(100),
      })
      .strict(),
  })
  .strict();

// Service input is not logged: meeting transcripts may contain confidential information.
const integrationProcedure = serviceProcedure.use(async ({ ctx, next }) => {
  const expected = process.env.TASK_CONTROL_SERVICE_TOKEN;
  const supplied = ctx.headers.get("authorization")?.replace(/^Bearer /, "");
  if (
    !expected ||
    !supplied ||
    Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  )
    throw new TRPCError({ code: "UNAUTHORIZED" });
  return next();
});

export const taskIntegrationRouter = createTRPCRouter({
  capabilities: integrationProcedure
    .meta(
      routeMeta(
        "GET",
        "/integrations/v1/capabilities",
        "Integration capabilities",
      ),
    )
    .query(() => ({
      instance_id: process.env.TASK_CONTROL_INSTANCE_ID ?? "kan",
      api_version: "1.0",
      timezone: "Europe/Moscow",
      features: [
        "task_import",
        "primary_owner",
        "minute_deadlines",
        "durable_changes",
        "redmine_link",
        "redmine_polling_queue_v1",
      ],
      page_size: 100,
    })),
  boards: integrationProcedure
    .meta(
      routeMeta("GET", "/integrations/v1/boards", "Active task-control boards"),
    )
    .query(({ ctx }) => repo.allBoards(ctx.db)),
  members: integrationProcedure
    .meta(
      routeMeta(
        "GET",
        "/integrations/v1/boards/{board_id}/members",
        "Active members",
      ),
    )
    .input(z.object({ board_id: publicId }))
    .query(({ ctx, input }) => repo.getMembers(ctx.db, input.board_id)),
  cards: integrationProcedure
    .meta(
      routeMeta(
        "GET",
        "/integrations/v1/boards/{board_id}/cards",
        "Card snapshots",
      ),
    )
    .input(
      z.object({ board_id: publicId, cursor: z.string().max(200).optional() }),
    )
    .query(({ ctx, input }) =>
      repo.boardCards(ctx.db, input.board_id, input.cursor),
    ),
  changes: integrationProcedure
    .meta(routeMeta("GET", "/integrations/v1/changes", "Durable changes"))
    .input(z.object({ cursor: z.string().max(200).optional() }))
    .query(({ ctx, input }) => repo.changes(ctx.db, input.cursor)),
  card: integrationProcedure
    .meta(
      routeMeta(
        "GET",
        "/integrations/v1/cards/{card_id}",
        "Current card snapshot",
      ),
    )
    .input(z.object({ card_id: publicId }))
    .query(({ ctx, input }) => repo.getSnapshot(ctx.db, input.card_id)),
  attachment: integrationProcedure
    .meta(
      routeMeta(
        "GET",
        "/integrations/v1/cards/{card_id}/attachments/{attachment_id}",
        "Authorized attachment download",
      ),
    )
    .input(z.object({ card_id: publicId, attachment_id: publicId }))
    .query(async ({ ctx, input }) => {
      await repo.getSnapshot(ctx.db, input.card_id);
      const card = await repo.cardAccess(ctx.db, input.card_id);
      const attachment = card.attachments.find(
        (item) => item.publicId === input.attachment_id && !item.deletedAt,
      );
      if (!attachment) throw new TRPCError({ code: "NOT_FOUND" });
      const bucket = process.env.NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME;
      if (!bucket)
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Attachment storage is not configured",
        });
      return { url: await generateDownloadUrl(bucket, attachment.s3Key, 60) };
    }),
  import: integrationProcedure
    .meta(
      routeMeta(
        "POST",
        "/integrations/v1/imports/cards",
        "Idempotent task import",
      ),
    )
    .input(taskImportSchema)
    .mutation(({ ctx, input }) => repo.importCard(ctx.db, input)),
  importResult: integrationProcedure
    .meta(
      routeMeta(
        "GET",
        "/integrations/v1/imports/cards",
        "Import result or tombstone",
      ),
    )
    .input(z.object({ external_key: z.string().max(512) }))
    .query(({ ctx, input }) => repo.importResult(ctx.db, input.external_key)),
  redmineLink: integrationProcedure
    .meta(
      routeMeta(
        "PUT",
        "/integrations/v1/cards/{card_id}/redmine-link",
        "Link exported issue",
      ),
    )
    .input(
      z.object({
        card_id: publicId,
        link: z
          .object({
            instance_id: z.string().min(1).max(200),
            issue_id: z.number().int().positive(),
            display_id: z.string().max(100),
            url: z
              .string()
              .url()
              .refine((url) => /^https?:\/\//.test(url)),
            exported_at: dateTime,
            exported_revision: z.number().int().positive(),
          })
          .strict(),
      }),
    )
    .mutation(({ ctx, input }) =>
      repo.setRedmineLink(ctx.db, input.card_id, input.link),
    ),
  redmineClaim: integrationProcedure
    .meta(
      routeMeta(
        "POST",
        "/integrations/v1/redmine/requests/claim",
        "Lease actor-scoped Redmine requests",
      ),
    )
    .input(
      z
        .object({
          board_ids: z.array(publicId).min(1).max(100),
          limit: z.number().int().min(1).max(10).default(1),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await redmineQueue.claim(
        ctx.db,
        input.board_ids,
        input.limit,
      );
      const items = [];
      for (const row of rows) {
        try {
          await assertCurrentRequest(ctx.db, row);
          const actor = await redmineQueue.requestActor(ctx.db, row);
          await assertPermission(
            ctx.db,
            actor.userId,
            actor.workspaceId,
            "card:edit",
          );
        } catch (error) {
          if (
            !(error instanceof repo.TaskControlError) &&
            !(error instanceof TRPCError && error.code === "FORBIDDEN")
          )
            throw error;
          await redmineQueue.settle(
            ctx.db,
            row.publicId,
            row.leaseToken!,
            "failed",
            null,
            "Card or actor permissions changed; request rejected",
          );
          continue;
        }
        items.push({
          request_id: row.publicId,
          kind: row.kind,
          actor_member_id: row.actorMemberPublicId,
          card_id: row.cardPublicId,
          board_id: row.boardPublicId,
          workspace_id: row.workspacePublicId,
          expected_revision: row.expectedRevision,
          request: row.payload,
          lease_token: row.leaseToken!,
          lease_expires_at: row.leaseExpiresAt!.toISOString(),
          attempts: row.attempts,
        });
      }
      return { items, lease_seconds: 120 };
    }),
  redmineRenew: integrationProcedure
    .meta(
      routeMeta(
        "POST",
        "/integrations/v1/redmine/requests/{request_id}/lease",
        "Renew a current worker lease",
      ),
    )
    .input(
      z
        .object({ request_id: publicId, lease_token: z.string().uuid() })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await redmineQueue.renew(
        ctx.db,
        input.request_id,
        input.lease_token,
      );
      return {
        request_id: row.publicId,
        lease_expires_at: row.leaseExpiresAt!.toISOString(),
      };
    }),
  redmineResult: integrationProcedure
    .meta(
      routeMeta(
        "POST",
        "/integrations/v1/redmine/requests/{request_id}/result",
        "Idempotent request acknowledgement",
      ),
    )
    .input(replySchema.extend({ request_id: publicId }))
    .mutation(async ({ ctx, input }) => {
      const row = await redmineQueue.getRequest(ctx.db, input.request_id);
      const result = validateReply(row, input);
      if (result && (row.kind === "export" || row.kind === "operation")) {
        const exported = exportSchema.parse(result);
        if (exported.status === "linked") {
          const card = await repo.getSnapshot(ctx.db, row.cardPublicId);
          const link = exported.redmine_link;
          if (
            !card.redmine_link ||
            !link ||
            card.redmine_link.display_id !== link.display_id ||
            card.redmine_link.url !== link.url
          )
            throw new repo.TaskControlError(
              "Write the matching card Redmine link before acknowledging linked",
              409,
            );
        }
      }
      return viewRequest(
        await redmineQueue.settle(
          ctx.db,
          input.request_id,
          input.lease_token,
          input.state,
          result,
          input.error,
        ),
      );
    }),
  redmineRequest: integrationProcedure
    .meta(
      routeMeta(
        "GET",
        "/integrations/v1/redmine/requests/{request_id}",
        "Request recovery status",
      ),
    )
    .input(z.object({ request_id: publicId }).strict())
    .query(async ({ ctx, input }) =>
      viewRequest(await redmineQueue.getRequest(ctx.db, input.request_id)),
    ),
});

export const taskControlRouter = createTRPCRouter({
  redmineRequest: protectedProcedure
    .meta(
      routeMeta(
        "POST",
        "/task-control/redmine/requests",
        "Queue a request for the bot",
      ),
    )
    .input(redmineRequestSchema)
    .mutation(async ({ ctx, input }) =>
      createRedmineRequest(
        ctx.db,
        input,
        await exportActor(ctx, input.cardPublicId),
      ),
    ),
  redmineRequestStatus: protectedProcedure
    .meta(
      routeMeta(
        "GET",
        "/task-control/redmine/requests/{request_id}",
        "Actor-scoped queued result",
      ),
    )
    .input(cardInput.extend({ request_id: publicId }))
    .query(async ({ ctx, input }) => {
      const actor = await exportActor(ctx, input.cardPublicId);
      const row = await redmineQueue.getRequest(ctx.db, input.request_id);
      if (
        row.cardPublicId !== input.cardPublicId ||
        row.actorMemberPublicId !== actor
      )
        throw new TRPCError({ code: "FORBIDDEN" });
      return viewRequest(row);
    }),
  redmineExportState: protectedProcedure
    .meta(
      routeMeta(
        "GET",
        "/task-control/redmine/export-state",
        "Restore export state after reload",
      ),
    )
    .input(cardInput)
    .query(async ({ ctx, input }) => {
      const actor = await exportActor(ctx, input.cardPublicId);
      const row = await redmineQueue.exportRequest(
        ctx.db,
        input.cardPublicId,
        actor,
      );
      return row ? viewRequest(row) : null;
    }),
  board: protectedProcedure
    .meta(
      routeMeta(
        "GET",
        "/task-control/boards/{boardPublicId}",
        "Task-control configuration",
      ),
    )
    .input(z.object({ boardPublicId: publicId }))
    .query(async ({ ctx, input }) => {
      const board = await repo.getBoard(ctx.db, input.boardPublicId, false);
      await assertPermission(
        ctx.db,
        sessionUserId(ctx.user),
        board.workspaceId,
        "board:view",
      );
      return {
        enabled: board.taskControlEnabled,
        columns: board.lists.map((list) => ({
          publicId: list.publicId,
          name: list.name,
          role: list.taskRole,
        })),
      };
    }),
  enable: protectedProcedure
    .meta(
      routeMeta(
        "POST",
        "/task-control/boards/{boardPublicId}/enable",
        "Enable task control on an empty board",
      ),
    )
    .input(z.object({ boardPublicId: publicId }))
    .mutation(async ({ ctx, input }) => {
      const board = await repo.getBoard(ctx.db, input.boardPublicId, false);
      await assertPermission(
        ctx.db,
        sessionUserId(ctx.user),
        board.workspaceId,
        "board:edit",
      );
      await assertPermission(
        ctx.db,
        sessionUserId(ctx.user),
        board.workspaceId,
        "list:create",
      );
      return repo.enable(ctx.db, input.boardPublicId, sessionUserId(ctx.user));
    }),
  card: protectedProcedure
    .meta(
      routeMeta(
        "GET",
        "/task-control/cards/{cardPublicId}",
        "Task-control properties",
      ),
    )
    .input(z.object({ cardPublicId: publicId }))
    .query(async ({ ctx, input }) => {
      const card = await repo.cardAccess(ctx.db, input.cardPublicId);
      await assertPermission(
        ctx.db,
        sessionUserId(ctx.user),
        card.list.board.workspaceId,
        "card:view",
      );
      if (!card.list.board.taskControlEnabled) return null;
      const board = await repo.getBoard(ctx.db, card.list.board.publicId);
      return {
        snapshot: await repo.getSnapshot(ctx.db, input.cardPublicId),
        members: await repo.getCardMembers(ctx.db, input.cardPublicId),
        columns: board.lists.map((list) => ({
          publicId: list.publicId,
          name: list.name,
          role: list.taskRole,
        })),
      };
    }),
  update: protectedProcedure
    .meta(
      routeMeta(
        "PUT",
        "/task-control/cards/{cardPublicId}",
        "Update task-control fields",
      ),
    )
    .input(
      z.object({
        cardPublicId: publicId,
        owner_member_public_id: publicId.nullable().optional(),
        blocker_reason: z.string().max(5000).nullable().optional(),
        acceptance_criteria: z.array(z.string().max(2000)).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const card = await repo.cardAccess(ctx.db, input.cardPublicId);
      await assertPermission(
        ctx.db,
        sessionUserId(ctx.user),
        card.list.board.workspaceId,
        "card:edit",
      );
      return repo.updateFields(
        ctx.db,
        input.cardPublicId,
        input,
        sessionUserId(ctx.user),
      );
    }),
});
