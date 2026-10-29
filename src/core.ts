export type OriginRequest = {
  noTLSVerify?: boolean;
  httpHostHeader?: string;
  originServerName?: string;
  connectTimeout?: number;
  disableChunkedEncoding?: boolean;
  http2Origin?: boolean;
  [key: string]: unknown;
};
export type IngressRule = { hostname?: string; service: string; path?: string; originRequest?: OriginRequest; [key: string]: unknown };
export type HostRule = IngressRule & { hostname: string };
export type TunnelConfig = { ingress?: IngressRule[] | null; [key: string]: unknown };

// A mistyped command: cli.ts prints the help for `command` under the message instead of pointing at --help.
export class UsageError extends Error {
  constructor(
    message: string,
    readonly command: string[],
  ) {
    super(message);
  }
}

export const wrongArgs = (command: string[], args: string[]) =>
  new UsageError(
    `wrong arguments for "${command.join(" ")}": got ${args.length ? args.map((a) => `"${a}"`).join(" ") : "none"}`,
    command,
  );

export type Probe<T> ={ ok: true; value: T } | { ok: false; error: string };
export type Mark = "ok" | "fail" | "unknown";
export type CheckRow = { mark: Mark; label: string; detail: string; source: string; extra?: string[]; fix?: string[] };

// Spelled exactly as the three dropdowns of a permission row in the dashboard's API token editor.
export type Permission = { scope: "Account" | "Zone" | "User"; group: string; level: "Read" | "Edit" };
export const PERMISSIONS = {
  tunnel: { scope: "Account", group: "Cloudflare Tunnel", level: "Edit" },
  dns: { scope: "Zone", group: "DNS", level: "Edit" },
  accounts: { scope: "Account", group: "Account Settings", level: "Read" },
  tokens: { scope: "User", group: "API Tokens", level: "Read" },
} as const satisfies Record<string, Permission>;
export const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

export const permissionLabel = (p: Permission) => `${p.scope} | ${p.group} | ${p.level}`;

const recipe: [Permission, string][] = [
  [PERMISSIONS.tunnel, ""],
  [PERMISSIONS.dns, ""],
  [PERMISSIONS.accounts, "lets cfup find your account"],
  [PERMISSIONS.tokens, "optional: lets cfup check the rows above"],
];
const recipeWidth = Math.max(...recipe.map(([p]) => permissionLabel(p).length));
export const TOKEN_RECIPE = [
  ...recipe.map(([p, why]) => `  ${permissionLabel(p).padEnd(recipeWidth)}${why ? `  (${why})` : ""}`.trimEnd()),
  "then Zone Resources → Include → Specific zone (or All zones).",
];

// The permission a failed call most likely lacked, keyed off the route cf.ts reports ("GET /zones/{id}/dns_records").
export function permissionFor(route: string): Permission | undefined {
  if (/\/(cfd_tunnel|teamnet)\b/.test(route)) return PERMISSIONS.tunnel;
  if (/\/(zones|dns_records)\b/.test(route)) return PERMISSIONS.dns;
  if (/ \/accounts$/.test(route)) return PERMISSIONS.accounts;
  if (/\/user\/tokens\/(?!verify)/.test(route)) return PERMISSIONS.tokens;
  return undefined;
}

export function missingPermissionHint(route: string): string[] {
  const p = permissionFor(route);
  if (!p) return [`check the token's permissions at ${TOKENS_URL}`];
  const resources = { Account: ["Account Resources must include the account."], Zone: ["Zone Resources must include the zone."], User: [] }[p.scope];
  return [`the token needs this Permissions row:  ${permissionLabel(p)}`, ...resources, `edit it at ${TOKENS_URL}`];
}

type ZoneAccount = { account?: { id: string; name: string } };

// GET /accounts can come back empty for a token that still works on its account, and every zone names its account.
export function visibleAccounts(
  accounts: Probe<{ id: string; name: string }[]>,
  zones: Probe<ZoneAccount[]>,
): { list: { id: string; name: string }[]; viaZones: boolean } {
  if (accounts.ok && accounts.value.length) return { list: accounts.value, viaZones: false };
  const seen = new Map<string, { id: string; name: string }>();
  if (zones.ok) for (const z of zones.value) if (z.account?.id) seen.set(z.account.id, z.account);
  return { list: [...seen.values()], viaZones: seen.size > 0 };
}

const CATCH_ALL: IngressRule = { service: "http_status:404" };
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const OPAQUE_SERVICE = /^(unix(\+tls)?:|http_status:|hello_world$|bastion$)/i;

export function normalizeService(input: string): string {
  const s = input.trim();
  if (SCHEME.test(s) || OPAQUE_SERVICE.test(s)) return s;
  if (/^\d+$/.test(s)) return `http://localhost:${port(s, input)}`;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+):(\d+)$/i.exec(s);
  if (m) return `http://${m[1]}:${port(m[2]!, input)}`;
  throw new Error(`can't read service "${input}": use a port (3010), host:port, or a URL like http://localhost:3010`);
}

function port(digits: string, input: string): number {
  const n = Number(digits);
  if (n < 1 || n > 65535) throw new Error(`port out of range in "${input}"`);
  return n;
}

export function normalizeHostname(input: string): string {
  const h = input.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(\*\.)?([a-z0-9_]([a-z0-9_-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/.test(h)) throw new Error(`"${input}" is not a hostname`);
  return h;
}

export function resolveZoneCandidates(hostname: string): string[] {
  const labels = normalizeHostname(hostname).split(".");
  const out: string[] = [];
  for (let i = labels[0] === "*" ? 1 : 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

export function parseDuration(input: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(input.trim());
  if (!m) throw new Error(`can't read duration "${input}": use seconds, 30s, 2m, or 1h`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[(m[2] ?? "s") as "s" | "m" | "h"];
}

export type OriginFlags = {
  "no-tls-verify"?: boolean;
  "http-host-header"?: string;
  "origin-server-name"?: string;
  "connect-timeout"?: string;
  "disable-chunked-encoding"?: boolean;
  "http2-origin"?: boolean;
};

export function originRequestFromFlags(flags: OriginFlags): OriginRequest | undefined {
  const origin: OriginRequest = {};
  if (flags["no-tls-verify"]) origin.noTLSVerify = true;
  if (flags["http-host-header"]) origin.httpHostHeader = flags["http-host-header"];
  if (flags["origin-server-name"]) origin.originServerName = flags["origin-server-name"];
  if (flags["connect-timeout"]) origin.connectTimeout = parseDuration(flags["connect-timeout"]);
  if (flags["disable-chunked-encoding"]) origin.disableChunkedEncoding = true;
  if (flags["http2-origin"]) origin.http2Origin = true;
  return Object.keys(origin).length ? origin : undefined;
}

export function normalizeCidr(input: string): string {
  const [addr = "", prefix, ...rest] = input.trim().toLowerCase().split("/");
  const v4 = isIpv4(addr);
  if (rest.length || (!v4 && !isIpv6(addr))) throw new Error(`"${input}" is not an IPv4 or IPv6 CIDR`);
  const max = v4 ? 32 : 128;
  if (prefix === undefined) return `${addr}/${max}`;
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) throw new Error(`prefix length in "${input}" must be 0-${max}`);
  return `${addr}/${Number(prefix)}`;
}

function isIpv4(s: string): boolean {
  const octets = s.split(".");
  return octets.length === 4 && octets.every((o) => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255);
}

function isIpv6(s: string): boolean {
  if (s.includes(".")) {
    const tail = s.lastIndexOf(":");
    if (tail < 0 || !isIpv4(s.slice(tail + 1))) return false;
    s = `${s.slice(0, tail + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h ? h.split(":") : []));
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

export function resolveTunnel<T extends { id: string; name: string }>(tunnels: T[], query: string): T {
  const exact = tunnels.find((t) => t.name === query) ?? tunnels.find((t) => t.id === query);
  if (exact) return exact;
  const prefixed = tunnels.filter((t) => t.name.toLowerCase().startsWith(query.toLowerCase()));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) throw new Error(`"${query}" matches several tunnels: ${prefixed.map((t) => t.name).join(", ")}`);
  throw new Error(`no tunnel matches "${query}"; tunnels: ${tunnels.map((t) => t.name).join(", ") || "none"}`);
}

const sameHost = (rule: IngressRule, host: string) => rule.hostname?.toLowerCase() === host.toLowerCase();

export const sameRoute = (rule: IngressRule, host: string, path?: string) =>
  sameHost(rule, host) && (rule.path ?? "") === (path ?? "");

// Cloudflare rejects a config whose last ingress rule has a hostname: the final rule must catch everything.
function withCatchAll(rules: IngressRule[]): IngressRule[] {
  const last = rules.at(-1);
  return last && !last.hostname ? rules : [...rules, CATCH_ALL];
}

export function upsertIngress(config: TunnelConfig | null | undefined, rule: HostRule) {
  const rules = config?.ingress ?? [];
  const index = rules.findIndex((r) => sameRoute(r, rule.hostname, rule.path));
  if (index >= 0) return { config: { ...config, ingress: withCatchAll(rules.with(index, rule)) } as TunnelConfig, replaced: true };
  // Rules match first-wins, so a path rule placed after its hostname's path-less rule would never be reached.
  const shadow = rule.path ? rules.findIndex((r) => sameHost(r, rule.hostname) && !r.path) : -1;
  const last = rules.at(-1);
  const at = shadow >= 0 ? shadow : last && !last.hostname ? rules.length - 1 : rules.length;
  const next = [...rules.slice(0, at), rule, ...rules.slice(at)];
  return { config: { ...config, ingress: withCatchAll(next) } as TunnelConfig, replaced: false };
}

export function removeIngress(config: TunnelConfig | null | undefined, hostname: string, path?: string) {
  const rules = config?.ingress ?? [];
  const hit = (r: IngressRule) => (path === undefined ? sameHost(r, hostname) : sameRoute(r, hostname, path));
  return {
    config: { ...config, ingress: withCatchAll(rules.filter((r) => !hit(r))) } as TunnelConfig,
    removed: rules.filter(hit) as HostRule[],
  };
}

export function updateIngress(
  config: TunnelConfig | null | undefined,
  hostname: string,
  path: string | undefined,
  patch: { service?: string; originRequest?: OriginRequest },
) {
  const rules = config?.ingress ?? [];
  const index = rules.findIndex((r) => sameRoute(r, hostname, path));
  if (index < 0) throw new Error(`${hostname}${path ? ` path=${path}` : ""} isn't routed on this tunnel`);
  const before = rules[index]!;
  const after: IngressRule = {
    ...before,
    ...(patch.service && { service: patch.service }),
    ...(patch.originRequest && { originRequest: { ...before.originRequest, ...patch.originRequest } }),
  };
  return { config: { ...config, ingress: rules.with(index, after) } as TunnelConfig, before, after };
}

export function moveHostname(from: TunnelConfig | null, to: TunnelConfig | null, hostname: string) {
  const { config: fromNext, removed } = removeIngress(from, hostname);
  let toNext: TunnelConfig = { ...to, ingress: to?.ingress ?? [] };
  for (const rule of removed) toNext = upsertIngress(toNext, rule).config;
  return { from: fromNext, to: toNext, moved: removed };
}

export function publicHostnames(config: TunnelConfig | null | undefined): HostRule[] {
  return (config?.ingress ?? []).filter((r): r is HostRule => !!r.hostname);
}

export function findHostname<E extends { config: TunnelConfig | null }>(entries: E[], hostname: string) {
  return entries.flatMap((entry) => {
    const rules = (entry.config?.ingress ?? []).filter((r) => sameHost(r, hostname)) as HostRule[];
    return rules.length ? [{ ...entry, rules }] : [];
  });
}

const canonical = (rule: IngressRule) =>
  JSON.stringify([rule.service, rule.path ?? "", rule.originRequest ?? {}], (_, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v,
  );

export function addConflicts<E extends { tunnel: { id: string }; config: TunnelConfig | null }>(
  entries: E[],
  targetId: string,
  rule: HostRule,
) {
  const matches = findHostname(entries, rule.hostname);
  const replaces = matches.find((m) => m.tunnel.id === targetId)?.rules.find((r) => sameRoute(r, rule.hostname, rule.path));
  return {
    replaces,
    identical: !!replaces && canonical(replaces) === canonical(rule),
    elsewhere: matches.filter((m) => m.tunnel.id !== targetId),
  };
}

export function describeRule(rule: IngressRule): string {
  const target = rule.hostname ? `${rule.hostname}${rule.path ? ` path=${rule.path}` : ""}` : "*";
  const origin = rule.originRequest && Object.keys(rule.originRequest).length ? ` ${JSON.stringify(rule.originRequest)}` : "";
  return `${target} -> ${rule.service}${origin}`;
}

export function ingressDiff(before: IngressRule[] | null | undefined, after: IngressRule[] | null | undefined): string[] {
  const a = (before ?? []).map(describeRule);
  const b = (after ?? []).map(describeRule);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i++]}`);
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  return out;
}

export function maskSecret(value: string): string {
  return value.length < 12 ? "…" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function pastTense(verb: string): string {
  return verb.endsWith("e") ? `${verb}d` : `${verb}ed`;
}


export type ChecklistInput = {
  token: { status: string; expiresOn?: string | null };
  accounts: Probe<{ id: string; name: string }[]>;
  account?: string;
  tunnels: Probe<number> | null;
  zones: Probe<({ name: string } & ZoneAccount)[]>;
  policies: Probe<{ effect: string; permission_groups: { name: string }[] }[]>;
};

const TUNNEL_WRITE = /tunnel (write|edit)$/i;
const DNS_WRITE = /^dns (write|edit)$/i;
const ZONES_SHOWN = 3;

const addRow = (p: Permission) => `add  ${permissionLabel(p)}`;

export function evaluateChecklist(input: ChecklistInput): { rows: CheckRow[]; hardFailure: boolean; notes: string[] } {
  const { token, accounts, tunnels, zones, policies } = input;
  const valid: CheckRow = {
    mark: token.status === "active" ? "ok" : "fail",
    label: `valid (status: ${token.status}, expires: ${token.expiresOn ? token.expiresOn.slice(0, 10) : "never"})`,
    detail: "",
    source: "",
  };

  const visible = visibleAccounts(accounts, zones);
  const account: CheckRow = { mark: "fail", label: "Account read", detail: "", source: "GET /accounts" };
  const chosen = visible.list.find((a) => a.id === input.account) ?? (visible.list.length === 1 ? visible.list[0] : undefined);
  if (chosen) {
    account.mark = "ok";
    account.detail = `account "${chosen.name}" (${maskSecret(chosen.id)})${visible.viaZones ? ", found through its zones" : ""}`;
  } else if (input.account) {
    account.mark = "ok";
    account.detail = `account ${maskSecret(input.account)} (from your settings)`;
  } else if (visible.list.length) {
    account.detail = `${visible.list.length} accounts`;
    account.extra = visible.list.map((a) => `${a.id}  ${a.name}`);
    account.fix = ["pick one: cfup config set account <id>"];
  } else {
    account.detail = accounts.ok ? "no accounts visible" : accounts.error;
    account.fix = [
      addRow(PERMISSIONS.accounts),
      "or skip the lookup: cfup config set account <id>",
      "(the id is the 32-character part of the dashboard URL after dash.cloudflare.com/)",
    ];
  }

  const tunnel: CheckRow = { mark: "fail", label: "Tunnel read", detail: "", source: "GET /accounts/{id}/cfd_tunnel" };
  if (!tunnels) tunnel.detail = "needs an account first";
  else if (!tunnels.ok) {
    tunnel.detail = tunnels.error;
    tunnel.fix = [addRow(PERMISSIONS.tunnel), "and make sure Account Resources includes this account"];
  } else {
    tunnel.mark = "ok";
    tunnel.detail = `${tunnels.value} tunnel${tunnels.value === 1 ? "" : "s"}`;
  }

  const zone: CheckRow = { mark: "fail", label: "Zone read", detail: "", source: "GET /zones" };
  if (zones.ok && zones.value.length) {
    zone.mark = "ok";
    const more = zones.value.length - ZONES_SHOWN;
    zone.detail = zones.value.slice(0, ZONES_SHOWN).map((z) => z.name).join(", ") + (more > 0 ? ` +${more} more` : "");
  } else {
    zone.detail = zones.ok ? "no zones visible" : zones.error;
    zone.fix = [addRow(PERMISSIONS.dns), "with Zone Resources → Include → the zones you'll route"];
  }

  const tunnelWrite: CheckRow = {
    mark: "unknown",
    label: "Tunnel write",
    detail: `needs ${permissionLabel(PERMISSIONS.tunnel)}`,
    source: "PUT /accounts/{id}/cfd_tunnel/{id}/configurations",
  };
  const dnsWrite: CheckRow = {
    mark: "unknown",
    label: "DNS write",
    detail: `needs ${permissionLabel(PERMISSIONS.dns)}`,
    source: "POST /zones/{id}/dns_records",
  };
  const rows = [valid, account, tunnel, zone, tunnelWrite, dnsWrite];
  const notes: string[] = [];

  if (policies.ok) {
    const granted = policies.value
      .filter((p) => p.effect === "allow")
      .flatMap((p) => p.permission_groups.map((g) => g.name));
    const tunnelGrant = granted.find((n) => TUNNEL_WRITE.test(n));
    const dnsGrant = granted.find((n) => DNS_WRITE.test(n));
    for (const [row, grant, permission] of [
      [tunnelWrite, tunnelGrant, PERMISSIONS.tunnel],
      [dnsWrite, dnsGrant, PERMISSIONS.dns],
    ] as const) {
      row.mark = grant ? "ok" : "fail";
      row.detail = grant ? `granted (${grant})` : "missing from the token";
      if (!grant) row.fix = [addRow(permission)];
    }
    rows.push({
      mark: "ok",
      label: "Policies readable",
      detail: [tunnelGrant, dnsGrant].filter(Boolean).join(", ") || "no Tunnel or DNS edit grants",
      source: "GET /user/tokens/{id}",
    });
  } else notes.push(`? rows: cfup can't read the token's own permissions; add ${permissionLabel(PERMISSIONS.tokens)} to check them here`);

  if (rows.some((r) => r.fix))
    notes.push(`Fix at ${TOKENS_URL} → your token → Edit. Each "add" line is one Permissions row: type | permission | level.`);
  return { rows, hardFailure: [account, tunnel, zone].some((r) => r.mark === "fail"), notes };
}
