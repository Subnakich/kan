// Local contract demo only. Never calls a real Redmine or Telegram API.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";

const root = process.env.MOCK_STATE_DIR ?? "/data";
await mkdir(root, { recursive: true });
let state;
try {
  state = JSON.parse(await readFile(`${root}/state.json`, "utf8"));
} catch {
  state = { previews: {}, operations: {}, counter: 1000 };
}
const save = async () => {
  await writeFile(`${root}/state.tmp`, JSON.stringify(state));
  await rename(`${root}/state.tmp`, `${root}/state.json`);
};
const option = (id, name) => ({ id, name });
const options = {
  trackers: [option(1, "Task")],
  statuses: [option(1, "New")],
  priorities: [option(2, "Normal"), option(3, "High")],
  custom_fields: [],
};
function failure(message, status = 422) {
  return Object.assign(new Error(message), { status });
}
async function kan(path, method = "GET", body) {
  const response = await fetch(
    `${process.env.KAN_URL}/api/integrations/v1${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${process.env.TASK_CONTROL_SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw failure(data.error ?? "Kan unavailable", response.status);
  return data;
}
async function authorize(card, actor) {
  const members = await kan(`/boards/${card.board_id}/members`);
  if (!members.some((member) => member.member_public_id === actor))
    throw failure("Actor is not a workspace member", 403);
}
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 262144) throw failure("Request too large", 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw failure("Invalid JSON");
  }
}
async function handle(req) {
  const secret = process.env.TASK_CONTROL_GATEWAY_TOKEN;
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (
    !secret ||
    !token ||
    token.length !== secret.length ||
    !timingSafeEqual(Buffer.from(secret), Buffer.from(token))
  )
    throw failure("Unauthorized", 401);
  const url = new URL(req.url, "http://gateway");
  const path = url.pathname.replace(/^\/internal\/kan\/v1/, "");
  if (req.method === "GET" && path === "/health")
    return { api_version: "1.0", demo: true };
  if (req.method === "GET" && path === "/redmine/projects")
    return {
      demo: true,
      items: [
        option(1, "DEMO — Meeting tasks"),
        option(2, "DEMO — Development"),
      ],
      has_more: false,
      next_cursor: null,
    };
  if (req.method === "GET" && /^\/redmine\/projects\/[12]\/options$/.test(path))
    return options;
  if (req.method === "POST" && path === "/redmine/exports/preview") {
    const input = await body(req);
    const card = await kan(`/cards/${input.card_id}`);
    await authorize(card, input.actor_member_id);
    if (card.revision !== input.expected_revision)
      throw failure("Card changed. Generate a fresh preview.", 409);
    if (
      !card.owner_member_public_id ||
      card.column_role === "review"
    )
      throw failure("Confirm the task in Queue before exporting.");
    if (
      ![1, 2].includes(input.project_id) ||
      !options.trackers.some((item) => item.id === input.tracker_id) ||
      !options.statuses.some((item) => item.id === input.status_id) ||
      !options.priorities.some((item) => item.id === input.priority_id)
    )
      throw failure("Invalid project options");
    if (card.redmine_link) throw failure("Card already exported", 409);
    const id = randomUUID();
    const expires = new Date(Date.now() + 5 * 60000).toISOString();
    const snapshot = {
      ...card,
      redmine: {
        project_id: input.project_id,
        tracker_id: input.tracker_id,
        status_id: input.status_id,
        priority_id: input.priority_id,
        custom_fields: input.custom_fields,
        subject: card.title,
        due_date: card.due_at ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Moscow",
        }).format(new Date(card.due_at)) : null,
        description: `${card.description}\n\nExact deadline: ${card.due_at} (Europe/Moscow)\nKan: ${card.url}\nOwner: ${card.owner_member_public_id}\n\nSnapshot:\n${JSON.stringify(card, null, 2)}`,
      },
    };
    const preview = {
      preview_id: id,
      expires_at: expires,
      snapshot,
      warnings: [
        "DEMO: no real issue will be created; owner mapping requires the real Telegram bot worker.",
      ],
      errors: [],
    };
    state.previews[id] = { ...preview, actor: input.actor_member_id };
    await save();
    return preview;
  }
  if (req.method === "POST" && path === "/redmine/exports") {
    const input = await body(req);
    const preview = state.previews[input.preview_id];
    if (!preview || preview.actor !== input.actor_member_id)
      throw failure("Preview not found or belongs to another actor", 403);
    const cardId = preview.snapshot.card_id;
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key.endsWith(`:${cardId}`))
      throw failure("Export key must refer to the preview card");
    const card = await kan(`/cards/${cardId}`);
    await authorize(card, input.actor_member_id);
    if (state.operations[key]) {
      const existing = state.operations[key];
      if (!card.redmine_link)
        await kan(
          `/cards/${cardId}/redmine-link`,
          "PUT",
          existing.redmine_link,
        );
      existing.status = "linked";
      await save();
      return existing;
    }
    if (Date.parse(preview.expires_at) < Date.now())
      throw failure("Preview expired. Generate a new preview.", 409);
    if (card.revision !== preview.snapshot.revision)
      throw failure(
        "Card changed after preview. Generate a fresh preview.",
        409,
      );
    const issue = ++state.counter;
    const link = {
      instance_id: "mock-redmine",
      issue_id: issue,
      display_id: `DEMO-${issue}`,
      url: `https://redmine.example.test/issues/${issue}`,
      exported_at: new Date().toISOString(),
      exported_revision: card.revision,
    };
    const operation = {
      operation_id: randomUUID(),
      status: "created",
      redmine_link: link,
      errors: [],
      actor: input.actor_member_id,
      card_id: cardId,
    };
    state.operations[key] = operation;
    await save(); // Journal before the callback: retries reuse the same issue.
    await kan(`/cards/${cardId}/redmine-link`, "PUT", link);
    operation.status = "linked";
    await save();
    return operation;
  }
  if (req.method === "GET" && path.startsWith("/redmine/exports/")) {
    const operation = Object.values(state.operations).find(
      (item) => item.operation_id === path.split("/").at(-1),
    );
    if (
      !operation ||
      operation.actor !== url.searchParams.get("actor_member_id")
    )
      throw failure("Operation not found", 404);
    return operation;
  }
  throw failure("Gateway route not found", 404);
}
// Serial processing keeps the demo journal atomic, including concurrent retries.
let queue = Promise.resolve();
http
  .createServer((req, res) => {
    queue = queue.then(async () => {
      try {
        const data = await handle(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (error) {
        res.writeHead(error.status ?? 503, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            code: "DEMO_GATEWAY_ERROR",
            message: error.message,
            retryable: (error.status ?? 503) >= 500,
            operation_id: null,
          }),
        );
      }
    });
  })
  .listen(8090, "0.0.0.0", () =>
    console.log("Kan mock gateway — local demo only, port 8090"),
  );
