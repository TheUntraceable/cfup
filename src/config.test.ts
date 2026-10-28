import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, readConfig, resolveSettings, writeConfig } from "./config.ts";

let dir: string;
const previous = process.env.CFUP_CONFIG_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cfup-test-"));
  process.env.CFUP_CONFIG_DIR = join(dir, "nested");
});

afterAll(() => {
  if (previous === undefined) delete process.env.CFUP_CONFIG_DIR;
  else process.env.CFUP_CONFIG_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

test("CFUP_CONFIG_DIR decides the path", () => {
  expect(configPath()).toBe(join(dir, "nested", "config.json"));
});

test("missing file reads as empty", () => {
  expect(readConfig()).toEqual({});
});

test("round-trips and creates the directory", () => {
  writeConfig({ token: "secret-token-value", tunnel: "nas", account: "acc" });
  expect(readConfig()).toEqual({ token: "secret-token-value", tunnel: "nas", account: "acc" });
});

test("ignores unknown and non-string keys", () => {
  writeFileSync(configPath(), JSON.stringify({ token: "t", tunnel: 5, extra: "x" }));
  expect(readConfig()).toEqual({ token: "t" });
});

test("bad JSON is a readable error", () => {
  writeFileSync(configPath(), "{nope");
  expect(() => readConfig()).toThrow(/not valid JSON/);
});

test("precedence: flag > env > file", () => {
  const config = { token: "file-token", tunnel: "file-tunnel", account: "file-account" };
  expect(resolveSettings(config, {}, {})).toEqual({
    token: { value: "file-token", source: "file" },
    tunnel: { value: "file-tunnel", source: "file" },
    account: { value: "file-account", source: "file" },
  });
  const env = { CLOUDFLARE_API_TOKEN: "env-token", CFUP_TUNNEL: "env-tunnel", CFUP_ACCOUNT: "env-account" };
  expect(resolveSettings(config, env, {}).token).toEqual({ value: "env-token", source: "env" });
  expect(resolveSettings(config, env, {}).tunnel).toEqual({ value: "env-tunnel", source: "env" });
  expect(resolveSettings(config, env, { tunnel: "flag-tunnel", account: "flag-account" })).toMatchObject({
    tunnel: { value: "flag-tunnel", source: "flag" },
    account: { value: "flag-account", source: "flag" },
  });
  expect(resolveSettings({}, {}, {}).token).toBeUndefined();
});
