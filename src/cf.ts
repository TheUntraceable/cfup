import type { Probe, TunnelConfig } from "./core.ts";

const BASE = "https://api.cloudflare.com/client/v4";

export class CfError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    readonly apiMessage: string,
  ) {
    super(`${route}: ${apiMessage}`);
  }
}

export const probe = <T>(p: Promise<T>): Promise<Probe<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (err) => ({ ok: false as const, error: err instanceof CfError ? err.apiMessage : String(err) }),
  );

export type Account = { id: string; name: string };
export type Tunnel = {
  id: string;
  name: string;
  status: string;
  config_src?: "cloudflare" | "local";
  remote_config?: boolean;
  connections?: unknown[];
  created_at?: string;
};
export type Route = { id: string; network: string; tunnel_id: string; tunnel_name?: string; comment?: string };
export type Zone = { id: string; name: string; account?: Account };
export type DnsRecord = { id: string; type: string; name: string; content: string };
export type TokenInfo = { id: string; status: string; expires_on?: string | null };
export type TokenPolicy = { effect: string; permission_groups: { id: string; name: string }[] };
export type DnsInput = { type: "CNAME"; name: string; content: string; proxied: true; ttl: 1 };

type Envelope<T> = { success: boolean; errors?: { code: number; message: string }[]; result: T };

export function cloudflare(token: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const route = `${method} ${path.split("?")[0]}`;
    let res: Response;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      const e = err as Error;
      throw new CfError(route, 0, e.name === "TimeoutError" ? "timed out after 15s" : `network error: ${e.message}`);
    }
    const envelope = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !envelope?.success) {
      const message = envelope?.errors?.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${res.status}`;
      throw new CfError(route, res.status, message);
    }
    return envelope.result;
  }

  const q = encodeURIComponent;
  const tunnelPath = (account: string, id: string) => `/accounts/${account}/cfd_tunnel/${id}/configurations`;

  return {
    verifyToken: () => call<TokenInfo>("GET", "/user/tokens/verify"),
    tokenPolicies: (id: string) =>
      call<{ policies?: TokenPolicy[] }>("GET", `/user/tokens/${id}`).then((t) => t.policies ?? []),
    accounts: () => call<Account[]>("GET", "/accounts?per_page=50"),
    tunnels: (account: string) => call<Tunnel[]>("GET", `/accounts/${account}/cfd_tunnel?is_deleted=false&per_page=100`),
    tunnelConfig: (account: string, id: string) =>
      call<{ config?: TunnelConfig | null } | null>("GET", tunnelPath(account, id)).then(
        (r) => r?.config ?? null,
        (err) => {
          if (err instanceof CfError && err.status === 404) return null;
          throw err;
        },
      ),
    putTunnelConfig: (account: string, id: string, config: TunnelConfig) =>
      call<unknown>("PUT", tunnelPath(account, id), { config }),
    createTunnel: (account: string, name: string) =>
      call<Tunnel>("POST", `/accounts/${account}/cfd_tunnel`, { name, config_src: "cloudflare" }),
    tunnelToken: (account: string, id: string) => call<string>("GET", `/accounts/${account}/cfd_tunnel/${id}/token`),
    renameTunnel: (account: string, id: string, name: string) =>
      call<Tunnel>("PATCH", `/accounts/${account}/cfd_tunnel/${id}`, { name }),
    deleteTunnel: (account: string, id: string, cascade: boolean) =>
      call<unknown>("DELETE", `/accounts/${account}/cfd_tunnel/${id}${cascade ? "?cascade=true" : ""}`),
    routes: (account: string) => call<Route[]>("GET", `/accounts/${account}/teamnet/routes?is_deleted=false&per_page=1000`),
    createRoute: (account: string, route: { network: string; tunnel_id: string; comment?: string }) =>
      call<Route>("POST", `/accounts/${account}/teamnet/routes`, route),
    deleteRoute: (account: string, id: string) => call<unknown>("DELETE", `/accounts/${account}/teamnet/routes/${id}`),
    zones: (name?: string) =>
      call<Zone[]>("GET", name ? `/zones?name=${q(name)}&status=active` : "/zones?status=active&per_page=50"),
    dnsRecords: (zone: string, name: string) => call<DnsRecord[]>("GET", `/zones/${zone}/dns_records?name=${q(name)}`),
    createDns: (zone: string, record: DnsInput) => call<DnsRecord>("POST", `/zones/${zone}/dns_records`, record),
    patchDns: (zone: string, id: string, record: DnsInput) =>
      call<DnsRecord>("PATCH", `/zones/${zone}/dns_records/${id}`, record),
    deleteDns: (zone: string, id: string) => call<unknown>("DELETE", `/zones/${zone}/dns_records/${id}`),
  };
}

export type Cloudflare = ReturnType<typeof cloudflare>;
