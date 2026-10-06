// Executed through docker exec, before the public vhost is enabled.
// Credentials arrive on stdin, never in arguments, files or console output.
const { readFileSync } = require("node:fs");

async function main() {
  const [name, email, password] = readFileSync(0, "utf8").split("\0");
  if (!name || !email || !password || password.length < 12)
    throw new Error("Name, email and a password of at least 12 characters required");
  const origin = process.env.NEXT_PUBLIC_BASE_URL;
  const headers = {
    "content-type": "application/json",
    origin,
    host: new URL(origin).host,
    "x-forwarded-proto": "https",
  };
  for (const [path, body] of [
    ["sign-up/email", { name, email, password }],
    ["sign-in/email", { email, password }],
  ]) {
    const response = await fetch(`http://127.0.0.1:3000/api/auth/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok || !result.user?.id)
      throw new Error(`Account bootstrap failed at ${path}: HTTP ${response.status}`);
  }
  process.stdout.write("First account created; sign-in verified.\n");
}
main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
