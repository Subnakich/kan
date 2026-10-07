import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { env } from "next-runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as inviteLinkRepo from "@kan/db/repository/inviteLink.repo";
import * as memberRepo from "@kan/db/repository/member.repo";

import { createDatabaseHooks } from "./hooks";

vi.mock("next-runtime-env", () => ({ env: vi.fn() }));
vi.mock("@kan/db/repository/inviteLink.repo", () => ({
  getByCodeForRegistration: vi.fn(),
}));
vi.mock("@kan/db/repository/member.repo", () => ({
  getByEmailAndStatus: vi.fn(),
  getByPublicId: vi.fn(),
  acceptInvite: vi.fn(),
}));
vi.mock("@kan/db/repository/user.repo", () => ({ update: vi.fn() }));
vi.mock("@kan/email", () => ({
  createSubscriber: vi.fn(),
  triggerSubscriberWorkflow: vi.fn(),
}));
vi.mock("@kan/shared", () => ({ createS3Client: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({ PutObjectCommand: vi.fn() }));

const db = {} as Parameters<typeof createDatabaseHooks>[0];
const hooks = createDatabaseHooks(db);
const inviteCode = "abcdefgh1234";
const context = {
  path: "/sign-up/email",
  body: { callbackURL: `/invite/${inviteCode}` },
};
const fakeUser = {
  id: "user-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  email: "test@example.com",
  emailVerified: false,
  name: "Test User",
};
const now = new Date("2026-10-07T12:00:00Z").getTime();
const validInvite = {
  status: "active" as const,
  expiresAt: new Date(now + 60_000),
  workspaceDeletedAt: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.mocked(env).mockImplementation((key) =>
    key === "NEXT_PUBLIC_DISABLE_SIGN_UP" || key === "NEXT_PUBLIC_DISABLE_EMAIL"
      ? "true"
      : undefined,
  );
  vi.mocked(memberRepo.getByEmailAndStatus).mockResolvedValue(undefined);
  vi.mocked(inviteLinkRepo.getByCodeForRegistration).mockResolvedValue(
    validInvite,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("registration through workspace invite links", () => {
  it("allows an active link with public registration and email disabled", async () => {
    expect(await hooks.user.create.before(fakeUser, context)).toBe(true);
    expect(inviteLinkRepo.getByCodeForRegistration).toHaveBeenCalledWith(
      db,
      inviteCode,
    );
    expect(memberRepo.acceptInvite).not.toHaveBeenCalled();
  });

  it("allows a non-expiring active link", async () => {
    vi.mocked(inviteLinkRepo.getByCodeForRegistration).mockResolvedValue({
      ...validInvite,
      expiresAt: null,
    });
    expect(await hooks.user.create.before(fakeUser, context)).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["inactive", { ...validInvite, status: "inactive" as const }],
    ["expired", { ...validInvite, expiresAt: new Date(now - 1) }],
    ["expiry boundary", { ...validInvite, expiresAt: new Date(now) }],
    ["invalid expiration", { ...validInvite, expiresAt: new Date("invalid") }],
    [
      "deleted workspace",
      { ...validInvite, workspaceDeletedAt: new Date(now - 1) },
    ],
  ])("rejects a %s invitation", async (_name, invite) => {
    vi.mocked(inviteLinkRepo.getByCodeForRegistration).mockResolvedValue(
      invite,
    );
    expect(await hooks.user.create.before(fakeUser, context)).toBe(false);
  });

  it.each([
    null,
    undefined,
    {},
    { path: "/sign-up/email" },
    { path: "/sign-up/email", body: null },
    { path: "/sign-up/email", body: { callbackURL: 123 } },
    { ...context, path: "/callback/google" },
    { ...context, path: "/magic-link/verify" },
  ])(
    "rejects missing or unrelated authentication context: %j",
    async (requestContext) => {
      expect(await hooks.user.create.before(fakeUser, requestContext)).toBe(
        false,
      );
      expect(inviteLinkRepo.getByCodeForRegistration).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/boards",
    "/invite/not-a-real-code",
    `/invite/${inviteCode}/extra`,
    `/invite/${inviteCode}?next=/boards`,
    `/invite/${inviteCode}#fragment`,
    `/invite/${inviteCode}\n`,
    `https://kan.test/invite/${inviteCode}`,
    `https://evil.test/invite/${inviteCode}`,
    `//evil.test/invite/${inviteCode}`,
    `/invite/%61bcdefgh1234`,
    `/invite/${inviteCode.toUpperCase()}`,
  ])(
    "rejects a callback that is not a canonical local invite: %s",
    async (callbackURL) => {
      expect(
        await hooks.user.create.before(fakeUser, {
          ...context,
          body: { callbackURL },
        }),
      ).toBe(false);
      expect(inviteLinkRepo.getByCodeForRegistration).not.toHaveBeenCalled();
    },
  );

  it("keeps the allowed-domain restriction for valid invitation links", async () => {
    vi.stubEnv("BETTER_AUTH_ALLOWED_DOMAINS", "corp.example");
    expect(await hooks.user.create.before(fakeUser, context)).toBe(false);
  });

  it("allows a valid link when the email domain is allowed", async () => {
    vi.stubEnv("BETTER_AUTH_ALLOWED_DOMAINS", "example.com");
    expect(await hooks.user.create.before(fakeUser, context)).toBe(true);
  });

  it("does not change the existing email-invitation path", async () => {
    vi.mocked(memberRepo.getByEmailAndStatus).mockResolvedValue({
      id: 1,
      email: fakeUser.email,
      status: "invited",
    } as Awaited<ReturnType<typeof memberRepo.getByEmailAndStatus>>);
    expect(await hooks.user.create.before(fakeUser, {})).toBe(true);
    expect(inviteLinkRepo.getByCodeForRegistration).not.toHaveBeenCalled();
  });
});

describe("real Better Auth credentials request", () => {
  it.each([true, false])(
    "permits account creation only when the invite is valid: %s",
    async (valid) => {
      if (!valid)
        vi.mocked(inviteLinkRepo.getByCodeForRegistration).mockResolvedValue(
          undefined,
        );
      const store = { user: [], account: [], session: [], verification: [] };
      const auth = betterAuth({
        baseURL: "https://kan.test",
        secret: "local-invite-regression-test-secret-only-12345",
        database: memoryAdapter(store),
        emailAndPassword: { enabled: true },
        databaseHooks: hooks,
        logger: { disabled: true },
      });
      const response = await auth.handler(
        new Request("https://kan.test/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://kan.test",
          },
          body: JSON.stringify({
            name: fakeUser.name,
            email: fakeUser.email,
            password: "local-test-password-12345",
            callbackURL: context.body.callbackURL,
          }),
        }),
      );
      expect(response.ok).toBe(valid);
      expect(store.user).toHaveLength(valid ? 1 : 0);
      expect(store.account).toHaveLength(valid ? 1 : 0);
      expect(store.session).toHaveLength(valid ? 1 : 0);
      expect(inviteLinkRepo.getByCodeForRegistration).toHaveBeenCalledWith(
        db,
        inviteCode,
      );
    },
  );
});
