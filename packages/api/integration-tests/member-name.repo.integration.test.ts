import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

import * as memberRepo from "@kan/db/repository/member.repo";
import { users, workspaceMembers, workspaces } from "@kan/db/schema";

import { createTestDb, seedTestData } from "./test-db";

it("renames only the global account name and rejects stale or cross-workspace membership writes", async () => {
  const db = await createTestDb();
  try {
    const { user: admin, workspace } = await seedTestData(db);
    const [target] = await db
      .insert(users)
      .values({
        email: "target@example.com",
        name: "target@example.com",
        emailVerified: true,
        image: "avatars/target",
        stripeCustomerId: "unchanged-fixture",
      })
      .returning();
    if (!target) throw new Error("Fixture user missing");
    const member = await memberRepo.create(db, {
      userId: target.id,
      email: target.email,
      workspaceId: workspace.id,
      createdBy: admin.id,
      role: "member",
      status: "active",
    });
    if (!member) throw new Error("Fixture member missing");
    const beforeMembers = await db.select().from(workspaceMembers);
    const args = {
      workspaceId: workspace.id,
      memberPublicId: member.publicId,
      administratorUserId: admin.id,
      name: "Алексей Петров",
    };
    expect(await memberRepo.updateDisplayName(db, args)).toEqual({
      name: args.name,
    });
    const [after] = await db
      .select()
      .from(users)
      .where(eq(users.id, target.id));
    if (!after) throw new Error("Renamed user missing");
    expect({
      ...after,
      name: target.name,
      updatedAt: target.updatedAt,
    }).toEqual(target);
    expect(await db.select().from(workspaceMembers)).toEqual(beforeMembers);

    // Permission checks may have read these rows earlier: the SQL write must
    // reject membership changes itself, not rely solely on route prechecks.
    for (const changes of [
      { role: "member" as const },
      { status: "paused" as const },
      { deletedAt: new Date() },
    ]) {
      await db
        .update(workspaceMembers)
        .set(changes)
        .where(eq(workspaceMembers.userId, admin.id));
      expect(
        await memberRepo.updateDisplayName(db, {
          ...args,
          name: "Not allowed",
        }),
      ).toBeUndefined();
      await db
        .update(workspaceMembers)
        .set({ role: "admin", status: "active", deletedAt: null })
        .where(eq(workspaceMembers.userId, admin.id));
    }
    for (const changes of [
      { status: "invited" as const },
      { status: "paused" as const },
      { deletedAt: new Date() },
      { userId: null },
    ]) {
      await db
        .update(workspaceMembers)
        .set(changes)
        .where(eq(workspaceMembers.id, member.id));
      expect(
        await memberRepo.updateDisplayName(db, {
          ...args,
          name: "Not allowed",
        }),
      ).toBeUndefined();
      await db
        .update(workspaceMembers)
        .set({ status: "active", deletedAt: null, userId: target.id })
        .where(eq(workspaceMembers.id, member.id));
    }
    await db
      .update(workspaces)
      .set({ deletedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
    expect(
      await memberRepo.updateDisplayName(db, { ...args, name: "Not allowed" }),
    ).toBeUndefined();
    await db
      .update(workspaces)
      .set({ deletedAt: null })
      .where(eq(workspaces.id, workspace.id));
    expect(
      await memberRepo.updateDisplayName(db, {
        ...args,
        workspaceId: workspace.id + 100,
        name: "Not allowed",
      }),
    ).toBeUndefined();
    expect(
      await memberRepo.updateDisplayName(db, {
        ...args,
        administratorUserId: target.id,
        name: "Not allowed",
      }),
    ).toBeUndefined();
    expect(
      (await db.select().from(users).where(eq(users.id, target.id)))[0]?.name,
    ).toBe(args.name);
  } finally {
    // TestDbClient casts its in-memory PGlite client to Pool for repository use.
    await (db.$client as unknown as { close(): Promise<void> }).close();
  }
}, 30000);
