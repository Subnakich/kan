// Isolated test database ONLY. Never run with real users or on production.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { base, login, rpc } from "../task-control/client.mjs";

const mode = process.argv[2];
const fixturePath = "/data/auth-upgrade-key.json";
const cookie = await login();
const headers = {
  cookie,
  "content-type": "application/json",
  origin: "http://localhost:3100",
};
async function request(route, method = "GET", body, override = {}) {
  const response = await fetch(`${base}/api/auth/${route}`, {
    method,
    headers: { ...headers, ...override },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`);
  return result;
}
async function bearerWorkspace(key) {
  const input = JSON.stringify({
    json: null,
    meta: { values: ["undefined"], v: 1 },
  });
  const response = await fetch(
    `${base}/api/trpc/workspace.all?input=${encodeURIComponent(input)}`,
    {
      headers: { authorization: `Bearer ${key}`, origin: headers.origin },
    },
  );
  assert.equal(response.status, 200, "API key should authorize protected tRPC");
  assert.ok((await response.json()).result.data.json.length > 0);
}

if (mode === "seed-legacy") {
  const key = await request("api-key/create", "POST", {
    name: "Upgrade preservation test",
    prefix: "kan_",
  });
  assert.ok(key.key);
  await bearerWorkspace(key.key);
  await writeFile(fixturePath, JSON.stringify({ id: key.id, key: key.key }), {
    mode: 0o600,
  });
  process.stdout.write(
    "PASS: legacy account signs in; legacy API key created and authorizes\n",
  );
} else if (mode === "check") {
  const legacy = JSON.parse(await readFile(fixturePath, "utf8"));
  const listed = await request("api-key/list");
  assert.ok(
    Array.isArray(listed.apiKeys),
    "new list response must have apiKeys",
  );
  assert.ok(
    listed.apiKeys.some((key) => String(key.id) === String(legacy.id)),
    "legacy key must remain listed",
  );
  await bearerWorkspace(legacy.key);
  process.stdout.write(
    "PASS: existing account and pre-upgrade API key remain valid\n",
  );
  const fresh = await request("api-key/create", "POST", {
    name: "New API key test",
    prefix: "kan_",
  });
  assert.ok(fresh.referenceId);
  assert.equal(fresh.configId, "default");
  await bearerWorkspace(fresh.key);
  await request("api-key/delete", "POST", { keyId: String(fresh.id) });
  const input = JSON.stringify({
    json: null,
    meta: { values: ["undefined"], v: 1 },
  });
  const response = await fetch(
    `${base}/api/trpc/workspace.all?input=${encodeURIComponent(input)}`,
    { headers: { authorization: `Bearer ${fresh.key}` } },
  );
  assert.equal(response.status, 401, "revoked API key must not authorize");
  process.stdout.write("PASS: new API key create, owner, use and revoke\n");
  const stranger = await login(
    "auth-outsider@kan.local",
    "Kan-local-demo-2026!",
    "Isolated auth outsider",
  );
  const other = await request("api-key/list", "GET", undefined, {
    cookie: stranger,
  });
  assert.equal(other.apiKeys.length, 0, "other user cannot list keys");
  process.stdout.write("PASS: API keys are scoped to their owner\n");
} else throw new Error("Expected seed-legacy or check");
