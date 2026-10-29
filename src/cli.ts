#!/usr/bin/env bun
import { version } from "../package.json";
import { CfError, cloudflare, probe, type Cloudflare, type TokenInfo } from "./cf.ts";
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
import {
  evaluateChecklist,
  maskSecret,
  missingPermissionHint,
  pastTense,
  TOKEN_RECIPE,
  UsageError,
  wrongArgs,
  TOKENS_URL,
  visibleAccounts,
  type CheckRow,
} from "./core.ts";
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
    if (!spec) throw new UsageError(`unknown option ${name}`, args.slice(0, 2));
    if (spec.value) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (!value) throw new UsageError(`${name} needs a value <${spec.value}>`, args.slice(0, 2));
      flags[spec.long] = value;
    } else {
      if (eq > 0) throw new UsageError(`${name} takes no value`, args.slice(0, 2));
      flags[spec.long] = true;
    }
  }
  return { args, flags: flags as Flags };
}

function checkFlags(spec: CommandSpec, path: string, flags: Flags) {
  const allowed = new Set<string>([...(spec.flags ?? []), ...FLAG_SPECS.filter((f) => f.global).map((f) => f.long)]);
  const stray = Object.keys(flags).find((f) => !allowed.has(f));
  if (stray) throw new UsageError(`--${stray} doesn't apply to cfup ${path}`, path.split(" "));
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
            `Create one at ${TOKENS_URL} → Create Token → Create Custom Token, with these Permissions rows:\n` +
            TOKEN_RECIPE.join("\n"),
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

async function verify(cf: Cloudflare, prefix: string): Promise<TokenInfo> {
  try {
    return await cf.verifyToken();
  } catch (err) {
    if (err instanceof CfError && err.status !== 0) throw new Error(`${prefix}: ${err.apiMessage}`);
    throw err;
  }
}

async function checklist(cf: Cloudflare, token: TokenInfo, account?: string) {
  const [accountsResult, zones, policies] = await Promise.all([
    probe(cf.accounts()),
    probe(cf.zones()),
    probe(cf.tokenPolicies(token.id)),
  ]);
  const visible = visibleAccounts(accountsResult, zones).list;
  const chosen = account ?? (visible.length === 1 ? visible[0]!.id : undefined);
  const tunnels = chosen ? await probe(cf.tunnels(chosen).then((t) => t.length)) : null;
  return evaluateChecklist({
    token: { status: token.status, expiresOn: token.expires_on },
    accounts: accountsResult,
    account,
    tunnels,
    zones,
    policies,
  });
}

// Fix lines sit under their row instead of in a column, so a long row never wraps the table.
function printChecklist(ui: Ui, { rows, notes }: { rows: CheckRow[]; notes: string[] }) {
  ui.out(ui.bold("Token"));
  const [valid, ...rest] = rows;
  // The plain-text marks differ in width ([ok] vs [x]); coloured ones are all one cell.
  const mark = (m: CheckRow["mark"]) => (ui.color ? ui.mark(m) : ui.mark(m).padEnd(4));
  ui.out(`  ${mark(valid!.mark)} ${valid!.mark === "fail" ? ui.red(valid!.label) : valid!.label}`);
  const width = Math.max(...rest.map((r) => r.label.length));
  for (const r of rest) {
    const paint = r.mark === "fail" ? ui.red : String;
    ui.out(`  ${mark(r.mark)} ${paint(r.label.padEnd(width))}  ${r.mark === "ok" ? r.detail : paint(r.detail)}`);
    for (const extra of r.extra ?? []) ui.out(`      ${extra}`);
    for (const fix of r.fix ?? []) ui.out(`      ${fix.startsWith("add ") ? ui.yellow(fix) : ui.dim(fix)}`);
  }
  if (notes.length) ui.out();
  for (const note of notes) ui.out(ui.dim(note));
}

async function setToken(ctx: Ctx, token: string): Promise<number> {
  const cf = cloudflare(token);
  const info = await verify(cf, "token rejected, not saved");
  if (info.status !== "active") throw new Error(`token is ${info.status}, not saved`);
  const result = await checklist(cf, info, ctx.settings.account?.value);
  if (!ctx.flags.json) {
    printChecklist(ctx.ui, result);
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
  else printChecklist(ui, result);
  return result.hardFailure || info.status !== "active" ? 1 : 0;
}

async function configCommand(ctx: Ctx, sub: string, args: string[]): Promise<number> {
  if (sub === "show") {
    if (args.length) throw wrongArgs(["config", "show"], args);
    return show(ctx);
  }
  const [key, value, ...extra] = args;
  if (!CONFIG_KEYS.includes(key as ConfigKey) || extra.length)
    throw wrongArgs(["config", sub], args);
  const path = configPath();
  if (sub === "set") {
    if (!value?.trim()) throw wrongArgs(["config", "set"], args);
    if (key === "token") return setToken(ctx, value.trim());
    await ctx.apply([
      { kind: "config", action: "save", detail: `${key} = ${value} to ${path}`, run: async () => writeConfig({ ...readConfig(path), [key!]: value.trim() }, path) },
    ]);
    ctx.finish(`Saved ${key} "${value.trim()}".`);
    return 0;
  }
  if (value !== undefined) throw wrongArgs(["config", "unset"], args);
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
  if (!top) throw new UsageError(`unknown command "${command}"`, []);
  const sub = top.sub ? rest.shift() : undefined;
  if (sub && !top.sub?.some((s) => s.name === sub)) throw new UsageError(`unknown command "cfup ${command} ${sub}"`, [command]);
  if (flags.help || (top.sub && !sub)) {
    ui.out(commandHelp(sub ? [command, sub] : [command])!);
    return 0;
  }
  const path = sub ? `${command} ${sub}` : command;
  checkFlags(findCommand(sub ? [command, sub] : [command])!, path, flags);

  if (command === "completions") {
    if (rest.length !== 1) throw wrongArgs(["completions"], rest);
    ui.out(completionScript(rest[0]!));
    return 0;
  }
  const ctx = makeCtx(flags, ui);
  switch (command) {
    case "ls":
      if (rest.length) throw wrongArgs(["ls"], rest);
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
      if (rest.length) throw wrongArgs(["doctor"], rest);
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
    // 403 is Cloudflare's "token lacks a permission" (codes 9109, 10000); say which row to add.
    if (err instanceof CfError && err.status === 403) more.push(...missingPermissionHint(err.route));
    process.stderr.write(`cfup: ${first}\n${more.map((line) => `  ${line}\n`).join("")}`);
    // Show the help right away rather than telling the user to ask for it.
    if (err instanceof UsageError) {
      const { command } = err;
      const help = (command.length > 1 && commandHelp(command.slice(0, 2))) || (command[0] && commandHelp([command[0]])) || rootHelp(version);
      process.stderr.write(`\n${help}\n`);
    }
    process.exitCode = 1;
  },
);
