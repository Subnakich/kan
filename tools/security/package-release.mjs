// Package the current checkout, including intended uncommitted source changes.
// Generated archive/checksum outputs only; never copy local credentials or DBs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const release = process.argv[2] ?? "20261006-task-control-2";
if (!/^\d{8}-[a-z][a-z0-9-]{1,64}$/.test(release))
  throw new Error("Invalid immutable release label");
const output = mkdtempSync(join(tmpdir(), "kanban-release-"));
const folder = `kanban-release-${release}`;
const destination = join(output, folder);
mkdirSync(destination, { mode: 0o700 });
const listed = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root },
)
  .toString()
  .split("\0")
  .filter(Boolean);
const files = [...new Set(listed)].sort().filter((file) => {
  if (
    /(^|\/)(\.git|\.agents|\.codex|node_modules|\.next|dist|out|\.turbo|\.cache|coverage|__tests__|__pycache__|integration-tests)(\/|$)/.test(
      file,
    )
  )
    return false;
  if (
    file
      .split("/")
      .some((part) => part.startsWith(".env") && part !== ".env.example")
  )
    return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return false;
  if (file.endsWith(".check.yml")) return false;
  if (
    [
      "compose.local.yml",
      "Dockerfile.local",
      "deploy/bootstrap.override.yml",
      "RELEASE.sha256",
    ].includes(file)
  )
    return false;
  if (
    file.startsWith("tools/") &&
    file !== "tools/security/audit-runtime-image.cjs"
  )
    return false;
  if (file.startsWith(".github/") || file.startsWith(".husky/")) return false;
  return existsSync(join(root, file));
});
const manifest = [];
for (const file of files) {
  const source = join(root, file);
  if (!lstatSync(source).isFile())
    throw new Error(`Only regular source files allowed: ${file}`);
  const target = join(destination, file);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(source, target);
  manifest.push(
    `${createHash("sha256").update(readFileSync(target)).digest("hex")}  ${file}`,
  );
}
for (const required of [
  "LICENSE",
  "deploy/install-root.sh",
  "pnpm-lock.yaml",
  "tools/security/audit-runtime-image.cjs",
]) {
  if (!files.includes(required))
    throw new Error(`Missing release file: ${required}`);
}
writeFileSync(join(destination, "RELEASE.sha256"), `${manifest.join("\n")}\n`, {
  mode: 0o600,
});
const archive = join(output, `${folder}.tar.gz`);
execFileSync("tar", ["-czf", archive, "-C", output, folder], {
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
process.stdout.write(
  `${JSON.stringify({ directory: output, folder, archive, sha256, files: files.length })}\n`,
);
