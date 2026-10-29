import { describe, expect, test } from "bun:test";
import {
  addConflicts,
  evaluateChecklist,
  findHostname,
  ingressDiff,
  maskSecret,
  permissionFor,
  permissionLabel,
  moveHostname,
  normalizeCidr,
  normalizeHostname,
  normalizeService,
  originRequestFromFlags,
  parseDuration,
  removeIngress,
  resolveTunnel,
  resolveZoneCandidates,
  updateIngress,
  upsertIngress,
  type ChecklistInput,
  type TunnelConfig,
} from "./core.ts";

const catchAll = { service: "http_status:404" };

describe("normalizeService", () => {
  test("bare port means localhost", () => expect(normalizeService("3010")).toBe("http://localhost:3010"));
  test("localhost:port", () => expect(normalizeService("localhost:3010")).toBe("http://localhost:3010"));
  test("host:port", () => expect(normalizeService("nas.lan:8080")).toBe("http://nas.lan:8080"));
  test("ip:port", () => expect(normalizeService("192.168.1.5:80")).toBe("http://192.168.1.5:80"));
  test("ipv6:port", () => expect(normalizeService("[::1]:8080")).toBe("http://[::1]:8080"));
  test.each([
    "http://localhost:3000",
    "https://localhost:8443",
    "tcp://localhost:5432",
    "ssh://localhost:22",
    "rdp://localhost:3389",
    "unix:/run/app.sock",
    "unix+tls:/run/app.sock",
    "http_status:404",
    "hello_world",
  ])("%s passes through", (s) => expect(normalizeService(s)).toBe(s));
  test("trims whitespace", () => expect(normalizeService(" 3010 ")).toBe("http://localhost:3010"));
  test("rejects port 0 and >65535", () => {
    expect(() => normalizeService("0")).toThrow();
    expect(() => normalizeService("70000")).toThrow();
  });
  test("rejects garbage", () => {
    expect(() => normalizeService("localhost")).toThrow();
    expect(() => normalizeService("not a service")).toThrow();
  });
});

describe("normalizeHostname", () => {
  test("lowercases and drops trailing dot", () => expect(normalizeHostname("App.Example.COM.")).toBe("app.example.com"));
  test("allows wildcard", () => expect(normalizeHostname("*.example.com")).toBe("*.example.com"));
  test("rejects junk", () => {
    expect(() => normalizeHostname("localhost")).toThrow();
    expect(() => normalizeHostname("http://a.com")).toThrow();
  });
});

describe("resolveZoneCandidates", () => {
  test("longest first, stops at two labels", () =>
    expect(resolveZoneCandidates("a.b.example.co.uk")).toEqual(["a.b.example.co.uk", "b.example.co.uk", "example.co.uk", "co.uk"]));
  test("apex", () => expect(resolveZoneCandidates("example.com")).toEqual(["example.com"]));
  test("skips wildcard label", () => expect(resolveZoneCandidates("*.app.example.com")).toEqual(["app.example.com", "example.com"]));
});

describe("upsertIngress", () => {
  test("empty config gets rule plus catch-all", () => {
    expect(upsertIngress(null, { hostname: "a.example.com", service: "http://localhost:1" }).config.ingress).toEqual([
      { hostname: "a.example.com", service: "http://localhost:1" },
      catchAll,
    ]);
  });
  test("appends before the existing catch-all", () => {
    const config = { ingress: [{ hostname: "a.example.com", service: "http://localhost:1" }, { service: "http_status:503" }] };
    const result = upsertIngress(config, { hostname: "b.example.com", service: "http://localhost:2" });
    expect(result.replaced).toBe(false);
    expect(result.config.ingress!.map((r) => r.hostname)).toEqual(["a.example.com", "b.example.com", undefined]);
    expect(result.config.ingress!.at(-1)).toEqual({ service: "http_status:503" });
  });
  test("replaces the same hostname in place", () => {
    const config = { ingress: [{ hostname: "a.example.com", service: "http://localhost:1" }, { hostname: "b.example.com", service: "x" }, catchAll] };
    const result = upsertIngress(config, { hostname: "A.example.com", service: "http://localhost:9" });
    expect(result.replaced).toBe(true);
    expect(result.config.ingress).toEqual([{ hostname: "A.example.com", service: "http://localhost:9" }, config.ingress[1]!, catchAll]);
  });
  test("adds a catch-all when the list lacks one", () => {
    const result = upsertIngress({ ingress: [{ hostname: "a.example.com", service: "x" }] }, { hostname: "b.example.com", service: "y" });
    expect(result.config.ingress!.at(-1)).toEqual(catchAll);
  });
  test("preserves other config keys and doesn't mutate input", () => {
    const config: TunnelConfig = { ingress: [catchAll], "warp-routing": { enabled: true }, originRequest: { connectTimeout: 10 } };
    const snapshot = structuredClone(config);
    const result = upsertIngress(config, { hostname: "a.example.com", service: "x" });
    expect(result.config["warp-routing"]).toEqual({ enabled: true });
    expect(result.config.originRequest).toEqual({ connectTimeout: 10 });
    expect(config).toEqual(snapshot);
  });
  test("path rules are separate keys from the bare hostname", () => {
    const config = { ingress: [{ hostname: "a.example.com", service: "web" }, catchAll] };
    const result = upsertIngress(config, { hostname: "a.example.com", path: "^/api", service: "api" });
    expect(result.replaced).toBe(false);
    expect(result.config.ingress!.map((r) => r.service)).toEqual(["api", "web", "http_status:404"]);
  });
  test("same hostname and path replaces", () => {
    const config = { ingress: [{ hostname: "a.example.com", path: "^/api", service: "old" }, { hostname: "a.example.com", service: "web" }, catchAll] };
    const result = upsertIngress(config, { hostname: "a.example.com", path: "^/api", service: "new" });
    expect(result.replaced).toBe(true);
    expect(result.config.ingress!.map((r) => r.service)).toEqual(["new", "web", "http_status:404"]);
  });
});

describe("removeIngress", () => {
  const config = {
    ingress: [
      { hostname: "a.example.com", path: "^/api", service: "api" },
      { hostname: "a.example.com", service: "web" },
      { hostname: "b.example.com", service: "b" },
      catchAll,
    ],
    "warp-routing": { enabled: false },
  };
  test("removes every rule for the hostname by default", () => {
    const result = removeIngress(config, "A.example.com");
    expect(result.removed.length).toBe(2);
    expect(result.config.ingress).toEqual([{ hostname: "b.example.com", service: "b" }, catchAll]);
    expect(result.config["warp-routing"]).toEqual({ enabled: false });
  });
  test("with a path removes only that key", () => {
    const result = removeIngress(config, "a.example.com", "^/api");
    expect(result.removed.map((r) => r.path)).toEqual(["^/api"]);
    expect(result.config.ingress!.length).toBe(3);
  });
  test("leaves a lone catch-all when nothing remains", () => {
    expect(removeIngress({ ingress: [{ hostname: "a.example.com", service: "x" }] }, "a.example.com").config.ingress).toEqual([catchAll]);
  });
});

describe("findHostname and addConflicts", () => {
  const entries = [
    { tunnel: { id: "1", name: "pc" }, config: { ingress: [{ hostname: "a.example.com", service: "http://localhost:1" }, catchAll] } },
    { tunnel: { id: "2", name: "nas" }, config: { ingress: [{ hostname: "b.example.com", path: "^/x", service: "x" }, catchAll] } },
    { tunnel: { id: "3", name: "local" }, config: null },
  ];
  test("finds across tunnels, case-insensitively", () => {
    expect(findHostname(entries, "B.EXAMPLE.COM").map((m) => m.tunnel.name)).toEqual(["nas"]);
    expect(findHostname(entries, "c.example.com")).toEqual([]);
  });
  test("identical rule on the target is not a conflict", () => {
    const c = addConflicts(entries, "1", { hostname: "a.example.com", service: "http://localhost:1" });
    expect(c.identical).toBe(true);
    expect(c.elsewhere).toEqual([]);
  });
  test("different service on the same key is a replacement", () => {
    const c = addConflicts(entries, "1", { hostname: "a.example.com", service: "http://localhost:2" });
    expect(c.replaces?.service).toBe("http://localhost:1");
    expect(c.identical).toBe(false);
  });
  test("a new path on the same hostname doesn't collide", () => {
    const c = addConflicts(entries, "1", { hostname: "a.example.com", path: "^/api", service: "api" });
    expect(c.replaces).toBeUndefined();
    expect(c.elsewhere).toEqual([]);
  });
  test("hostname on another tunnel is reported regardless of path", () => {
    const c = addConflicts(entries, "1", { hostname: "b.example.com", service: "y" });
    expect(c.elsewhere.map((m) => m.tunnel.name)).toEqual(["nas"]);
  });
  test("originRequest is part of identity", () => {
    const c = addConflicts(entries, "1", { hostname: "a.example.com", service: "http://localhost:1", originRequest: { noTLSVerify: true } });
    expect(c.identical).toBe(false);
  });
});

describe("updateIngress and moveHostname", () => {
  test("merges originRequest and swaps service in place", () => {
    const config = { ingress: [{ hostname: "a.example.com", service: "old", originRequest: { httpHostHeader: "h" } }, catchAll] };
    const u = updateIngress(config, "a.example.com", undefined, { service: "new", originRequest: { noTLSVerify: true } });
    expect(u.config.ingress![0]).toEqual({ hostname: "a.example.com", service: "new", originRequest: { httpHostHeader: "h", noTLSVerify: true } });
  });
  test("throws when the key isn't there", () => {
    expect(() => updateIngress({ ingress: [catchAll] }, "a.example.com", undefined, { service: "x" })).toThrow();
  });
  test("moves every rule with its options", () => {
    const from = { ingress: [{ hostname: "a.example.com", path: "^/api", service: "api" }, { hostname: "a.example.com", service: "web" }, catchAll] };
    const moved = moveHostname(from, null, "a.example.com");
    expect(moved.from.ingress).toEqual([catchAll]);
    expect(moved.to.ingress!.map((r) => r.service)).toEqual(["api", "web", "http_status:404"]);
  });
});

describe("originRequestFromFlags", () => {
  test("nothing set gives undefined", () => expect(originRequestFromFlags({})).toBeUndefined());
  test("maps every flag and only set ones", () => {
    expect(
      originRequestFromFlags({
        "no-tls-verify": true,
        "http-host-header": "app.internal",
        "origin-server-name": "origin.internal",
        "connect-timeout": "2m",
        "disable-chunked-encoding": true,
        "http2-origin": true,
      }),
    ).toEqual({
      noTLSVerify: true,
      httpHostHeader: "app.internal",
      originServerName: "origin.internal",
      connectTimeout: 120,
      disableChunkedEncoding: true,
      http2Origin: true,
    });
    expect(originRequestFromFlags({ "http-host-header": "h" })).toEqual({ httpHostHeader: "h" });
  });
  test("durations", () => {
    expect(parseDuration("30")).toBe(30);
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("1h")).toBe(3600);
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("normalizeCidr", () => {
  test.each([
    ["10.0.0.0/8", "10.0.0.0/8"],
    ["192.168.1.5", "192.168.1.5/32"],
    ["0.0.0.0/0", "0.0.0.0/0"],
    ["fd00::/8", "fd00::/8"],
    ["2001:DB8::1", "2001:db8::1/128"],
    ["::/0", "::/0"],
    ["::ffff:10.0.0.1/128", "::ffff:10.0.0.1/128"],
    ["1:2:3:4:5:6:7:8/64", "1:2:3:4:5:6:7:8/64"],
  ])("%s -> %s", (input, out) => expect(normalizeCidr(input)).toBe(out));
  test.each(["10.0.0.0/33", "256.0.0.0/8", "10.0.0/8", "01.2.3.4/32", "1::2::3", "1:2:3:4:5:6:7:8:9", "fd00::/129", "abc", "10.0.0.0/8/1", "10.0.0.0/"])(
    "rejects %s",
    (input) => expect(() => normalizeCidr(input)).toThrow(),
  );
});

describe("resolveTunnel", () => {
  const tunnels = [
    { id: "aaaa-1111", name: "nas" },
    { id: "bbbb-2222", name: "nas-backup" },
    { id: "cccc-3333", name: "Laptop" },
    { id: "dddd-4444", name: "laptop-old" },
  ];
  test("exact name wins over prefix", () => expect(resolveTunnel(tunnels, "nas").id).toBe("aaaa-1111"));
  test("full id", () => expect(resolveTunnel(tunnels, "bbbb-2222").name).toBe("nas-backup"));
  test("unique case-insensitive prefix", () => expect(resolveTunnel(tunnels, "NAS-B").name).toBe("nas-backup"));
  test("ambiguous prefix lists matches", () => expect(() => resolveTunnel(tunnels, "lap")).toThrow(/Laptop, laptop-old/));
  test("no match lists tunnels", () => expect(() => resolveTunnel(tunnels, "zzz")).toThrow(/no tunnel matches/));
});

describe("ingressDiff", () => {
  test("marks added and removed lines", () => {
    expect(ingressDiff([{ hostname: "a.x.com", service: "1" }, catchAll], [{ hostname: "b.x.com", service: "2" }, catchAll])).toEqual([
      "- a.x.com -> 1",
      "+ b.x.com -> 2",
      "  * -> http_status:404",
    ]);
  });
});

test("maskSecret never shows the middle", () => {
  expect(maskSecret("abcdefghijklmnopqrstuvwxyz0123456789")).toBe("abcd…6789");
  expect(maskSecret("short")).toBe("…");
});

test("permissionFor maps a failed route to its dashboard row", () => {
  const label = (route: string) => {
    const p = permissionFor(route);
    return p && permissionLabel(p);
  };
  expect(label("PUT /accounts/abc/cfd_tunnel/def/configurations")).toBe("Account | Cloudflare Tunnel | Edit");
  expect(label("POST /accounts/abc/teamnet/routes")).toBe("Account | Cloudflare Tunnel | Edit");
  expect(label("POST /zones/abc/dns_records")).toBe("Zone | DNS | Edit");
  expect(label("GET /zones")).toBe("Zone | DNS | Edit");
  expect(label("GET /accounts")).toBe("Account | Account Settings | Read");
  expect(label("GET /user/tokens/abc")).toBe("User | API Tokens | Read");
  expect(label("GET /user/tokens/verify")).toBeUndefined();
});

describe("evaluateChecklist", () => {
  const base: ChecklistInput = {
    token: { status: "active", expiresOn: null },
    accounts: { ok: true, value: [{ id: "abcdef0123456789", name: "Ridhwan" }] },
    tunnels: { ok: true, value: 3 },
    zones: { ok: true, value: [{ name: "untraceable.dev" }, { name: "unstack.pro" }] },
    policies: { ok: false, error: "Unauthorized" },
  };
  test("an empty account list falls back to the zones' account", () => {
    const { rows, hardFailure } = evaluateChecklist({
      ...base,
      accounts: { ok: true, value: [] },
      zones: { ok: true, value: [{ name: "untraceable.dev", account: { id: "abcdef0123456789", name: "Ridhwan" } }] },
    });
    expect(hardFailure).toBe(false);
    expect(rows[1]!.detail).toBe('account "Ridhwan" (abcd…6789), found through its zones');
  });
  test("no account anywhere names the dashboard row to add", () => {
    const { rows, notes } = evaluateChecklist({ ...base, accounts: { ok: true, value: [] }, tunnels: null });
    expect(rows[1]!.fix![0]).toBe("add  Account | Account Settings | Read");
    expect(rows[2]!.detail).toBe("needs an account first");
    expect(notes.at(-1)).toContain("https://dash.cloudflare.com/profile/api-tokens");
  });
  test("a configured account passes even when the token can't list it", () => {
    const { rows } = evaluateChecklist({ ...base, accounts: { ok: true, value: [] }, account: "0123456789abcdef" });
    expect(rows[1]!.mark).toBe("ok");
  });
  test("a long zone list is cut short", () => {
    const zones = ["a.dev", "b.dev", "c.dev", "d.dev", "e.dev"].map((name) => ({ name }));
    expect(evaluateChecklist({ ...base, zones: { ok: true, value: zones } }).rows[3]!.detail).toBe("a.dev, b.dev, c.dev +2 more");
  });
  test("all readable, write unknown without policy access", () => {
    const { rows, hardFailure } = evaluateChecklist(base);
    expect(hardFailure).toBe(false);
    expect(rows.map((r) => r.mark)).toEqual(["ok", "ok", "ok", "ok", "unknown", "unknown"]);
    expect(rows[1]!.detail).toBe('account "Ridhwan" (abcd…6789)');
  });
  test("policies upgrade write rows", () => {
    const { rows } = evaluateChecklist({
      ...base,
      policies: { ok: true, value: [{ effect: "allow", permission_groups: [{ name: "Cloudflare Tunnel Write" }, { name: "Zone Read" }] }] },
    });
    expect(rows.find((r) => r.label === "Tunnel write")!.mark).toBe("ok");
    expect(rows.find((r) => r.label === "DNS write")!.mark).toBe("fail");
    expect(rows.find((r) => r.label === "DNS write")!.fix).toEqual(["add  Zone | DNS | Edit"]);
    expect(rows.at(-1)!.label).toBe("Policies readable");
  });
  test("several accounts without a choice is a hard failure", () => {
    const result = evaluateChecklist({
      ...base,
      accounts: { ok: true, value: [{ id: "1", name: "A" }, { id: "2", name: "B" }] },
      tunnels: null,
    });
    expect(result.hardFailure).toBe(true);
    expect(result.rows[1]!.extra).toEqual(["1  A", "2  B"]);
  });
  test("no zones is a hard failure", () => {
    expect(evaluateChecklist({ ...base, zones: { ok: true, value: [] } }).hardFailure).toBe(true);
  });
});
