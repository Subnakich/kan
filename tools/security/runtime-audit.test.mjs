// No network or Docker: prove the shipped image audit remains fail-closed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "../..");
const source = readFileSync(
  path.join(root, "tools/security/audit-runtime-image.cjs"),
  "utf8",
);
const sdk = "@modelcontextprotocol/sdk";

async function audit(advisories, status = 200, reject = false) {
  let stdout = "";
  let stderr = "";
  let submitted;
  const process = {
    exitCode: 0,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  };
  const manifests = new Map([
    ["/app/package.json", { name: "audit-fixture", version: "0.0.0" }],
    ["/app/sdk/package.json", { name: sdk, version: "1.31.0" }],
  ]);
  const fs = {
    realpathSync: (file) => file,
    existsSync: (file) => manifests.has(file),
    readFileSync: (file) => JSON.stringify(manifests.get(file)),
    readdirSync: (file) =>
      file === "/app" ? [{ name: "sdk", isDirectory: () => true }] : [],
  };
  await vm.runInNewContext(source, {
    require: (name) => {
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      throw new Error("Unexpected dependency");
    },
    process,
    AbortSignal,
    fetch: async (url, options) => {
      assert.equal(
        url,
        "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
      );
      submitted = JSON.parse(options.body);
      if (reject) throw new Error("Fixture registry unavailable");
      return {
        ok: status === 200,
        status,
        json: async () => advisories,
      };
    },
  });
  return { exitCode: process.exitCode, stdout, stderr, submitted };
}

test("both runtime consumers pin the patched SDK and lockfile resolves it", () => {
  for (const directory of ["apps/web", "packages/mcp"]) {
    const manifest = JSON.parse(
      readFileSync(path.join(root, directory, "package.json"), "utf8"),
    );
    assert.equal(manifest.dependencies[sdk], "1.31.0");
  }
  const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /'@modelcontextprotocol\/sdk@1\.31\.0'/);
  assert.doesNotMatch(lock, /'@modelcontextprotocol\/sdk@1\.29\.0'/);
});

for (const severity of ["high", "critical"]) {
  test(`${severity} advisory still blocks the image`, async () => {
    const result = await audit({
      [sdk]: [{ severity, title: "Fixture advisory" }],
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /"highOrCritical":1/);
    assert.deepEqual(result.submitted[sdk], ["1.31.0"]);
  });
}

test("moderate/low findings stay visible but do not block", async () => {
  const result = await audit({
    [sdk]: [{ severity: "moderate" }, { severity: "low" }],
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"highOrCritical":0/);
  assert.match(result.stdout, /"moderate":1/);
});

test("registry HTTP failure blocks the image", async () => {
  const result = await audit({}, 503);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /HTTP 503/);
});

test("registry connection failure blocks the image", async () => {
  const result = await audit({}, 200, true);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /registry unavailable/);
});
