import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_KEYS = ["token", "tunnel", "account"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type Config = Partial<Record<ConfigKey, string>>;

export type Source = "flag" | "env" | "file";
export type Setting = { value: string; source: Source };
export type Settings = Partial<Record<ConfigKey, Setting>>;

type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  return join(env.CFT_CONFIG_DIR || join(homedir(), ".cft"), "config.json");
}

export function readConfig(path = configPath()): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or delete it`);
  }
  const config: Config = {};
  for (const key of CONFIG_KEYS) {
    const value = (parsed as Record<string, unknown> | null)?.[key];
    if (typeof value === "string" && value) config[key] = value;
  }
  return config;
}

export function writeConfig(config: Config, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file; chmod is a silent no-op on Windows.
  try {
    chmodSync(path, 0o600);
  } catch {}
}

export function resolveSettings(config: Config, env: Env, flags: { tunnel?: string; account?: string }): Settings {
  const pick = (...candidates: [string | undefined, Source][]): Setting | undefined => {
    const hit = candidates.find(([value]) => value?.trim());
    return hit && { value: hit[0]!.trim(), source: hit[1] };
  };
  return {
    token: pick([env.CLOUDFLARE_API_TOKEN, "env"], [config.token, "file"]),
    tunnel: pick([flags.tunnel, "flag"], [env.CFT_TUNNEL, "env"], [config.tunnel, "file"]),
    account: pick([flags.account, "flag"], [env.CFT_ACCOUNT, "env"], [config.account, "file"]),
  };
}
