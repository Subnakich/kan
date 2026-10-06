import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";

import type { dbClient } from "@kan/db/client";
import {
  boards,
  cardActivities,
  cardAttachments,
  cards,
  cardsToLabels,
  cardToWorkspaceMembers,
  checklistItems,
  checklists,
  comments,
  labels,
  lists,
  taskChanges,
  taskImportKeys,
  workspaceMembers,
} from "@kan/db/schema";
import { generateUID } from "@kan/shared/utils";

export const TASK_ROLES = [
  "review",
  "queue",
  "in_progress",
  "blocked",
  "done",
] as const;
const ROLE_NAMES = ["Review", "Queue", "In Progress", "Blocked", "Done"];

export class TaskControlError extends Error {
  constructor(
    message: string,
    public status = 422,
  ) {
    super(message);
  }
}

export async function getBoard(db: dbClient, publicId: string, enabled = true) {
  const board = await db.query.boards.findFirst({
    where: and(eq(boards.publicId, publicId), isNull(boards.deletedAt)),
    with: {
      lists: { where: isNull(lists.deletedAt), orderBy: asc(lists.index) },
      workspace: true,
    },
  });
  if (!board || (enabled && !board.taskControlEnabled))
    throw new TaskControlError("Task board not found", 404);
  return board;
}

export async function enable(
  db: dbClient,
  boardPublicId: string,
  userId: string,
) {
  return db.transaction(async (tx) => {
    const store = tx as unknown as dbClient;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(712340)`);
    await tx.execute(
      sql`SELECT id FROM board WHERE "publicId" = ${boardPublicId} FOR UPDATE`,
    );
    const board = await getBoard(store, boardPublicId, false);
    if (board.taskControlEnabled) return { enabled: true };
    const [existing] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(cards)
      .where(
        and(
          isNull(cards.deletedAt),
          sql`${cards.listId} IN (SELECT id FROM list WHERE "boardId" = ${board.id})`,
        ),
      );
    if (Number(existing?.count ?? 0) > 0)
      throw new TaskControlError(
        "Enable task control on an empty board. Existing cards and deadlines must be reviewed before migration.",
      );
    // Existing lists and cards are preserved. New task-control roles are explicit.
    for (const [i, role] of TASK_ROLES.entries()) {
      const name = ROLE_NAMES[i];
      if (!name)
        throw new TaskControlError("Task role configuration is incomplete");
      const matches = board.lists.filter(
        (list) => list.name.toLowerCase() === name.toLowerCase(),
      );
      if (matches.length > 1)
        throw new TaskControlError(
          `Several lists named ${name}; rename duplicates first`,
        );
      const match = matches[0];
      if (match) {
        await tx
          .update(lists)
          .set({ taskRole: role })
          .where(eq(lists.id, match.id));
      } else {
        await tx.insert(lists).values({
          publicId: generateUID(),
          name,
          taskRole: role,
          index: board.lists.length + i,
          boardId: board.id,
          createdBy: userId,
        });
      }
    }
    const review = await tx.query.lists.findFirst({
      where: and(
        eq(lists.boardId, board.id),
        eq(lists.taskRole, "review"),
        isNull(lists.deletedAt),
      ),
    });
    if (!review) throw new TaskControlError("Review list is missing");
    await tx
      .update(boards)
      .set({ taskControlEnabled: true })
      .where(eq(boards.id, board.id));
    // Backfill snapshots so a bot connecting before the full scan still sees existing cards.
    await tx.execute(
      sql`UPDATE card SET revision = revision + 1 WHERE "listId" = ${review.id} AND "deletedAt" IS NULL`,
    );
    return { enabled: true };
  });
}

const snapshotQuery = {
  members: { with: { member: { with: { user: true } } } },
  list: { with: { board: { with: { workspace: true } } } },
  labels: { with: { label: true } },
  checklists: {
    where: isNull(checklists.deletedAt),
    orderBy: asc(checklists.index),
    with: {
      items: {
        where: isNull(checklistItems.deletedAt),
        orderBy: asc(checklistItems.index),
      },
    },
  },
  comments: { where: isNull(comments.deletedAt), with: { createdBy: true } },
  attachments: { where: isNull(cardAttachments.deletedAt) },
} as const;

function formatSnapshot(
  card: NonNullable<Awaited<ReturnType<typeof snapshot>>>,
) {
  return {
    card_id: card.publicId,
    board_id: card.list.board.publicId,
    workspace_id: card.list.board.workspace.publicId,
    url: `${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/cards/${card.publicId}`,
    title: card.title,
    description: card.description,
    owner_member_public_id: card.ownerMemberPublicId,
    due_at: card.dueDate?.toISOString() ?? null,
    deadline_revision: card.deadlineRevision,
    column_id: card.list.publicId,
    column_role: card.list.taskRole,
    column_entered_at: card.columnEnteredAt.toISOString(),
    column_visit_id: card.columnVisitId,
    revision: card.revision,
    blocker_reason: card.blockerReason,
    source: card.taskSource,
    acceptance_criteria: card.taskSource?.acceptance_criteria ?? [],
    labels: card.labels
      .filter((link) => !link.label.deletedAt)
      .map((link) => ({
        public_id: link.label.publicId,
        name: link.label.name,
      })),
    checklist: card.checklists.map((checklist) => ({
      public_id: checklist.publicId,
      name: checklist.name,
      items: checklist.items.map((item) => ({
        public_id: item.publicId,
        title: item.title,
        completed: item.completed,
      })),
    })),
    comments: card.comments.map((comment) => ({
      public_id: comment.publicId,
      text: comment.comment,
      author: comment.createdBy?.name ?? null,
      created_at: comment.createdAt.toISOString(),
    })),
    attachments: card.attachments.map((attachment) => ({
      public_id: attachment.publicId,
      name: attachment.originalFilename,
      content_type: attachment.contentType,
      size: attachment.size,
      download_path: `/api/integrations/v1/cards/${card.publicId}/attachments/${attachment.publicId}`,
    })),
    redmine_link: card.redmineLink,
  };
}

async function snapshot(db: dbClient, publicId: string) {
  return db.query.cards.findFirst({
    where: and(eq(cards.publicId, publicId), isNull(cards.deletedAt)),
    with: snapshotQuery,
  });
}

export async function getSnapshot(db: dbClient, publicId: string) {
  const card = await snapshot(db, publicId);
  if (
    !card ||
    !card.list.board.taskControlEnabled ||
    card.list.deletedAt ||
    card.list.board.deletedAt
  )
    throw new TaskControlError("Card not found", 404);
  if (card.list.board.isArchived)
    throw new TaskControlError("Board is archived", 410);
  return formatSnapshot(card);
}

export async function cardAccess(db: dbClient, publicId: string) {
  const card = await snapshot(db, publicId);
  if (!card || card.list.deletedAt || card.list.board.deletedAt)
    throw new TaskControlError("Card not found", 404);
  return card;
}

export async function updateFields(
  db: dbClient,
  publicId: string,
  input: {
    owner_member_public_id?: string | null;
    blocker_reason?: string | null;
    acceptance_criteria?: string[];
  },
  userId: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(712340)`);
    const card = await cardAccess(tx as unknown as dbClient, publicId);
    if (!card.list.board.taskControlEnabled)
      throw new TaskControlError("Enable task control first");
    if (
      input.owner_member_public_id &&
      !card.members.some(
        (link) =>
          link.member.publicId === input.owner_member_public_id &&
          link.member.status === "active" &&
          !link.member.deletedAt &&
          link.member.workspaceId === card.list.board.workspaceId,
      )
    )
      throw new TaskControlError(
        "Responsible person must be a card participant",
      );
    await tx
      .update(cards)
      .set({
        ...(input.owner_member_public_id !== undefined && {
          ownerMemberPublicId: input.owner_member_public_id,
        }),
        ...(input.blocker_reason !== undefined && {
          blockerReason: input.blocker_reason,
        }),
        ...(input.acceptance_criteria !== undefined &&
          card.taskSource && {
            taskSource: {
              ...card.taskSource,
              acceptance_criteria: input.acceptance_criteria,
            },
          }),
      })
      .where(eq(cards.id, card.id));
    await tx.insert(cardActivities).values({
      publicId: generateUID(),
      cardId: card.id,
      createdBy: userId,
      type:
        input.owner_member_public_id !== undefined
          ? "card.updated.owner"
          : input.acceptance_criteria !== undefined
            ? "card.updated.description"
            : "card.updated.blocker",
      fromDescription:
        input.owner_member_public_id !== undefined
          ? card.ownerMemberPublicId
          : card.blockerReason,
      toDescription:
        input.owner_member_public_id !== undefined
          ? input.owner_member_public_id
          : input.blocker_reason,
    });
    return { success: true };
  });
}

export async function getMembers(db: dbClient, boardId: string) {
  const board = await getBoard(db, boardId);
  const members = await db.query.workspaceMembers.findMany({
    where: and(
      eq(workspaceMembers.workspaceId, board.workspaceId),
      eq(workspaceMembers.status, "active"),
      isNull(workspaceMembers.deletedAt),
    ),
    with: { user: true },
  });
  return members.map((member) => ({
    member_public_id: member.publicId,
    name: member.user?.name ?? member.email,
  }));
}

export async function getCardMembers(db: dbClient, cardPublicId: string) {
  const card = await cardAccess(db, cardPublicId);
  return card.members
    .map((link) => link.member)
    .filter(
      (member) =>
        member.status === "active" &&
        !member.deletedAt &&
        member.workspaceId === card.list.board.workspaceId,
    )
    .map((member) => ({
      member_public_id: member.publicId,
      name: member.user?.name ?? member.email,
      email: member.email,
    }));
}

export async function actorMember(
  db: dbClient,
  workspaceId: number,
  userId: string,
) {
  const member = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
      eq(workspaceMembers.status, "active"),
      isNull(workspaceMembers.deletedAt),
    ),
  });
  if (!member)
    throw new TaskControlError("Active workspace membership required", 403);
  return member.publicId;
}

export async function allBoards(db: dbClient) {
  const result = await db.query.boards.findMany({
    where: and(
      eq(boards.taskControlEnabled, true),
      eq(boards.isArchived, false),
      isNull(boards.deletedAt),
    ),
    with: {
      workspace: true,
      lists: { where: isNull(lists.deletedAt), orderBy: asc(lists.index) },
    },
  });
  return result.map((board) => ({
    board_id: board.publicId,
    name: board.name,
    workspace_id: board.workspace.publicId,
    columns: board.lists.map((list) => ({
      column_id: list.publicId,
      name: list.name,
      role: list.taskRole,
    })),
  }));
}

export function encodeCursor(position: number) {
  return Buffer.from(`task-v1:${position}`).toString("base64url");
}
export function decodeCursor(cursor?: string) {
  if (!cursor) return 0;
  const text = Buffer.from(cursor, "base64url").toString();
  if (!/^task-v1:\d+$/.test(text))
    throw new TaskControlError("Invalid cursor", 422);
  const value = Number(text.slice(8));
  if (!Number.isSafeInteger(value))
    throw new TaskControlError("Invalid cursor", 422);
  return value;
}

export async function changes(db: dbClient, cursor?: string) {
  const result = await db
    .select({ change: taskChanges })
    .from(taskChanges)
    .innerJoin(boards, eq(boards.publicId, taskChanges.boardPublicId))
    .where(
      and(
        gt(taskChanges.id, decodeCursor(cursor)),
        eq(boards.taskControlEnabled, true),
      ),
    )
    .orderBy(asc(taskChanges.id))
    .limit(101);
  const rows = result.slice(0, 100).map((row) => row.change);
  return {
    items: rows.map((row) => ({
      event_id: row.publicId,
      card_id: row.cardPublicId,
      revision: row.revision,
      occurred_at: row.occurredAt.toISOString(),
      kind: row.kind,
    })),
    next_cursor:
      rows.at(-1)?.id !== undefined
        ? encodeCursor(rows.at(-1)?.id ?? 0)
        : (cursor ?? encodeCursor(0)),
    has_more: result.length > 100,
  };
}

export async function boardCards(
  db: dbClient,
  boardPublicId: string,
  cursor?: string,
) {
  const board = await getBoard(db, boardPublicId);
  if (board.isArchived) throw new TaskControlError("Board is archived", 410);
  const result = await db.query.cards.findMany({
    where: and(
      isNull(cards.deletedAt),
      gt(cards.id, decodeCursor(cursor)),
      sql`${cards.listId} IN (SELECT id FROM list WHERE "boardId" = ${board.id} AND "deletedAt" IS NULL)`,
    ),
    orderBy: asc(cards.id),
    limit: 101,
    with: snapshotQuery,
  });
  const rows = result.slice(0, 100);
  return {
    items: rows.map(formatSnapshot),
    next_cursor:
      rows.at(-1)?.id !== undefined
        ? encodeCursor(rows.at(-1)?.id ?? 0)
        : (cursor ?? encodeCursor(0)),
    has_more: result.length > 100,
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return value === undefined ? "null" : JSON.stringify(value);
}
export function payloadHash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface MeetingTaskInput {
  external_key: string;
  payload_hash: string;
  board_id: string;
  meeting: {
    id: string;
    title: string;
    started_at: string | null;
    timezone: string;
    source_ref: string | null;
  };
  task: {
    id: string;
    title: string;
    description: string;
    acceptance_criteria: string[];
    assignee: { member_public_id: string; name: string } | null;
    due_at: string | null;
    due_text: string | null;
    labels: string[];
    checklist: string[];
    source: { quote: string; timestamp: string | null };
    review_notes: string[];
  };
}

export async function importResult(db: dbClient, externalKey: string) {
  const result = await db.query.taskImportKeys.findFirst({
    where: eq(taskImportKeys.externalKey, externalKey),
  });
  if (!result) throw new TaskControlError("Import key not found", 404);
  return {
    card_id: result.cardPublicId,
    board_id: result.boardPublicId,
    status: result.deletedAt ? "deleted" : "created",
    payload_hash: result.payloadHash,
  };
}

function html(text: string) {
  return `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`;
}

export async function importCard(db: dbClient, input: MeetingTaskInput) {
  const hash = payloadHash({
    board_id: input.board_id,
    meeting: input.meeting,
    task: input.task,
  });
  if (hash !== input.payload_hash)
    throw new TaskControlError("payload_hash does not match canonical payload");
  return db.transaction(async (tx) => {
    // Serialize key claims and card indices. Retry after a lost response reads the same claim.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(712340)`);
    const store = tx as unknown as dbClient;
    const prior = await tx.query.taskImportKeys.findFirst({
      where: eq(taskImportKeys.externalKey, input.external_key),
    });
    if (prior) {
      if (prior.deletedAt)
        throw new TaskControlError(
          "Card was deleted; import will not restore it",
          410,
        );
      if (prior.payloadHash !== hash || prior.boardPublicId !== input.board_id)
        throw new TaskControlError(
          "Import key conflicts with an earlier task",
          409,
        );
      return {
        ...(await importResult(store, input.external_key)),
        created: false,
      };
    }
    const board = await getBoard(store, input.board_id);
    if (board.isArchived || !board.createdBy)
      throw new TaskControlError("Board cannot accept imports");
    const review = board.lists.find((list) => list.taskRole === "review");
    if (!review) throw new TaskControlError("Review list is missing");
    const notes = [...input.task.review_notes];
    let owner = input.task.assignee?.member_public_id ?? null;
    if (owner) {
      const member = await tx.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.publicId, owner),
          eq(workspaceMembers.workspaceId, board.workspaceId),
          eq(workspaceMembers.status, "active"),
          isNull(workspaceMembers.deletedAt),
        ),
      });
      if (!member) {
        notes.push("Responsible person must be clarified on review");
        owner = null;
      }
    }
    const counter = (
      await tx.execute<{ cardCounter: number }>(
        sql`UPDATE workspace SET "cardCounter" = "cardCounter" + 1 WHERE id = ${board.workspaceId} RETURNING "cardCounter"`,
      )
    ).rows[0];
    const [last] = await tx
      .select({ index: sql<number>`coalesce(max(index), -1) + 1` })
      .from(cards)
      .where(and(eq(cards.listId, review.id), isNull(cards.deletedAt)));
    const [card] = await tx
      .insert(cards)
      .values({
        publicId: generateUID(),
        title: input.task.title,
        description: html(input.task.description),
        index: Number(last?.index ?? 0),
        listId: review.id,
        createdBy: board.createdBy,
        cardNumber: counter?.cardCounter ?? 0,
        dueDate: input.task.due_at ? new Date(input.task.due_at) : null,
        ownerMemberPublicId: owner,
        taskSource: {
          meeting: input.meeting,
          ...input.task.source,
          due_text: input.task.due_text,
          acceptance_criteria: input.task.acceptance_criteria,
          review_notes: notes,
        },
      })
      .returning();
    if (!card) throw new TaskControlError("Unable to create card", 503);
    if (owner) {
      await tx.insert(cardToWorkspaceMembers).values({
        cardId: card.id,
        workspaceMemberId: sql`(SELECT id FROM workspace_members WHERE "publicId"=${owner})`,
      });
    }
    for (const name of new Set(
      input.task.labels.map((name) => name.trim()).filter(Boolean),
    )) {
      let label = await tx.query.labels.findFirst({
        where: and(
          eq(labels.boardId, board.id),
          eq(labels.name, name),
          isNull(labels.deletedAt),
        ),
      });
      if (!label)
        [label] = await tx
          .insert(labels)
          .values({
            publicId: generateUID(),
            name,
            boardId: board.id,
            createdBy: board.createdBy,
          })
          .returning();
      if (label)
        await tx
          .insert(cardsToLabels)
          .values({ cardId: card.id, labelId: label.id });
    }
    await tx.insert(cardActivities).values({
      publicId: generateUID(),
      cardId: card.id,
      createdBy: board.createdBy,
      type: "card.created",
    });
    if (input.task.checklist.length) {
      const [checklist] = await tx
        .insert(checklists)
        .values({
          publicId: generateUID(),
          cardId: card.id,
          name: "Meeting checklist",
          index: 0,
          createdBy: board.createdBy,
        })
        .returning();
      if (checklist)
        await tx.insert(checklistItems).values(
          input.task.checklist.map((title, index) => ({
            publicId: generateUID(),
            checklistId: checklist.id,
            title,
            index,
            createdBy: board.createdBy,
          })),
        );
    }
    await tx.insert(taskImportKeys).values({
      externalKey: input.external_key,
      payloadHash: hash,
      boardPublicId: board.publicId,
      cardPublicId: card.publicId,
    });
    return {
      card_id: card.publicId,
      board_id: board.publicId,
      status: "created",
      payload_hash: hash,
      created: true,
    };
  });
}

export async function setRedmineLink(
  db: dbClient,
  publicId: string,
  link: NonNullable<typeof cards.$inferSelect.redmineLink>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(712340)`);
    await tx.execute(
      sql`SELECT id FROM card WHERE "publicId" = ${publicId} FOR UPDATE`,
    );
    const card = await cardAccess(tx as unknown as dbClient, publicId);
    if (!card.list.board.taskControlEnabled)
      throw new TaskControlError("Task board not found", 404);
    if (link.exported_revision > card.revision)
      throw new TaskControlError("Export revision is ahead of the card", 409);
    if (
      card.redmineLink &&
      (card.redmineLink.issue_id !== link.issue_id ||
        card.redmineLink.instance_id !== link.instance_id)
    )
      throw new TaskControlError(
        "Card already linked to another Redmine issue",
        409,
      );
    if (!card.redmineLink)
      await tx
        .update(cards)
        .set({ redmineLink: link })
        .where(eq(cards.id, card.id));
    return { success: true };
  });
}
