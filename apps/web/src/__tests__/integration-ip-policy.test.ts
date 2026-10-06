import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createCaller, capabilities, context } = vi.hoisted(() => ({
  createCaller: vi.fn(),
  capabilities: vi.fn().mockResolvedValue({ api_version: "1.0" }),
  context: vi.fn().mockReturnValue({}),
}));
vi.mock("@kan/api", async () => ({
  checkIntegrationIp: (
    await import("../../../../packages/api/src/utils/integration-ip-policy")
  ).checkIntegrationIp,
  taskIntegrationRouter: { createCaller },
}));
vi.mock("@kan/api/trpc-context", () => ({ createServiceApiContext: context }));
vi.mock("@kan/db/repository/task-control.repo", () => ({
  TaskControlError: class TaskControlError extends Error {},
}));

const handler = (await import("../pages/api/integrations/v1/[...path]"))
  .default;
const call = async (ip: string, forwarded?: string) => {
  const req = {
    method: "GET",
    query: { path: ["capabilities"] },
    socket: { remoteAddress: ip },
    headers: {
      "x-forwarded-for": forwarded,
      authorization: "Bearer test-token",
    },
  } as unknown as NextApiRequest;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const res = {
    setHeader: vi.fn(),
    status,
    json,
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { status, json };
};

describe("integration REST adapter IP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TASK_CONTROL_ALLOWED_IPS", "203.0.113.10");
    vi.stubEnv("TASK_CONTROL_TRUSTED_PROXIES", "");
    createCaller.mockReturnValue({ capabilities });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("rejects a foreign socket before creating the service context", async () => {
    const { status } = await call("198.51.100.9", "203.0.113.10");
    expect(status).toHaveBeenCalledWith(403);
    expect(context).not.toHaveBeenCalled();
    expect(createCaller).not.toHaveBeenCalled();
  });
  it("lets an allowed peer reach the authenticated service caller", async () => {
    const { json } = await call("::ffff:203.0.113.10");
    const received: unknown = context.mock.calls[0]?.[0];
    expect(received).toMatchObject({
      headers: { authorization: "Bearer test-token" },
    });
    expect(capabilities).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({ api_version: "1.0" });
  });
  it("accepts the real bot behind a configured proxy", async () => {
    vi.stubEnv("TASK_CONTROL_TRUSTED_PROXIES", "172.20.0.2");
    await call("172.20.0.2", "203.0.113.10");
    expect(capabilities).toHaveBeenCalledOnce();
  });
  it("fails closed on a configuration typo", async () => {
    vi.stubEnv("TASK_CONTROL_ALLOWED_IPS", "203.0.113.10/99");
    const { status } = await call("203.0.113.10");
    expect(status).toHaveBeenCalledWith(503);
    expect(context).not.toHaveBeenCalled();
  });
});
