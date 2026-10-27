import type { Cloudflare, DnsRecord, Route, Tunnel, Zone } from "./cf.ts";
import type { Ctx, Planned } from "./cli.ts";
import { configPath, readConfig, writeConfig } from "./config.ts";
import {
  ingressDiff,
  maskSecret,
  publicHostnames,
  removeIngress,
  resolveTunnel,
  resolveZoneCandidates,
  type TunnelConfig,
} from "./core.ts";

export type Entry = { tunnel: Tunnel; config: TunnelConfig | null };

export const isLocal = (t: Tunnel) => (t.config_src ? t.config_src === "local" : t.remote_config === false);
export const cnameTarget = (t: Tunnel) => `${t.id}.cfargotunnel.com`;
export const pointsAt = (r: DnsRecord, t: Tunnel) => r.type === "CNAME" && r.content.toLowerCase() === cnameTarget(t);

export async function resolveAccount(cf: Cloudflare, ctx: Ctx): Promise<string> {
  if (ctx.settings.account) return ctx.settings.account.value;
  const accounts = await cf.accounts();
  if (accounts.length === 1) return accounts[0]!.id;
  if (!accounts.length) throw new Error("this token can't see any account (needs Account → Cloudflare Tunnel: Edit)");
  throw new Error(
    `this token sees ${accounts.length} accounts; pick one with --account, CFT_ACCOUNT, or \`cft config set account <id>\`:\n` +
      accounts.map((a) => `${a.id}  ${a.name}`).join("\n"),
  );
}

export async function loadTunnels(cf: Cloudflare, account: string): Promise<Entry[]> {
  const tunnels = await cf.tunnels(account);
  const entries = await Promise.all(
    tunnels.map(async (tunnel) => ({ tunnel, config: isLocal(tunnel) ? null : await cf.tunnelConfig(account, tunnel.id) })),
  );
  return entries.sort((a, b) => a.tunnel.name.localeCompare(b.tunnel.name));
}

export function pickTunnel<E extends { tunnel: Tunnel }>(entries: E[], ctx: Ctx): E {
  const want = ctx.settings.tunnel;
  if (want) {
    const tunnel = resolveTunnel(
      entries.map((e) => e.tunnel),
      want.value,
    );
    return entries.find((e) => e.tunnel === tunnel)!;
  }
  if (entries.length === 1) return entries[0]!;
  if (!entries.length) throw new Error("this account has no tunnels; create one with `cft tunnel create <name>`");
  throw new Error(
    "several tunnels; pick one with --tunnel <name> or `cft config set tunnel <name>`:\n" +
      entries.map((e) => `${e.tunnel.name}  ${e.tunnel.status}`).join("\n"),
  );
}

export function localRefusal(t: Tunnel): Error {
  return new Error(`tunnel "${t.name}" is locally managed: its ingress lives in that machine's config.yml and cft can't edit it`);
}

export function resolveZone(cf: Cloudflare, hostname: string): Promise<Zone | null> {
  const lookup = Promise.all(resolveZoneCandidates(hostname).map((name) => cf.zones(name))).then(
    (found) => found.find((z) => z.length)?.[0] ?? null,
  );
  // Started early to overlap the tunnel fetches; the no-op catch keeps an earlier, unrelated failure from
  // surfacing as an unhandled rejection. Awaiting it later still throws.
  lookup.catch(() => {});
  return lookup;
}

export function ingressStep(ctx: Ctx, account: string, entry: Entry, next: TunnelConfig, action: string, what: string): Planned {
  const cf = ctx.cf();
  return {
    kind: "ingress",
    action,
    detail: `${entry.tunnel.name}: ${what}`,
    diff: ingressDiff(entry.config?.ingress, next.ingress),
    run: action === "keep" ? undefined : () => cf.putTunnelConfig(account, entry.tunnel.id, next),
  };
}

function installCommand(ctx: Ctx, token: string) {
  const shown = ctx.flags["show-token"] ? token : maskSecret(token);
  return { token: shown, install: `cloudflared service install ${shown}` };
}

function printInstall(ctx: Ctx, id: string, install: string) {
  if (ctx.flags.json) return;
  ctx.ui.table([
    ["id", id],
    ["install", install],
  ]);
  if (!ctx.flags["show-token"]) ctx.ui.out(ctx.ui.dim("token masked; --show-token prints it in full"));
}

async function list(ctx: Ctx) {
  const cf = ctx.cf();
  const tunnels = (await cf.tunnels(await resolveAccount(cf, ctx))).sort((a, b) => a.name.localeCompare(b.name));
  const rows = tunnels.map((t) => ({
    name: t.name,
    id: t.id,
    status: t.status,
    config: isLocal(t) ? "local" : "cloudflare",
    connections: t.connections?.length ?? 0,
    created: t.created_at ?? null,
  }));
  if (ctx.flags.json) return ctx.ui.json(rows);
  if (!rows.length) return ctx.ui.out("no tunnels in this account");
  const { ui } = ctx;
  ui.table([
    ["NAME", "ID", "STATUS", "CONFIG", "CONNECTIONS", "CREATED"].map(ui.bold),
    ...rows.map((r) => [r.name, r.id, ui.status(r.status), r.config, String(r.connections), r.created?.slice(0, 10) ?? ""]),
  ]);
}

async function create(ctx: Ctx, name: string) {
  const cf = ctx.cf();
  const account = await resolveAccount(cf, ctx);
  if ((await cf.tunnels(account)).some((t) => t.name === name)) throw new Error(`a tunnel named "${name}" already exists`);
  let created: Tunnel | undefined;
  await ctx.apply([
    { kind: "tunnel", action: "create", detail: `"${name}" (remotely managed)`, run: async () => (created = await cf.createTunnel(account, name)) },
  ]);
  if (!created) return ctx.finish("");
  const shown = installCommand(ctx, await cf.tunnelToken(account, created.id));
  printInstall(ctx, created.id, shown.install);
  ctx.finish(`Created tunnel "${name}"; run the install command on the machine it should serve.`, { id: created.id, ...shown });
}

async function token(ctx: Ctx, name: string) {
  const cf = ctx.cf();
  const account = await resolveAccount(cf, ctx);
  const tunnel = resolveTunnel(await cf.tunnels(account), name);
  const shown = installCommand(ctx, await cf.tunnelToken(account, tunnel.id));
  if (ctx.flags.json) ctx.ui.json({ tunnel: tunnel.name, id: tunnel.id, ...shown });
  else printInstall(ctx, tunnel.id, shown.install);
}

async function rename(ctx: Ctx, from: string, to: string) {
  const cf = ctx.cf();
  const account = await resolveAccount(cf, ctx);
  const tunnels = await cf.tunnels(account);
  const tunnel = resolveTunnel(tunnels, from);
  if (tunnels.some((t) => t.name === to)) throw new Error(`a tunnel named "${to}" already exists`);
  const path = configPath();
  const config = readConfig(path);
  const plan: Planned[] = [
    { kind: "tunnel", action: "rename", detail: `"${tunnel.name}" to "${to}"`, run: () => cf.renameTunnel(account, tunnel.id, to) },
  ];
  if (config.tunnel === tunnel.name)
    plan.push({ kind: "config", action: "update", detail: `default tunnel to "${to}"`, run: async () => writeConfig({ ...config, tunnel: to }, path) });
  await ctx.apply(plan);
  ctx.finish(`Renamed tunnel "${tunnel.name}" to "${to}".`);
}

async function remove(ctx: Ctx, name: string) {
  const cf = ctx.cf();
  const account = await resolveAccount(cf, ctx);
  const [entries, routes] = await Promise.all([loadTunnels(cf, account), cf.routes(account)]);
  const { tunnel, config } = entries.find((e) => e.tunnel === resolveTunnel(entries.map((x) => x.tunnel), name))!;
  const hosts = [...new Set(publicHostnames(config).map((r) => r.hostname.toLowerCase()))];
  const owned = routes.filter((r: Route) => r.tunnel_id === tunnel.id);
  const force = !!ctx.flags.force;
  if ((hosts.length || owned.length) && !force)
    throw new Error(
      `tunnel "${tunnel.name}" still has ${hosts.length} public hostname(s) and ${owned.length} private route(s); --force removes them and the tunnel`,
    );

  const cnames = (
    await Promise.all(
      hosts.map(async (host) => {
        const zone = await resolveZone(cf, host);
        const records = zone ? await cf.dnsRecords(zone.id, host) : [];
        return records.filter((r) => pointsAt(r, tunnel)).map((r) => ({ zone: zone!, record: r }));
      }),
    )
  ).flat();

  let next: TunnelConfig = { ...config };
  for (const host of hosts) next = removeIngress(next, host).config;
  const plan: (Planned | Planned[])[] = [];
  if (hosts.length) plan.push(ingressStep(ctx, account, { tunnel, config }, next, "remove", `${hosts.length} public hostname(s)`));
  plan.push(
    cnames.map(({ zone, record }) => ({
      kind: "dns",
      action: "delete",
      detail: `CNAME ${record.name} -> ${record.content}`,
      run: () => cf.deleteDns(zone.id, record.id),
    })),
  );
  plan.push(
    owned.map((r) => ({ kind: "route", action: "delete", detail: r.network, run: () => cf.deleteRoute(account, r.id) })),
  );
  plan.push({
    kind: "tunnel",
    action: "delete",
    detail: `"${tunnel.name}" (${tunnel.id})${force ? " with cascade" : ""}`,
    run: () => cf.deleteTunnel(account, tunnel.id, force),
  });
  const path = configPath();
  const saved = readConfig(path);
  if (saved.tunnel === tunnel.name) {
    const { tunnel: _, ...rest } = saved;
    plan.push({ kind: "config", action: "remove", detail: "default tunnel", run: async () => writeConfig(rest, path) });
  }
  await ctx.apply(plan);
  if (isLocal(tunnel) && !ctx.flags.json)
    ctx.ui.out(ctx.ui.yellow("note: locally managed tunnel; CNAMEs pointing at it weren't searched"));
  ctx.finish(`Deleted tunnel "${tunnel.name}".`);
}

export async function tunnelCommand(ctx: Ctx, sub: string, args: string[]): Promise<number> {
  const arity: Record<string, number> = { ls: 0, create: 1, token: 1, rm: 1, rename: 2 };
  if (args.length !== arity[sub]) throw new Error(`wrong arguments (see cft tunnel ${sub} --help)`);
  if (sub === "ls") await list(ctx);
  if (sub === "create") await create(ctx, args[0]!.trim());
  if (sub === "token") await token(ctx, args[0]!);
  if (sub === "rename") await rename(ctx, args[0]!, args[1]!.trim());
  if (sub === "rm") await remove(ctx, args[0]!);
  return 0;
}
