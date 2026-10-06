import { createHash } from "node:crypto";

export const base = process.env.KAN_DEMO_URL ?? "http://localhost:3000";
export const demoEmail = "alan@kan.local";
export const demoPassword = "Kan-local-demo-2026!";
export const serviceToken =
  process.env.TASK_CONTROL_SERVICE_TOKEN ?? "local-kan-integration-token";
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export async function login(
  email = demoEmail,
  password = demoPassword,
  name = "Alan — local demo",
) {
  const headers = {
    "content-type": "application/json",
    origin: "http://localhost:3100",
  };
  await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password, name }),
  });
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok)
    throw new Error(
      `Local demo login failed: ${response.status} ${await response.text()}`,
    );
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
export async function rpc(cookie, procedure, input = {}, mutation = false) {
  const encoded =
    input === null
      ? { json: null, meta: { values: ["undefined"], v: 1 } }
      : input.dueDate instanceof Date
        ? {
            json: { ...input, dueDate: input.dueDate.toISOString() },
            meta: { values: { dueDate: ["Date"] }, v: 1 },
          }
        : { json: input };
  const payload = JSON.stringify(encoded);
  const response = await fetch(
    `${base}/api/trpc/${procedure}${mutation ? "" : `?input=${encodeURIComponent(payload)}`}`,
    {
      method: mutation ? "POST" : "GET",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://localhost:3100",
      },
      ...(mutation ? { body: payload } : {}),
    },
  );
  const result = await response.json();
  if (!response.ok || result.error)
    throw new Error(result.error?.json?.message ?? JSON.stringify(result));
  return result.result.data.json;
}
export async function integration(path, method = "GET", body, key) {
  const response = await fetch(`${base}/api/integrations/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
export function importPayload(
  board,
  member,
  id,
  title,
  due = "2026-10-07T15:30:00+03:00",
) {
  const meeting = {
    id: "local-demo-2026-10-06",
    title: "Планерка — локальный пример",
    started_at: "2026-10-06T10:00:00+03:00",
    timezone: "Europe/Moscow",
    source_ref: null,
  };
  const task = {
    id,
    title,
    description:
      "Подготовить результат, проверить его и зафиксировать решение в карточке.",
    acceptance_criteria: [
      "Результат доступен по ссылке в карточке",
      "Есть подтверждение ответственного",
    ],
    assignee: member
      ? { member_public_id: member.member_public_id, name: member.name }
      : null,
    due_at: due,
    due_text: "Завтра к 15:30 по Москве",
    labels: [],
    checklist: ["Подготовить", "Проверить"],
    source: {
      quote: `${title}. Алан, возьми на себя, к завтра 15:30.`,
      timestamp: "00:12:45",
    },
    review_notes: [],
  };
  const payload = { board_id: board, meeting, task };
  return {
    ...payload,
    external_key: `trisoft-kan-local:${meeting.id}:${task.id}`,
    payload_hash: hash(payload),
  };
}
