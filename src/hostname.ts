import type { Cloudflare, DnsInput, Tunnel, Zone } from "./cf.ts";
import type { Ctx, Planned } from "./cli.ts";
import {
  addConflicts,
  describeRule,
  findHostname,
  moveHostname,
  normalizeHostname,
  normalizeService,
  originRequestFromFlags,
  publicHostnames,
  removeIngress,
  resolveZoneCandidates,
  sameRoute,
  updateIngress,
  upsertIngress,
  type HostRule,
} from "./core.ts";
import {
  cnameTarget,
  ingressStep,
  isLocal,
  loadTunnels,
  localRefusal,
  pickTunnel,
  pointsAt,
  resolveAccount,
  resolveZone,
  type Entry,
} from "./tunnel.ts";

async function load(ctx: Ctx, host: string) {
  const cf = ctx.cf();
  const zone = resolveZone(cf, host);
  const account = await resolveAccount(cf, ctx);
  return { cf, zone, account, entries: await loadTunnels(cf, account) };
}

async function requireZone(lookup: Promise<Zone | null>, host: string): Promise<Zone> {
  const zone = await lookup;
  if (!zone) throw new Error(`no active zone for ${host} visible to this token (tried ${resolveZoneCandidates(host).join(", ")})`);
  return zone;
}

async function planDns(ctx: Ctx, cf: Cloudflare, zone: Zone, host: string, tunnel: Tunnel, movable: Tunnel[]) {
  const records = await cf.dnsRecords(zone.id, host);
  const record: DnsInput = { type: "CNAME", name: host, content: cnameTarget(tunnel), proxied: true, ttl: 1 };
  const existing = records.find((r) => pointsAt(r, tunnel));
  const others = records.filter((r) => r !== existing);
  const blocked = others.find((r) => !movable.some((t) => pointsAt(r, t)));
  if (blocked && !ctx.flags.force)
    throw new Error(`${host} already has a DNS record (${blocked.type} ${blocked.content}); use --force to overwrite it`);
  const target = `CNAME ${host} -> ${record.content}`;
  const plan: Planned[] = [];
  const replace = existing ? undefined : others.shift();
  if (existing) plan.push({ kind: "dns", action: "keep", detail: target });
  else if (replace)
    plan.push({ kind: "dns", action: "update", detail: `${target} (was ${replace.type} ${replace.content})`, run: () => cf.patchDns(zone.id, replace.id, record) });
  else plan.push({ kind: "dns", action: "create", detail: target, run: () => cf.createDns(zone.id, record) });
  for (const r of others)
    plan.push({ kind: "dns", action: "delete", detail: `${r.type} ${r.name} -> ${r.content}`, run: () => cf.deleteDns(zone.id, r.id) });
  return plan;
}

async function waitFor(host: string): Promise<{ status: number; seconds: number } | null> {
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const res = await fetch(`https://${host}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(15_000, Math.max(1_000, 60_000 - (Date.now() - start)))),
    }).catch(() => null);
    if (res) return { status: res.status, seconds: Math.round((Date.now() - start) / 1000) };
    await Bun.sleep(2_000);
  }
  return null;
}

async function finishWithWait(ctx: Ctx, host: string, summary: string): Promise<number> {
  if (!ctx.flags.wait || ctx.flags["dry-run"] || host.startsWith("*.")) {
    ctx.finish(summary);
    return 0;
  }
  if (!ctx.flags.json) ctx.ui.out(ctx.ui.dim(`waiting for https://${host}/ …`));
  const answer = await waitFor(host);
  if (answer) {
    await ctx.apply([{ kind: "wait", action: "reach", detail: `https://${host}/ (HTTP ${answer.status} after ${answer.seconds}s)` }]);
    ctx.finish(summary);
    return 0;
  }
  ctx.finish(`${summary} https://${host}/ didn't answer within 60s.`, {}, false);
  return 1;
}

function ruleFromArgs(ctx: Ctx, host: string, service: string): HostRule {
  const originRequest = originRequestFromFlags(ctx.flags);
  return { hostname: host, service, ...(ctx.flags.path && { path: ctx.flags.path }), ...(originRequest && { originRequest }) };
}

export async function ls(ctx: Ctx): Promise<number> {
  const cf = ctx.cf();
  const entries = await loadTunnels(cf, await resolveAccount(cf, ctx));
  const sorted = (e: Entry) => publicHostnames(e.config).sort((a, b) => a.hostname.localeCompare(b.hostname));
  if (ctx.flags.json) {
    ctx.ui.json(
      entries.map((e) => ({
        tunnel: e.tunnel.name,
        id: e.tunnel.id,
        status: e.tunnel.status,
        configSrc: isLocal(e.tunnel) ? "local" : "cloudflare",
        hostnames: sorted(e).map(({ hostname, service, path, originRequest }) => ({
          hostname,
          service,
          ...(path && { path }),
          ...(originRequest && { originRequest }),
        })),
      })),
    );
    return 0;
  }
  if (!entries.length) {
    ctx.ui.out("no tunnels in this account");
    return 0;
  }
  const { ui } = ctx;
  const withPath = entries.some((e) => publicHostnames(e.config).some((r) => r.path));
  const row = (cells: string[], path: string) => (withPath ? [...cells.slice(0, 3), path, ...cells.slice(3)] : cells);
  const rows = [row(["TUNNEL", "STATUS", "HOSTNAME", "SERVICE"], "PATH").map(ui.bold)];
  for (const e of entries) {
    const status = ui.status(e.tunnel.status);
    const hosts = sorted(e);
    if (isLocal(e.tunnel)) rows.push(row([e.tunnel.name, status, ui.dim("(local config)"), ""], ""));
    else if (!hosts.length) rows.push(row([e.tunnel.name, status, ui.dim("(no public hostnames)"), ""], ""));
    for (const r of hosts) rows.push(row([e.tunnel.name, status, r.hostname, r.service], r.path ?? ""));
  }
  ui.table(rows);
  return 0;
}

export async function add(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length !== 2) throw new Error("usage: cfup add <hostname> <service> (see cfup add --help)");
  const host = normalizeHostname(args[0]!);
  const rule = ruleFromArgs(ctx, host, normalizeService(args[1]!));
  const { cf, zone: zoneLookup, account, entries } = await load(ctx, host);
  const target = pickTunnel(entries, ctx);
  if (isLocal(target.tunnel)) throw localRefusal(target.tunnel);

  const { replaces, identical, elsewhere } = addConflicts(entries, target.tunnel.id, rule);
  if (!ctx.flags.force && elsewhere[0])
    throw new Error(
      `${host} already routes on tunnel "${elsewhere[0].tunnel.name}" -> ${elsewhere[0].rules.map((r) => r.service).join(", ")}; use --force or cfup mv to move it`,
    );
  if (!ctx.flags.force && replaces && !identical)
    throw new Error(`${describeRule(replaces)} already exists on "${target.tunnel.name}"; use --force or cfup set to change it`);

  const zone = await requireZone(zoneLookup, host);
  const dns = await planDns(ctx, cf, zone, host, target.tunnel, elsewhere.map((m) => m.tunnel));
  const upsert = upsertIngress(target.config, rule);
  const action = identical ? "keep" : upsert.replaced ? "replace" : "add";
  await ctx.apply([
    dns,
    [
      ingressStep(ctx, account, target, upsert.config, action, describeRule(rule)),
      ...elsewhere.map((m) => ingressStep(ctx, account, m, removeIngress(m.config, host).config, "remove", host)),
    ],
  ]);
  return finishWithWait(ctx, host, `Added ${describeRule(rule)} on "${target.tunnel.name}"; live in ~30s.`);
}

export async function set(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length < 1 || args.length > 2) throw new Error("usage: cfup set <hostname> [service] (see cfup set --help)");
  const host = normalizeHostname(args[0]!);
  const service = args[1] ? normalizeService(args[1]) : undefined;
  const originRequest = originRequestFromFlags(ctx.flags);
  if (!service && !originRequest) throw new Error("nothing to change: give a service or an origin option (see cfup set --help)");
  const path = ctx.flags.path;
  const cf = ctx.cf();
  const account = await resolveAccount(cf, ctx);
  const entries = await loadTunnels(cf, account);
  const matches = findHostname(entries, host).filter((m) => m.rules.some((r) => sameRoute(r, host, path)));
  if (!matches.length) throw new Error(`${host}${path ? ` path=${path}` : ""} isn't routed on any tunnel; cfup add creates it`);
  const plan = matches.map((m) => {
    const u = updateIngress(m.config, host, path, { service, originRequest });
    const changed = describeRule(u.before) !== describeRule(u.after);
    return ingressStep(ctx, account, m, u.config, changed ? "update" : "keep", describeRule(u.after));
  });
  await ctx.apply([plan]);
  return finishWithWait(ctx, host, `Updated ${host} on "${matches.map((m) => m.tunnel.name).join(", ")}".`);
}

export async function mv(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length !== 1 || !ctx.flags.tunnel) throw new Error("usage: cfup mv <hostname> --tunnel <name>");
  const host = normalizeHostname(args[0]!);
  const { cf, zone: zoneLookup, account, entries } = await load(ctx, host);
  const target = pickTunnel(entries, ctx);
  if (isLocal(target.tunnel)) throw localRefusal(target.tunnel);
  const sources = findHostname(entries, host).filter((m) => m.tunnel.id !== target.tunnel.id);
  if (!sources.length) {
    const here = findHostname([target], host).length > 0;
    throw new Error(here ? `${host} is already on "${target.tunnel.name}"` : `${host} isn't routed on any tunnel; cfup add creates it`);
  }

  let toConfig = target.config;
  const removals: Planned[] = [];
  for (const src of sources) {
    const moved = moveHostname(src.config, toConfig, host);
    toConfig = moved.to;
    removals.push(ingressStep(ctx, account, src, moved.from, "remove", host));
  }
  const zone = await requireZone(zoneLookup, host);
  const dns = await planDns(ctx, cf, zone, host, target.tunnel, sources.map((s) => s.tunnel));
  // New tunnel's rule goes live before DNS moves and the old rule only goes after, so traffic never hits a 404.
  await ctx.apply([ingressStep(ctx, account, target, toConfig!, "add", host), dns, removals]);
  return finishWithWait(ctx, host, `Moved ${host} from "${sources.map((s) => s.tunnel.name).join(", ")}" to "${target.tunnel.name}".`);
}

export async function rm(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length !== 1) throw new Error("usage: cfup rm <hostname> (see cfup rm --help)");
  const host = normalizeHostname(args[0]!);
  const path = ctx.flags.path;
  const { cf, zone: zoneLookup, account, entries } = await load(ctx, host);
  const matches = findHostname(entries, host).filter((m) => path === undefined || m.rules.some((r) => sameRoute(r, host, path)));
  if (!matches.length) {
    const local = entries.filter((e) => isLocal(e.tunnel)).map((e) => e.tunnel.name);
    throw new Error(
      `${host}${path ? ` path=${path}` : ""} isn't routed on any tunnel in this account` +
        (local.length ? ` (locally managed tunnels not searched: ${local.join(", ")})` : ""),
    );
  }

  const removals = matches.map((m) => ({ m, next: removeIngress(m.config, host, path) }));
  const emptied = removals.filter((r) => !findHostname([{ config: r.next.config }], host).length).map((r) => r.m.tunnel);
  const zone = await zoneLookup;
  const records = zone && emptied.length ? await cf.dnsRecords(zone.id, host) : [];
  const doomed = records.filter((r) => emptied.some((t) => pointsAt(r, t)));

  await ctx.apply([
    removals.map((r) => ingressStep(ctx, account, r.m, r.next.config, "remove", r.next.removed.map(describeRule).join(", "))),
    doomed.map((r) => ({ kind: "dns", action: "delete", detail: `CNAME ${r.name} -> ${r.content}`, run: () => cf.deleteDns(zone!.id, r.id) })),
  ]);
  if (!ctx.flags.json)
    for (const r of records.filter((r) => !doomed.includes(r)))
      ctx.ui.out(ctx.ui.dim(`left ${r.type} ${r.name} -> ${r.content} (doesn't point at the tunnel)`));
  ctx.finish(`Removed ${host}${path ? ` path=${path}` : ""} from "${matches.map((m) => m.tunnel.name).join(", ")}".`);
  return 0;
}

export async function open(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length !== 1) throw new Error("usage: cfup open <hostname>");
  const host = normalizeHostname(args[0]!);
  if (host.startsWith("*.")) throw new Error("can't open a wildcard hostname");
  const url = `https://${host}`;
  const command =
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true }).unref();
  if (ctx.flags.json) ctx.ui.json({ ok: true, url });
  else ctx.ui.out(`opened ${url}`);
  return 0;
}
