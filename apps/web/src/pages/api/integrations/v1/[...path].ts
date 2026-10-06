import type { NextApiRequest, NextApiResponse } from "next";
import { TRPCError } from "@trpc/server";

import { checkIntegrationIp, taskIntegrationRouter } from "@kan/api";
import { createServiceApiContext } from "@kan/api/trpc-context";
import { TaskControlError } from "@kan/db/repository/task-control.repo";

export const config = { api: { bodyParser: { sizeLimit: "256kb" } } };
const httpStatuses: Partial<Record<TRPCError["code"], number>> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BAD_REQUEST: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SERVICE_UNAVAILABLE: 503,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
};
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  const ipPolicy = checkIntegrationIp(req);
  if (!ipPolicy.allowed)
    return res.status(ipPolicy.status).json({ error: ipPolicy.error });
  try {
    const caller = taskIntegrationRouter.createCaller(
      createServiceApiContext(req),
    );
    const path = Array.isArray(req.query.path) ? req.query.path : [];
    const query = (key: string) =>
      typeof req.query[key] === "string" ? req.query[key] : undefined;
    if (req.method === "GET") {
      if (path.length === 3 && path[0] === "redmine" && path[1] === "requests")
        return res.json(await caller.redmineRequest({ request_id: path[2]! }));
      if (path.join("/") === "capabilities")
        return res.json(await caller.capabilities());
      if (path.join("/") === "boards") return res.json(await caller.boards());
      if (path[0] === "boards" && path[1] && path[2] === "members")
        return res.json(await caller.members({ board_id: path[1] }));
      if (path[0] === "boards" && path[1] && path[2] === "cards")
        return res.json(
          await caller.cards({ board_id: path[1], cursor: query("cursor") }),
        );
      if (path.join("/") === "changes")
        return res.json(await caller.changes({ cursor: query("cursor") }));
      if (path[0] === "cards" && path[1] && path.length === 2)
        return res.json(await caller.card({ card_id: path[1] }));
      if (
        path[0] === "cards" &&
        path[1] &&
        path[2] === "attachments" &&
        path[3] &&
        path.length === 4
      ) {
        const download = await caller.attachment({
          card_id: path[1],
          attachment_id: path[3],
        });
        return res.redirect(302, download.url);
      }
      if (path.join("/") === "imports/cards")
        return res.json(
          await caller.importResult({
            external_key: query("external_key") ?? "",
          }),
        );
    }
    if (req.method === "POST" && path.join("/") === "redmine/requests/claim")
      return res.json(
        await caller.redmineClaim(
          req.body as Parameters<typeof caller.redmineClaim>[0],
        ),
      );
    if (
      req.method === "POST" &&
      path.length === 4 &&
      path[0] === "redmine" &&
      path[1] === "requests"
    ) {
      if (path[3] === "lease")
        return res.json(
          await caller.redmineRenew({
            ...(req.body as Omit<
              Parameters<typeof caller.redmineRenew>[0],
              "request_id"
            >),
            request_id: path[2]!,
          }),
        );
      if (path[3] === "result")
        return res.json(
          await caller.redmineResult({
            ...(req.body as Omit<
              Parameters<typeof caller.redmineResult>[0],
              "request_id"
            >),
            request_id: path[2]!,
          }),
        );
    }
    if (req.method === "POST" && path.join("/") === "imports/cards") {
      const body = req.body as Record<string, unknown>;
      if (req.headers["idempotency-key"] !== body.external_key)
        return res
          .status(422)
          .json({ error: "Idempotency-Key must equal external_key" });
      const result = await caller.import(
        body as Parameters<typeof caller.import>[0],
      );
      return res.status(result.created ? 201 : 200).json(result);
    }
    if (
      req.method === "PUT" &&
      path[0] === "cards" &&
      path[1] &&
      path[2] === "redmine-link"
    )
      return res.json(
        await caller.redmineLink({
          card_id: path[1],
          link: req.body as Parameters<typeof caller.redmineLink>[0]["link"],
        }),
      );
    return res.status(404).json({ error: "Integration route not found" });
  } catch (error) {
    let root: unknown = error;
    for (
      let depth = 0;
      root &&
      typeof root === "object" &&
      "cause" in root &&
      root.cause &&
      depth < 6;
      depth++
    )
      root = root.cause;
    // Do not log raw payloads, SQL parameters or transcript contents.
    if (root instanceof Error && !(root instanceof TaskControlError))
      console.error("Task integration failed", { name: root.name });
    const cause = error instanceof TRPCError ? error.cause : error;
    const domain =
      cause instanceof TaskControlError
        ? cause
        : error instanceof TaskControlError
          ? error
          : null;
    const status =
      domain?.status ??
      (error instanceof TRPCError ? (httpStatuses[error.code] ?? 500) : 500);
    return res.status(status).json({
      error:
        domain?.message ??
        (status < 500 && error instanceof Error
          ? error.message
          : "Integration request failed"),
    });
  }
}
