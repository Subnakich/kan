import type { NextApiRequest, NextApiResponse } from "next";
import { describe, expect, it, vi } from "vitest";

import handler from "../pages/api/health";

describe("liveness endpoint", () => {
  it.each([
    ["GET", 200, { status: "ok" }],
    ["POST", 405, { error: "Method not allowed" }],
  ])("%s returns %s", (method, code, body) => {
    const req = { method } as NextApiRequest;
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const res = {
      status,
      json,
      setHeader: vi.fn(),
    } as unknown as NextApiResponse;
    handler(req, res);
    expect(status).toHaveBeenCalledWith(code);
    expect(json).toHaveBeenCalledWith(body);
  });
});
