import { describe, expect, test } from "bun:test";
import { COMMANDS, FLAGS, SHELLS, commandHelp, completionScript, completionTree, rootHelp } from "./completions.ts";

const names = COMMANDS.flatMap((c) => [c.name, ...(c.sub ?? []).map((s) => s.name)]);

describe.each(SHELLS)("%s completions", (shell) => {
  const script = completionScript(shell);
  test.each(names)("mentions %s", (name) => expect(script).toContain(name));
  test("mentions every flag", () => {
    for (const f of FLAGS) expect(script).toContain(`--${f.long}`);
  });
});

test("tree has a key for every command path", () => {
  const tree = completionTree();
  for (const c of COMMANDS) {
    expect(tree[""]).toContain(c.name);
    for (const s of c.sub ?? []) expect(tree[c.name]).toContain(s.name);
  }
  expect(tree["config set"]).toContain("token");
  expect(tree["add"]).toContain("--path");
});

test("help is generated from the same table", () => {
  const help = rootHelp("0.0.0");
  for (const c of COMMANDS) expect(help).toContain(`cft ${c.name}`);
  expect(commandHelp(["tunnel"])).toContain("rename <old> <new>");
  expect(commandHelp(["add"])).toContain("--no-tls-verify");
  expect(commandHelp(["nope"])).toBeUndefined();
});

test("unknown shell throws", () => expect(() => completionScript("tcsh")).toThrow());
