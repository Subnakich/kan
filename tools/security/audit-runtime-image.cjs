// Run inside the built image with Node, not in the development checkout.
// Checks package metadata physically shipped in /app. Bundled code without
// package metadata still requires the separate source/lockfile review.
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const packages = new Map();
  const seen = new Set();
  function visit(directory) {
    const real = fs.realpathSync(directory);
    if (seen.has(real)) return;
    seen.add(real);
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const entry = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (entry.name && entry.version) {
        const versions = packages.get(entry.name) ?? new Set();
        versions.add(entry.version);
        packages.set(entry.name, versions);
      }
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".next", "public"].includes(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (
        entry.isSymbolicLink() &&
        fs.existsSync(child) &&
        fs.statSync(child).isDirectory()
      )
        visit(child);
    }
  }
  visit("/app");
  const versions = Object.fromEntries(
    [...packages].map(([name, values]) => [name, [...values]]),
  );
  const response = await fetch(
    "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(versions),
      signal: AbortSignal.timeout(45000),
    },
  );
  if (!response.ok)
    throw new Error(`Advisory registry HTTP ${response.status}`);
  const advisories = await response.json();
  let blocked = 0;
  const counts = { low: 0, moderate: 0, high: 0, critical: 0 };
  for (const [name, entries] of Object.entries(advisories)) {
    for (const entry of entries) {
      counts[entry.severity] = (counts[entry.severity] ?? 0) + 1;
      if (["high", "critical"].includes(entry.severity)) blocked++;
    }
    process.stdout.write(
      `${JSON.stringify({ name, versions: versions[name], advisories: entries.map(({ severity, title, url, vulnerable_versions }) => ({ severity, title, url, range: vulnerable_versions })) })}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ packages: packages.size, counts, highOrCritical: blocked })}\n`,
  );
  if (blocked) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
