import type { CreateNextContextOptions } from "@trpc/server/adapters/next";
import { describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@kan/auth/server", () => ({
  initAuth: vi.fn(() => ({ api: { getSession } })),
}));
vi.mock("@kan/db/client", () => ({
  createDrizzleClient: vi.fn(() => ({})),
}));
vi.mock("@kan/logger", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn() })),
}));

const { createRESTContext, createTRPCContext, createNextApiContext } =
  await import("./trpc-context.js");

function makeOpts(): CreateNextContextOptions {
  return {
    req: { headers: {} },
    res: {},
    info: {},
  } as unknown as CreateNextContextOptions;
}

describe("createRESTContext", () => {
  it("propagates a rate-limited API key as TOO_MANY_REQUESTS instead of treating it as unauthenticated", async () => {
    getSession.mockReset().mockRejectedValueOnce({
      name: "APIError",
      body: { code: "RATE_LIMITED", details: { tryAgainIn: 42000 } },
    });

    await expect(createRESTContext(makeOpts())).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("still treats a genuine session lookup failure as unauthenticated", async () => {
    getSession.mockReset().mockRejectedValueOnce(new Error("network error"));

    const ctx = await createRESTContext(makeOpts());

    expect(ctx.user).toBeUndefined();
  });

  it("resolves the user normally when the session is valid", async () => {
    getSession.mockReset().mockResolvedValueOnce({ user: { id: "user-1" } });

    const ctx = await createRESTContext(makeOpts());

    expect(ctx.user).toEqual({ id: "user-1" });
  });
});

describe("tRPC authentication after Better Auth upgrade", () => {
  it.each([401, 403])(
    "maps APIError %s to UNAUTHORIZED",
    async (statusCode) => {
      getSession
        .mockReset()
        .mockRejectedValue({ name: "APIError", statusCode });
      await expect(createTRPCContext(makeOpts())).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(createNextApiContext(makeOpts().req)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    },
  );

  it("keeps rate limiting distinct from invalid credentials", async () => {
    getSession
      .mockReset()
      .mockRejectedValue({ name: "APIError", body: { code: "RATE_LIMITED" } });
    await expect(createTRPCContext(makeOpts())).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("does not hide an unexpected database or session failure", async () => {
    const error = new Error("session storage unavailable");
    getSession.mockReset().mockRejectedValue(error);
    await expect(createTRPCContext(makeOpts())).rejects.toBe(error);
  });
});
