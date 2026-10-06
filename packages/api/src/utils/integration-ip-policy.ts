import { BlockList, isIP } from "node:net";

interface RequestAddress {
  socket: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}
interface PolicyEnvironment {
  TASK_CONTROL_ALLOWED_IPS?: string;
  TASK_CONTROL_TRUSTED_PROXIES?: string;
}
type PolicyResult =
  | { allowed: true }
  | { allowed: false; status: 403 | 503; error: string };

function parseNetworks(value: string): BlockList {
  const networks = new BlockList();
  for (const entry of value.split(",")) {
    const parts = entry.trim().split("/");
    const address = parts[0] ?? "";
    const version = isIP(address);
    if (!version || parts.length > 2) throw new Error("Invalid IP policy");
    const family = version === 4 ? "ipv4" : "ipv6";
    if (parts.length === 1) {
      networks.addAddress(address, family);
    } else {
      const prefix = parts[1] ?? "";
      if (!/^\d{1,3}$/.test(prefix)) throw new Error("Invalid IP policy");
      const bits = Number(prefix);
      if (bits > (version === 4 ? 32 : 128))
        throw new Error("Invalid IP policy");
      networks.addSubnet(address, bits, family);
    }
  }
  return networks;
}

function contains(networks: BlockList, address: string): boolean {
  const version = isIP(address);
  return !!version && networks.check(address, version === 4 ? "ipv4" : "ipv6");
}

/** Only the dedicated integration REST adapter uses this policy, not the UI. */
export function checkIntegrationIp(
  req: RequestAddress,
  env: PolicyEnvironment = {
    TASK_CONTROL_ALLOWED_IPS: process.env.TASK_CONTROL_ALLOWED_IPS,
    TASK_CONTROL_TRUSTED_PROXIES: process.env.TASK_CONTROL_TRUSTED_PROXIES,
  },
): PolicyResult {
  const allowedValue = env.TASK_CONTROL_ALLOWED_IPS?.trim() ?? "";
  const proxiesValue = env.TASK_CONTROL_TRUSTED_PROXIES?.trim() ?? "";
  let allowed: BlockList | undefined;
  let proxies: BlockList | undefined;
  try {
    // Validate even unused proxy settings: a typo must never silently disable protection.
    allowed = allowedValue ? parseNetworks(allowedValue) : undefined;
    proxies = proxiesValue ? parseNetworks(proxiesValue) : undefined;
  } catch {
    return {
      allowed: false,
      status: 503,
      error: "Integration IP policy is invalid",
    };
  }
  // Empty allowlist preserves local development. Production must configure it explicitly.
  if (!allowed) return { allowed: true };
  const denied = {
    allowed: false,
    status: 403,
    error: "Integration source is not allowed",
  } as const;
  let client = req.socket.remoteAddress ?? "";
  if (!isIP(client)) return denied;
  if (proxies && contains(proxies, client)) {
    const header = req.headers["x-forwarded-for"];
    if (typeof header !== "string" || header.length > 4096) return denied;
    const chain = header.split(",").map((part) => part.trim());
    if (chain.length > 32 || chain.some((address) => !isIP(address)))
      return denied;
    // Walk from our socket peer back through trusted hops. Ignore spoofed leftmost entries.
    while (chain.length && contains(proxies, client)) {
      const hop = chain.pop();
      if (!hop) return denied;
      client = hop;
    }
    // A chain containing only proxies has not identified a bot/client.
    if (contains(proxies, client)) return denied;
  }
  return contains(allowed, client) ? { allowed: true } : denied;
}
