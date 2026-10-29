# cfup

Add and remove Cloudflare Tunnel public hostnames, tunnels, and private network routes from the command line, through the Cloudflare API. No Zero Trust dashboard, and no `cloudflared` needed on the machine you run it from.

Each public hostname belongs to exactly one remotely-managed tunnel. `localhost` in a service means **that tunnel's machine**, not the one running `cfup`.

## Install

Requires [Bun](https://bun.sh).

Run without installing:

```sh
bunx @theuntraceable/cfup ls
```

Install globally, then type `cfup`:

```sh
bun add -g @theuntraceable/cfup
```

Or build a standalone binary:

```sh
bun install
bun run build        # dist/cfup (dist/cfup.exe on Windows)
```

Drop `dist/cfup` on your PATH.

The npm package is scoped because npm's similarity filter blocks the bare name `cfup`; the command is still `cfup`.

## Token

Create a token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → Create Custom Token. Each line below is one row under **Permissions**, spelled exactly as the three dropdowns show it:

| Type | Permission | Level | Why |
|---|---|---|---|
| Account | Cloudflare Tunnel | Edit | tunnels, ingress rules, private routes |
| Zone | DNS | Edit | the CNAME for each hostname |
| Account | Account Settings | Read | lets cfup find your account (optional when you have zones: it falls back to their account) |
| User | API Tokens | Read | optional: lets `cfup config show` confirm the two Edit rows |

Then set **Zone Resources** → Include → Specific zone (or All zones), and **Account Resources** → Include → your account.

When a check or a command fails for lack of a permission, cfup prints the exact row to add.

`tunnel create`, `tunnel rm`, `tunnel token` and the `route` commands need nothing more: Account → Cloudflare Tunnel: Edit covers the tunnel and private-route (teamnet) endpoints.

```sh
cfup config set token <token>   # verifies the token, prints a permission checklist, saves it
```

## Commands

Public hostnames:

```sh
cfup ls                                         # every tunnel's hostnames
cfup add app.example.com 3010                   # CNAME + ingress rule -> http://localhost:3010
cfup add api.example.com 8080 --path '^/v1'     # hostname + path is the route key
cfup add app.example.com 3011 --force           # replace, or move from another tunnel
cfup set app.example.com --no-tls-verify        # change service/origin options, DNS untouched
cfup mv app.example.com --tunnel laptop         # move to another tunnel and repoint the CNAME
cfup rm app.example.com                         # remove the rule, then its CNAME
cfup open app.example.com                       # open https://app.example.com
```

Service shorthand: `3010` and `localhost:3010` mean `http://localhost:3010`, `host:8080` means `http://host:8080`, and anything with a scheme (`https://`, `tcp://`, `ssh://`, `rdp://`, `unix:`, `http_status:`) passes through.

Origin options on `add` and `set`: `--no-tls-verify`, `--http-host-header <h>`, `--origin-server-name <n>`, `--connect-timeout <dur>`, `--disable-chunked-encoding`, `--http2-origin`.

Tunnels:

```sh
cfup tunnel ls                          # name, id, status, config source, connections, created
cfup tunnel create nas                  # prints the `cloudflared service install` command
cfup tunnel token nas --show-token      # install command for an existing tunnel, token unmasked
cfup tunnel rename nas nas-old
cfup tunnel rm nas-old --force          # also removes its hostnames, CNAMEs and routes
```

Private network routes (WARP):

```sh
cfup route ls
cfup route add 192.168.1.0/24 --tunnel nas --comment home
cfup route rm 192.168.1.0/24
```

Settings and shell:

```sh
cfup config set tunnel nas              # default tunnel for add and route add
cfup config set account <id>            # only needed when the token sees several accounts
cfup config unset tunnel
cfup config show                        # settings plus a live permission checklist
cfup doctor                             # same as config show
cfup completions pwsh >> $PROFILE       # bash, zsh, fish, pwsh
```

Every write takes `--dry-run` (prints the plan and the exact ingress diff) and `--json` (prints `{ "ok": true, "steps": [...] }`). `add`, `set` and `mv` take `--wait` to poll `https://<hostname>/` for up to 60s after writing. `--no-color` and `NO_COLOR` turn colour off; it is also off when output is piped.

## Config precedence

Config lives in `~/.cfup/config.json` (or `$CFUP_CONFIG_DIR/config.json`), written with mode 600.

| Setting | Order |
|---|---|
| token | `CLOUDFLARE_API_TOKEN` > config file |
| tunnel | `--tunnel` > `CFUP_TUNNEL` > config file > the only tunnel |
| account | `--account` > `CFUP_ACCOUNT` > config file > the only account |

`--tunnel` takes a name, a full tunnel id, or a unique prefix of a name.

Locally-managed tunnels (ingress in the machine's `config.yml`) are listed but never edited.

Exit codes: 0 ok, 1 error, 2 token saved but the permission checklist found problems. `CFUP_DEBUG=1` prints stack traces.

## Development

```sh
bun test
bun run typecheck
bun run dev ls
```

## License

MIT
