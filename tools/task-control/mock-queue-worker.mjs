// Bounded local UI proof; never connects to production Kan/Redmine/Telegram.
import assert from "node:assert/strict";

import { base, integration } from "./client.mjs";
import { mockAnswer } from "./mock-queue-client.mjs";

const boardId = process.argv[2];
assert.match(boardId ?? "", /^[a-z0-9]{12}$/);
assert.ok(["localhost", "127.0.0.1", "web"].includes(new URL(base).hostname));
const stopAt = Date.now() + 180_000;
while (Date.now() < stopAt) {
  const claimed = await integration("/redmine/requests/claim", "POST", {
    board_ids: [boardId],
    limit: 1,
  });
  assert.equal(claimed.status, 200);
  for (const job of claimed.data.items) {
    const result = await mockAnswer(job);
    console.log(`${job.kind}: ${result.state}`);
  }
  if (process.argv.includes("--once")) break;
  await new Promise((resolve) => setTimeout(resolve, 750));
}
