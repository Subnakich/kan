import { describe, expect, it } from "vitest";

import { checkIntegrationIp } from "./integration-ip-policy";

const env = { TASK_CONTROL_ALLOWED_IPS: "203.0.113.10" };
const request = (ip: string | undefined, forwarded?: string | string[]) => ({
  socket: { remoteAddress: ip },
  headers: { "x-forwarded-for": forwarded },
});

describe("integration IP policy", () => {
  it("leaves filtering off with an empty allowlist", () => {
    expect(checkIntegrationIp(request("127.0.0.1"), {}).allowed).toBe(true);
  });
  it("allows only the configured direct peer", () => {
    expect(checkIntegrationIp(request("203.0.113.10"), env).allowed).toBe(true);
    expect(checkIntegrationIp(request("203.0.113.11"), env)).toMatchObject({
      allowed: false,
      status: 403,
    });
  });
  it("matches IPv4-mapped IPv6 socket addresses", () => {
    expect(
      checkIntegrationIp(request("::ffff:203.0.113.10"), env).allowed,
    ).toBe(true);
  });
  it("supports IPv4 and IPv6 CIDRs and multiple entries", () => {
    const ranges = {
      TASK_CONTROL_ALLOWED_IPS: " 203.0.113.0/24, 2001:db8:1234::/48 ",
    };
    expect(checkIntegrationIp(request("203.0.113.200"), ranges).allowed).toBe(
      true,
    );
    expect(
      checkIntegrationIp(request("2001:db8:1234::9"), ranges).allowed,
    ).toBe(true);
    expect(
      checkIntegrationIp(request("2001:db8:1235::9"), ranges).allowed,
    ).toBe(false);
  });
  it("ignores forged forwarding headers from an untrusted peer", () => {
    expect(
      checkIntegrationIp(request("198.51.100.4", "203.0.113.10"), env).allowed,
    ).toBe(false);
  });
  it("uses forwarding only from an explicitly trusted proxy", () => {
    const proxied = { ...env, TASK_CONTROL_TRUSTED_PROXIES: "172.20.0.2" };
    expect(
      checkIntegrationIp(request("::ffff:172.20.0.2", "203.0.113.10"), proxied)
        .allowed,
    ).toBe(true);
    expect(
      checkIntegrationIp(request("172.20.0.3", "203.0.113.10"), proxied)
        .allowed,
    ).toBe(false);
  });
  it("ignores a spoofed allowed IP left of the real untrusted client", () => {
    const proxied = {
      ...env,
      TASK_CONTROL_TRUSTED_PROXIES: "172.20.0.2,172.20.0.3",
    };
    expect(
      checkIntegrationIp(
        request("172.20.0.2", "203.0.113.10,198.51.100.4,172.20.0.3"),
        proxied,
      ).allowed,
    ).toBe(false);
    expect(
      checkIntegrationIp(
        request("172.20.0.2", "203.0.113.10,172.20.0.3"),
        proxied,
      ).allowed,
    ).toBe(true);
  });
  it.each([
    undefined,
    "",
    "not-an-ip",
    "203.0.113.10:443",
    ["203.0.113.10"],
    "203.0.113.10,,172.20.0.3",
  ])("denies missing or malformed proxy chains: %s", (header) => {
    expect(
      checkIntegrationIp(request("172.20.0.2", header), {
        ...env,
        TASK_CONTROL_TRUSTED_PROXIES: "172.20.0.2",
      }).allowed,
    ).toBe(false);
  });
  it("rejects chains containing only trusted proxies or excessive hops", () => {
    const proxied = { ...env, TASK_CONTROL_TRUSTED_PROXIES: "172.20.0.2" };
    expect(
      checkIntegrationIp(request("172.20.0.2", "172.20.0.2"), proxied).allowed,
    ).toBe(false);
    expect(
      checkIntegrationIp(
        request("172.20.0.2", Array(33).fill("203.0.113.10").join(",")),
        proxied,
      ).allowed,
    ).toBe(false);
  });
  it.each([
    "bad",
    "203.0.113.10/33",
    "2001:db8::/129",
    "203.0.113.10/",
    "203.0.113.10,",
    "203.0.113.10/24/2",
    "203.0.113.10/-1",
  ])("fails closed on invalid configuration: %s", (value) => {
    expect(
      checkIntegrationIp(request("203.0.113.10"), {
        TASK_CONTROL_ALLOWED_IPS: value,
      }),
    ).toMatchObject({ allowed: false, status: 503 });
  });
  it("also fails closed on an invalid trusted-proxy setting", () => {
    expect(
      checkIntegrationIp(request("203.0.113.10"), {
        ...env,
        TASK_CONTROL_TRUSTED_PROXIES: "oops",
      }),
    ).toMatchObject({ allowed: false, status: 503 });
  });
  it("denies missing or invalid socket addresses", () => {
    expect(checkIntegrationIp(request(undefined), env).allowed).toBe(false);
    expect(checkIntegrationIp(request("unknown"), env).allowed).toBe(false);
  });
});
