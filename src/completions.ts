import { CONFIG_KEYS } from "./config.ts";

type FlagSpec = { long: string; short?: string; value?: string; summary: string; global?: boolean };

export const FLAGS = [
  { long: "tunnel", short: "t", value: "name", summary: "tunnel name, id, or unique name prefix" },
  { long: "path", value: "regex", summary: "only requests whose path matches (hostname + path is the route key)" },
  { long: "no-tls-verify", summary: "skip TLS verification to the origin" },
  { long: "http-host-header", value: "host", summary: "Host header sent to the origin" },
  { long: "origin-server-name", value: "name", summary: "TLS server name expected from the origin" },
  { long: "connect-timeout", value: "dur", summary: "origin connect timeout: 30, 30s, 2m" },
  { long: "disable-chunked-encoding", summary: "no chunked transfer encoding to the origin" },
  { long: "http2-origin", summary: "speak HTTP/2 to the origin" },
  { long: "comment", value: "text", summary: "comment stored on the route" },
  { long: "force", short: "f", summary: "replace or remove whatever is in the way" },
  { long: "dry-run", short: "n", summary: "print the plan and ingress diff, write nothing" },
  { long: "wait", summary: "after writing, wait up to 60s for https://<hostname>/ to answer" },
  { long: "show-token", summary: "print the tunnel token in full" },
  { long: "account", value: "id", summary: "account id (beats CFUP_ACCOUNT and the config file)", global: true },
  { long: "json", summary: "machine-readable output", global: true },
  { long: "no-color", summary: "no colour (also NO_COLOR, or when output is piped)", global: true },
  { long: "help", short: "h", summary: "help for cfup or a command", global: true },
  { long: "version", short: "v", summary: "print the version", global: true },
] as const satisfies readonly FlagSpec[];

type FlagDef = (typeof FLAGS)[number];
export type FlagName = FlagDef["long"];
export type Flags = { [F in FlagDef as F["long"]]?: F extends { value: string } ? string : boolean };
export const FLAG_SPECS: readonly FlagSpec[] = FLAGS;

export type CommandSpec = {
  name: string;
  args?: string;
  summary: string;
  flags?: readonly FlagName[];
  choices?: readonly string[];
  example?: string;
  note?: string;
  sub?: readonly CommandSpec[];
};

const ORIGIN = [
  "no-tls-verify",
  "http-host-header",
  "origin-server-name",
  "connect-timeout",
  "disable-chunked-encoding",
  "http2-origin",
] as const;
export const SHELLS = ["bash", "zsh", "fish", "pwsh"] as const;

export const COMMANDS: readonly CommandSpec[] = [
  { name: "ls", summary: "list every tunnel's public hostnames", example: "cfup ls" },
  {
    name: "add",
    args: "<hostname> <service>",
    summary: "route a public hostname to a service",
    flags: ["tunnel", "path", ...ORIGIN, "force", "dry-run", "wait"],
    example: "cfup add app.example.com 3010 --tunnel nas",
    note:
      "Service: 3010 and localhost:3010 mean http://localhost:3010, host:8080 means\n" +
      "http://host:8080, anything with a scheme passes through. localhost is the\n" +
      "tunnel's machine. Tunnel: --tunnel, then CFUP_TUNNEL, then the config file,\n" +
      "then the only tunnel if there is one.",
  },
  {
    name: "set",
    args: "<hostname> [service]",
    summary: "change a route's service or origin options (DNS untouched)",
    flags: ["path", ...ORIGIN, "dry-run", "wait"],
    example: "cfup set app.example.com 3011 --no-tls-verify",
  },
  {
    name: "mv",
    args: "<hostname>",
    summary: "move a hostname to another tunnel and repoint its CNAME",
    flags: ["tunnel", "force", "dry-run", "wait"],
    example: "cfup mv app.example.com --tunnel laptop",
  },
  {
    name: "rm",
    args: "<hostname>",
    summary: "remove a public hostname and its CNAME",
    flags: ["path", "dry-run"],
    example: "cfup rm app.example.com",
  },
  { name: "open", args: "<hostname>", summary: "open https://<hostname> in the browser", example: "cfup open app.example.com" },
  {
    name: "tunnel",
    summary: "manage tunnels",
    sub: [
      { name: "ls", summary: "list tunnels with status and connections", example: "cfup tunnel ls" },
      {
        name: "create",
        args: "<name>",
        summary: "create a remotely-managed tunnel and print its install command",
        flags: ["show-token", "dry-run"],
        example: "cfup tunnel create nas",
      },
      {
        name: "token",
        args: "<name>",
        summary: "print the install command for an existing tunnel",
        flags: ["show-token"],
        example: "cfup tunnel token nas --show-token",
      },
      { name: "rename", args: "<old> <new>", summary: "rename a tunnel", flags: ["dry-run"], example: "cfup tunnel rename nas nas-old" },
      {
        name: "rm",
        args: "<name>",
        summary: "delete a tunnel (--force first removes its hostnames, CNAMEs, and routes)",
        flags: ["force", "dry-run"],
        example: "cfup tunnel rm nas-old --force",
      },
    ],
  },
  {
    name: "route",
    summary: "manage private network routes (WARP)",
    sub: [
      { name: "ls", summary: "list private network routes", example: "cfup route ls" },
      {
        name: "add",
        args: "<cidr>",
        summary: "route a private network through a tunnel",
        flags: ["tunnel", "comment", "dry-run"],
        example: "cfup route add 192.168.1.0/24 --tunnel nas --comment home",
      },
      { name: "rm", args: "<cidr>", summary: "remove a private network route", flags: ["dry-run"], example: "cfup route rm 192.168.1.0/24" },
    ],
  },
  {
    name: "config",
    summary: "token, default tunnel, and account",
    sub: [
      {
        name: "set",
        args: "<token|tunnel|account> <value>",
        summary: "save a setting (a token is verified and checked first)",
        choices: CONFIG_KEYS,
        flags: ["dry-run"],
        example: "cfup config set token <token>",
      },
      {
        name: "unset",
        args: "<token|tunnel|account>",
        summary: "forget a setting",
        choices: CONFIG_KEYS,
        flags: ["dry-run"],
        example: "cfup config unset tunnel",
      },
      { name: "show", summary: "show settings and check token permissions", example: "cfup config show" },
    ],
  },
  { name: "doctor", summary: "same as cfup config show", example: "cfup doctor" },
  {
    name: "completions",
    args: "<bash|zsh|fish|pwsh>",
    summary: "print a shell completion script",
    choices: SHELLS,
    example: "cfup completions bash >> ~/.bashrc",
  },
];

export function findCommand(path: string[]): CommandSpec | undefined {
  const top = COMMANDS.find((c) => c.name === path[0]);
  return path[1] && top?.sub ? top.sub.find((s) => s.name === path[1]) : top;
}

function columns(rows: [string, string][], indent = "  "): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`);
}

const flagRows = (names: readonly string[]): [string, string][] =>
  FLAG_SPECS.filter((f) => names.includes(f.long)).map((f) => [
    `${f.short ? `-${f.short}, ` : "    "}--${f.long}${f.value ? ` <${f.value}>` : ""}`,
    f.summary,
  ]);

const globalFlags = () => FLAG_SPECS.filter((f) => f.global).map((f) => f.long);

export function rootHelp(version: string): string {
  const usage: [string, string][] = COMMANDS.flatMap((c) =>
    c.sub
      ? c.sub.map((s): [string, string] => [`cfup ${c.name} ${s.name}${s.args ? ` ${s.args}` : ""}`, s.summary])
      : [[`cfup ${c.name}${c.args ? ` ${c.args}` : ""}`, c.summary]],
  );
  return [
    `cfup ${version}: Cloudflare Tunnel hostnames and routes from the command line`,
    "",
    "Usage",
    ...columns(usage),
    "",
    "Global options",
    ...columns(flagRows(globalFlags())),
    "",
    "Run cfup <command> --help for a command's options.",
    "",
    "Service shorthand: 3010 and localhost:3010 mean http://localhost:3010, host:8080",
    "means http://host:8080, anything with a scheme passes through. localhost is the",
    "machine running the tunnel, not this one.",
  ].join("\n");
}

export function commandHelp(path: string[]): string | undefined {
  const top = COMMANDS.find((c) => c.name === path[0]);
  const spec = findCommand(path);
  if (!top || !spec) return undefined;
  if (spec.sub)
    return [
      `Usage: cfup ${spec.name} <command>`,
      "",
      spec.summary,
      "",
      "Commands",
      ...columns(spec.sub.map((s): [string, string] => [`${s.name}${s.args ? ` ${s.args}` : ""}`, s.summary])),
      "",
      `Run cfup ${spec.name} <command> --help for a command's options.`,
    ].join("\n");
  const name = spec === top ? top.name : `${top.name} ${spec.name}`;
  const lines = [`Usage: cfup ${name}${spec.args ? ` ${spec.args}` : ""}${spec.flags?.length ? " [options]" : ""}`, "", spec.summary];
  if (spec.note) lines.push("", spec.note);
  if (spec.flags?.length) lines.push("", "Options", ...columns(flagRows(spec.flags)));
  if (spec.example) lines.push("", "Example", `  ${spec.example}`);
  return lines.join("\n");
}

export function completionTree(): Record<string, string[]> {
  const globals = globalFlags().map((f) => `--${f}`);
  const tree: Record<string, string[]> = { "": [...COMMANDS.map((c) => c.name), ...globals] };
  const visit = (spec: CommandSpec, prefix: string) => {
    const key = prefix ? `${prefix} ${spec.name}` : spec.name;
    tree[key] = [
      ...(spec.sub ?? []).map((s) => s.name),
      ...(spec.choices ?? []),
      ...(spec.flags ?? []).map((f) => `--${f}`),
      ...globals,
    ];
    spec.sub?.forEach((s) => visit(s, key));
  };
  COMMANDS.forEach((c) => visit(c, ""));
  return tree;
}

function bash(tree: Record<string, string[]>): string {
  const keys = Object.keys(tree).filter(Boolean);
  return [
    "_cfup() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}" key="" w i',
    "  for ((i = 1; i < COMP_CWORD; i++)); do",
    '    w="${COMP_WORDS[i]}"',
    "    [[ $w == -* ]] && continue",
    '    case "${key:+$key }$w" in',
    `      ${keys.map((k) => `"${k}"`).join("|")}) key="\${key:+$key }$w" ;;`,
    "      *) break ;;",
    "    esac",
    "  done",
    '  case "$key" in',
    ...Object.entries(tree).map(([k, words]) => `    "${k}") COMPREPLY=($(compgen -W "${words.join(" ")}" -- "$cur")) ;;`),
    "  esac",
    "}",
    "complete -F _cfup cfup",
  ].join("\n");
}

function fish(tree: Record<string, string[]>): string {
  const keys = Object.keys(tree).filter(Boolean);
  return [
    "function __cfup_key",
    '    set -l key ""',
    "    for w in (commandline -opc)[2..-1]",
    "        string match -q -- '-*' $w; and continue",
    '        set -l next (string trim -- "$key $w")',
    `        if contains -- $next ${keys.map((k) => `'${k}'`).join(" ")}`,
    "            set key $next",
    "        else",
    "            break",
    "        end",
    "    end",
    "    echo $key",
    "end",
    "complete -c cfup -f",
    ...Object.entries(tree).map(([k, words]) => `complete -c cfup -n 'test "x"(__cfup_key) = "x${k}"' -a '${words.join(" ")}'`),
  ].join("\n");
}

function pwsh(tree: Record<string, string[]>): string {
  return [
    "Register-ArgumentCompleter -Native -CommandName cfup, cfup.exe -ScriptBlock {",
    "    param($wordToComplete, $commandAst, $cursorPosition)",
    "    $tree = @{",
    ...Object.entries(tree).map(([k, words]) => `        '${k}' = @(${words.map((w) => `'${w}'`).join(", ")})`),
    "    }",
    "    $key = ''",
    "    foreach ($element in ($commandAst.CommandElements | Select-Object -Skip 1)) {",
    "        if ($element.Extent.EndOffset -ge $cursorPosition) { break }",
    "        $w = $element.ToString()",
    "        if ($w -like '-*') { continue }",
    "        $next = \"$key $w\".Trim()",
    "        if ($tree.ContainsKey($next)) { $key = $next } else { break }",
    "    }",
    "    $tree[$key] | Where-Object { $_ -like \"$wordToComplete*\" } | ForEach-Object {",
    "        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
    "    }",
    "}",
  ].join("\n");
}

export function completionScript(shell: string): string {
  const tree = completionTree();
  if (shell === "bash") return bash(tree);
  if (shell === "zsh") return ["autoload -U +X bashcompinit && bashcompinit", bash(tree)].join("\n");
  if (shell === "fish") return fish(tree);
  if (shell === "pwsh") return pwsh(tree);
  throw new Error(`unknown shell "${shell}"; use one of ${SHELLS.join(", ")}`);
}
