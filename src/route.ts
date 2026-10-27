import type { Ctx } from "./cli.ts";
import { normalizeCidr } from "./core.ts";
import { pickTunnel, resolveAccount } from "./tunnel.ts";

export async function routeCommand(ctx: Ctx, sub: string, args: string[]): Promise<number> {
  const arity: Record<string, number> = { ls: 0, add: 1, rm: 1 };
  if (args.length !== arity[sub]) throw new Error(`wrong arguments (see cft route ${sub} --help)`);
  const network = sub === "ls" ? "" : normalizeCidr(args[0]!);
  const cf = ctx.cf();
  const account = await resolveAccount(cf, ctx);
  const [tunnels, routes] = await Promise.all([cf.tunnels(account), cf.routes(account)]);
  const tunnelName = (id: string) => tunnels.find((t) => t.id === id)?.name ?? id;
  const existing = routes.find((r) => r.network.toLowerCase() === network);

  if (sub === "ls") {
    const rows = routes
      .map((r) => ({ network: r.network, tunnel: tunnelName(r.tunnel_id), tunnelId: r.tunnel_id, comment: r.comment ?? "" }))
      .sort((a, b) => a.tunnel.localeCompare(b.tunnel) || a.network.localeCompare(b.network));
    if (ctx.flags.json) ctx.ui.json(rows);
    else if (!rows.length) ctx.ui.out("no private network routes in this account");
    else ctx.ui.table([["NETWORK", "TUNNEL", "COMMENT"].map(ctx.ui.bold), ...rows.map((r) => [r.network, r.tunnel, r.comment])]);
    return 0;
  }

  if (sub === "add") {
    if (existing) throw new Error(`${network} is already routed through tunnel "${tunnelName(existing.tunnel_id)}"`);
    const { tunnel } = pickTunnel(
      tunnels.map((t) => ({ tunnel: t })),
      ctx,
    );
    const comment = ctx.flags.comment;
    await ctx.apply([
      {
        kind: "route",
        action: "create",
        detail: `${network} via "${tunnel.name}"${comment ? ` (${comment})` : ""}`,
        run: () => cf.createRoute(account, { network, tunnel_id: tunnel.id, ...(comment && { comment }) }),
      },
    ]);
    ctx.finish(`Routed ${network} through tunnel "${tunnel.name}".`);
    return 0;
  }

  if (!existing) throw new Error(`no private route for ${network}`);
  await ctx.apply([
    {
      kind: "route",
      action: "delete",
      detail: `${network} via "${tunnelName(existing.tunnel_id)}"`,
      run: () => cf.deleteRoute(account, existing.id),
    },
  ]);
  ctx.finish(`Removed the route for ${network}.`);
  return 0;
}
