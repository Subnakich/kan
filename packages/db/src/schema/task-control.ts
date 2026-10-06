import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const taskChanges = pgTable(
  "task_control_change",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    publicId: varchar("publicId", { length: 12 }).notNull().unique(),
    cardPublicId: varchar("cardPublicId", { length: 12 }).notNull(),
    boardPublicId: varchar("boardPublicId", { length: 12 }).notNull(),
    revision: integer("revision").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    occurredAt: timestamp("occurredAt").defaultNow().notNull(),
  },
  (table) => [
    index("task_change_board_cursor_idx").on(table.boardPublicId, table.id),
  ],
).enableRLS();

export const taskImportKeys = pgTable("task_control_import_key", {
  externalKey: text("externalKey").primaryKey(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  boardPublicId: varchar("boardPublicId", { length: 12 }).notNull(),
  cardPublicId: varchar("cardPublicId", { length: 12 }).notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  deletedAt: timestamp("deletedAt"),
}).enableRLS();

// Actor-scoped RPC requests delivered only by bot -> Kan polling.
export const redmineRequests = pgTable(
  "task_control_redmine_request",
  {
    publicId: varchar("publicId", { length: 12 }).primaryKey(),
    requestKey: varchar("requestKey", { length: 64 }).notNull().unique(),
    payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    cardPublicId: varchar("cardPublicId", { length: 12 }).notNull(),
    boardPublicId: varchar("boardPublicId", { length: 12 }).notNull(),
    workspacePublicId: varchar("workspacePublicId", { length: 12 }).notNull(),
    actorMemberPublicId: varchar("actorMemberPublicId", {
      length: 12,
    }).notNull(),
    expectedRevision: integer("expectedRevision").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    state: varchar("state", { length: 20 }).notNull().default("queued"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    leaseToken: varchar("leaseToken", { length: 36 }),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("redmine_request_claim_idx").on(
      table.state,
      table.boardPublicId,
      table.createdAt,
    ),
  ],
).enableRLS();
