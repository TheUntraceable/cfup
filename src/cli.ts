#!/usr/bin/env bun
import { version } from "../package.json";
import { CfError, cloudflare, type Cloudflare, type TokenInfo } from "./cf.ts";
import {
  COMMANDS,
  FLAG_SPECS,
  commandHelp,
  completionScript,
  findCommand,
  rootHelp,
  type CommandSpec,
  type Flags,
} from "./completions.ts";
import { CONFIG_KEYS, configPath, readConfig, resolveSettings, writeConfig, type ConfigKey, type Settings } from "./config.ts";
import { evaluateChecklist, maskSecret, pastTense, type CheckRow, type Probe } from "./core.ts";
import * as hostname from "./hostname.ts";
import { routeCommand } from "./route.ts";
import { tunnelCommand } from "./tunnel.ts";

export type Step = { kind: string; action: string; detail: string; diff?: string[] };
export type Planned = Step & { run?: () => Promise<unknown> };

export type Ui = ReturnType<typeof makeUi>;
export type Ctx = {
  flags: Flags;
  settings: Settings;
  ui: Ui;
  cf(): Cloudflare;
  apply(batches: (Planned | Planned[])[]): Promise<void>;
  finish(summary: string, extra?: Record<string, unknown>, ok?: boolean): void;
};

function makeUi(color: boolean) {
  const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const [green, red, yellow, dim, bold] = ["32", "31", "33", "2", "1"].map(paint) as [
    (s: string) => string,
    (s: string) => string,
    (s: string) => string,
    (s: string) => string,
    (s: string) => string,
  ];
  const out = (line = "") => process.stdout.write(line + "\n");
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return {
    color,
    green,
    red,
    yellow,
    dim,
    bold,
    out,
    json: (value: unknown) => out(JSON.stringify(value, null, 2)),
    table(rows: string[][], indent = "") {
      const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => visible(r[c] ?? ""))));
      for (const r of rows)
        out((indent + r.map((cell, c) => cell + " ".repeat(widths[c]! - visible(cell))).join("  ")).trimEnd());
    },
    mark(kind: CheckRow["mark"]) {
      if (!color) return { ok: "[ok]", fail: "[x]", unknown: "[?]" }[kind];
      return { ok: green("✓"), fail: red("✗"), unknown: yellow("?") }[kind];
    },
    status(s: string) {
      const paintStatus = s === "healthy" ? green : s === "degraded" ? yellow : s === "down" || s === "inactive" ? red : String;
      return paintStatus(s);
    },
  };
}

function parseArgs(argv: string[]): { args: string[]; flags: Flags } {
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      args.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const spec = FLAG_SPECS.find((f) => name === `--${f.long}` || (f.short && name === `-${f.short}`));
    if (!spec) throw new Error(`unknown option ${name} (see cfup --help)`);
    if (spec.value) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (!value) throw new Error(`${name} needs a value <${spec.value}>`);
      flags[spec.long] = value;
    } else {
      if (eq > 0) throw new Error(`${name} takes no value`);
      flags[spec.long] = true;
    }
  }
  return { args, flags: flags as Flags };
}

function checkFlags(spec: CommandSpec, path: string, flags: Flags) {
  const allowed = new Set<string>([...(spec.flags ?? []), ...FLAG_SPECS.filter((f) => f.global).map((f) => f.long)]);
  const stray = Object.keys(flags).find((f) => !allowed.has(f));
  if (stray) throw new Error(`--${stray} doesn't apply to cfup ${path} (see cfup ${path} --help)`);
}

function makeCtx(flags: Flags, ui: Ui): Ctx {
  const settings = resolveSettings(readConfig(), process.env, { tunnel: flags.tunnel, account: flags.account });
  const steps: Step[] = [];
  const dryRun = !!flags["dry-run"];
  const record = (step: Planned) => {
    const { run: _, ...plain } = step;
    steps.push(plain);
    if (flags.json) return;
    const verb = step.action === "keep" ? "unchanged" : dryRun ? `would ${step.action}` : pastTense(step.action);
    const prefix = dryRun && step.action !== "keep" ? (ui.color ? ui.yellow("•") : "[plan]") : ui.mark("ok");
    ui.out(`${prefix} ${step.kind.padEnd(8)} ${verb} ${step.detail}`);
    if (dryRun && step.diff)
      for (const line of step.diff)
        ui.out(`      ${line[0] === "+" ? ui.green(line) : line[0] === "-" ? ui.red(line) : ui.dim(line)}`);
  };
  return {
    flags,
    settings,
    ui,
    cf() {
      const token = settings.token?.value;
      if (!token)
        throw new Error(
          "no Cloudflare API token. Run `cfup config set token <token>`.\n" +
            "Create one at dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom.",
        );
      return cloudflare(token);
    },
    async apply(batches) {
      if (dryRun && !flags.json) ui.out(ui.dim("dry run: nothing will be written"));
      for (const batch of batches) {
        const items = Array.isArray(batch) ? batch : [batch];
        if (!dryRun) await Promise.all(items.map((item) => item.run?.()));
        items.forEach(record);
      }
    },
    finish(summary, extra = {}, ok = true) {
      const changes = steps.filter((s) => s.action !== "keep").length;
      if (flags.json) ui.json({ ok, dryRun, steps, summary: dryRun ? undefined : summary, ...extra });
      else if (dryRun) ui.out(`Planned ${changes} change${changes === 1 ? "" : "s"}; nothing written.`);
      else ui.out(summary);
    },
  };
}

const probe = <T>(p: Promise<T>): Promise<Probe<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (err) => ({ ok: false as const, error: err instanceof CfError ? err.apiMessage : String(err) }),
  );

async function verify(cf: Cloudflare, prefix: string): Promise<TokenInfo> {
  try {
    return await cf.verifyToken();
  } catch (err) {
    if (err instanceof CfError && err.status !== 0) throw new Error(`${prefix}: ${err.apiMessage}`);
    throw err;
  }
}

async function checklist(cf: Cloudflare, token: TokenInfo, account?: string) {
  const accounts = probe(cf.accounts());
  const tunnelCount = (id: string) => probe(cf.tunnels(id).then((t) => t.length));
  const [accountsResult, tunnels, zones, policies] = await Promise.all([
    accounts,
    account ? tunnelCount(account) : accounts.then((a) => (a.ok && a.value.length === 1 ? tunnelCount(a.value[0]!.id) : null)),
    probe(cf.zones().then((z) => z.map((zone) => zone.name))),
    probe(cf.tokenPolicies(token.id)),
  ]);
  return evaluateChecklist({
    token: { status: token.status, expiresOn: token.expires_on },
    accounts: accountsResult,
    account,
    tunnels,
    zones,
    policies,
  });
}

function printChecklist(ui: Ui, rows: CheckRow[]) {
  ui.out(ui.bold("Token"));
  const [valid, ...rest] = rows;
  ui.out(`  ${ui.mark(valid!.mark)} ${valid!.mark === "fail" ? ui.red(valid!.label) : valid!.label}`);
  const paintRow = (r: CheckRow) => (r.mark === "fail" ? ui.red : String);
  const cells = rest.map((r) => [ui.mark(r.mark), paintRow(r)(r.label), paintRow(r)(r.detail), ui.dim(r.source)]);
  ui.table(cells, "  ");
  for (const r of rest) for (const extra of r.extra ?? []) ui.out(`      ${extra}`);
}

async function setToken(ctx: Ctx, token: string): Promise<number> {
  const cf = cloudflare(token);
  const info = await verify(cf, "token rejected, not saved");
  if (info.status !== "active") throw new Error(`token is ${info.status}, not saved`);
  const result = await checklist(cf, info, ctx.settings.account?.value);
  if (!ctx.flags.json) {
    printChecklist(ctx.ui, result.rows);
    ctx.ui.out();
  }
  const path = configPath();
  await ctx.apply([
    { kind: "config", action: "save", detail: `token ${maskSecret(token)} to ${path}`, run: async () => writeConfig({ ...readConfig(path), token }, path) },
  ]);
  if (process.env.CLOUDFLARE_API_TOKEN && !ctx.flags.json)
    ctx.ui.out(ctx.ui.yellow("note: CLOUDFLARE_API_TOKEN is set and overrides the saved token"));
  ctx.finish(
    result.hardFailure ? "Saved the token, but it can't do everything cfup needs (see above)." : "Saved the token.",
    { checklist: result.rows, hardFailure: result.hardFailure },
    !result.hardFailure,
  );
  return result.hardFailure ? 2 : 0;
}

async function show(ctx: Ctx): Promise<number> {
  const { ui } = ctx;
  const path = configPath();
  const { token, tunnel, account } = ctx.settings;
  const envNames: Record<string, string> = { token: "CLOUDFLARE_API_TOKEN", tunnel: "CFUP_TUNNEL", account: "CFUP_ACCOUNT" };
  const source = (key: string, s?: { source: string }) =>
    !s ? "" : s.source === "env" ? `(env ${envNames[key]})` : s.source === "flag" ? `(--${key})` : "(file)";
  const settings = {
    path,
    token: token ? { masked: maskSecret(token.value), source: token.source } : null,
    tunnel: tunnel ?? null,
    account: account ?? null,
  };
  if (!ctx.flags.json) {
    ui.table([
      ["config", path, ""],
      ["token", token ? maskSecret(token.value) : ui.dim("(not set)"), ui.dim(source("token", token))],
      ["tunnel", tunnel?.value ?? ui.dim("(not set)"), ui.dim(source("tunnel", tunnel))],
      ["account", account?.value ?? ui.dim("(auto)"), ui.dim(source("account", account))],
    ]);
    ui.out();
  } else if (!token) ui.json(settings);
  const cf = ctx.cf();
  const info = await verify(cf, "token rejected");
  const result = await checklist(cf, info, account?.value);
  if (ctx.flags.json) ui.json({ ...settings, checklist: result.rows, hardFailure: result.hardFailure });
  else printChecklist(ui, result.rows);
  return result.hardFailure || info.status !== "active" ? 1 : 0;
}

async function configCommand(ctx: Ctx, sub: string, args: string[]): Promise<number> {
  if (sub === "show") {
    if (args.length) throw new Error("usage: cfup config show");
    return show(ctx);
  }
  const [key, value, ...extra] = args;
  if (!CONFIG_KEYS.includes(key as ConfigKey) || extra.length) throw new Error(`usage: cfup config ${sub} <token|tunnel|account>${sub === "set" ? " <value>" : ""}`);
  const path = configPath();
  if (sub === "set") {
    if (!value?.trim()) throw new Error(`usage: cfup config set ${key} <value>`);
    if (key === "token") return setToken(ctx, value.trim());
    await ctx.apply([
      { kind: "config", action: "save", detail: `${key} = ${value} to ${path}`, run: async () => writeConfig({ ...readConfig(path), [key!]: value.trim() }, path) },
    ]);
    ctx.finish(`Saved ${key} "${value.trim()}".`);
    return 0;
  }
  if (value !== undefined) throw new Error(`usage: cfup config unset ${key}`);
  const config = readConfig(path);
  delete config[key as ConfigKey];
  await ctx.apply([{ kind: "config", action: "remove", detail: `${key} from ${path}`, run: async () => writeConfig(config, path) }]);
  ctx.finish(`Removed ${key} from the config file.`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { args, flags } = parseArgs(argv);
  const ui = makeUi(!flags.json && !flags["no-color"] && !process.env.NO_COLOR && !!process.stdout.isTTY);
  if (flags.version) {
    ui.out(version);
    return 0;
  }
  const [command, ...rest] = args;
  if (!command) {
    ui.out(rootHelp(version));
    return 0;
  }
  const top = COMMANDS.find((c) => c.name === command);
  if (!top) throw new Error(`unknown command "${command}" (see cfup --help)`);
  const sub = top.sub ? rest.shift() : undefined;
  if (sub && !top.sub?.some((s) => s.name === sub)) throw new Error(`unknown command "cfup ${command} ${sub}" (see cfup ${command} --help)`);
  if (flags.help || (top.sub && !sub)) {
    ui.out(commandHelp(sub ? [command, sub] : [command])!);
    return 0;
  }
  const path = sub ? `${command} ${sub}` : command;
  checkFlags(findCommand(sub ? [command, sub] : [command])!, path, flags);

  if (command === "completions") {
    if (rest.length !== 1) throw new Error("usage: cfup completions <bash|zsh|fish|pwsh>");
    ui.out(completionScript(rest[0]!));
    return 0;
  }
  const ctx = makeCtx(flags, ui);
  switch (command) {
    case "ls":
      if (rest.length) throw new Error("usage: cfup ls");
      return hostname.ls(ctx);
    case "add":
      return hostname.add(ctx, rest);
    case "set":
      return hostname.set(ctx, rest);
    case "mv":
      return hostname.mv(ctx, rest);
    case "rm":
      return hostname.rm(ctx, rest);
    case "open":
      return hostname.open(ctx, rest);
    case "tunnel":
      return tunnelCommand(ctx, sub!, rest);
    case "route":
      return routeCommand(ctx, sub!, rest);
    case "config":
      return configCommand(ctx, sub!, rest);
    case "doctor":
      if (rest.length) throw new Error("usage: cfup doctor");
      return show(ctx);
  }
  throw new Error(`unknown command "${command}"`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (process.env.CFUP_DEBUG === "1") console.error(err);
    const [first, ...more] = (err instanceof Error ? err.message : String(err)).split("\n");
    process.stderr.write(`cfup: ${first}\n${more.map((line) => `  ${line}\n`).join("")}`);
    process.exitCode = 1;
  },
);
