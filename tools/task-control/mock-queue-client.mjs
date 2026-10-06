// Local QA adapter only; Kan itself never calls this fixture.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { base, integration, rpc } from "./client.mjs";

export async function mockAnswer(job) {
  assert.ok(
    ["localhost", "127.0.0.1", "web"].includes(new URL(base).hostname),
    "Local mock only",
  );
  const command = job.request;
  const response = await fetch(
    `http://gateway:8090/internal/kan/v1${command.path}`,
    {
      method: command.method,
      headers: {
        authorization: "Bearer local-gateway-integration-token",
        "content-type": "application/json",
        ...(command.idempotency_key
          ? { "idempotency-key": command.idempotency_key }
          : {}),
      },
      ...(command.body ? { body: JSON.stringify(command.body) } : {}),
    },
  );
  const result = await response.json();
  const ack = await integration(
    `/redmine/requests/${job.request_id}/result`,
    "POST",
    {
      lease_token: job.lease_token,
      state: response.ok
        ? "completed"
        : job.kind === "export" && response.status >= 500
          ? "unknown"
          : "failed",
      result: response.ok ? result : null,
      error: response.ok ? null : (result.message ?? "Mock request failed"),
    },
  );
  assert.equal(ack.status, 200);
  return ack.data;
}
export async function queuedMock(cookie, cardPublicId, kind, selection = {}) {
  const request = await rpc(
    cookie,
    "taskControl.redmineRequest",
    {
      cardPublicId,
      request_key: randomUUID().replaceAll("-", "").slice(0, 12),
      kind,
      ...selection,
    },
    true,
  );
  if (request.state === "completed") return request.result.data;
  const snapshot = (await integration(`/cards/${cardPublicId}`)).data;
  const claimed = await integration("/redmine/requests/claim", "POST", {
    board_ids: [snapshot.board_id],
    limit: 10,
  });
  assert.equal(claimed.status, 200);
  const job = claimed.data.items.find(
    (item) => item.request_id === request.request_id,
  );
  assert.ok(job);
  const completed = await mockAnswer(job);
  if (completed.state !== "completed") throw new Error(completed.error);
  return completed.result.data;
}
