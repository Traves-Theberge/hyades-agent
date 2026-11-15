<div align="center">

<img src="assets/banner.png" alt="hyades-agent — the Hyades AI gateway as agent tools" width="100%">

# Hyades for Claude Code and omp

**A plugin for the [Hyades](https://hyades.gnostr.cloud) AI gateway, for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [omp](https://omp.sh)**

qwen chat · image generation & editing with quality scores · Clef System One decisions · 3D models

</div>

---

## What you get

| Component | In Claude Code | In omp | What it does |
|:--|:--|:--|:--|
| MCP server | `plugin:hyades:gateway` | `hyades:gateway` | Six tools that call the gateway (below). A native Rust binary |
| Skill | `hyades:using-hyades-tools` | `using-hyades-tools` | Says which tool fits a request and how to handle each error. Loads automatically when relevant |
| Agent | `hyades:hyades-agent` | `hyades-agent` | The Hyades specialist for work that takes several gateway calls or must end in a checked result: logos, icons, banners and brand kits with exact text, images turned into 3D models, results verified with Clef. Iterates on quality scores and checks its own output |

### Tools

| Tool | Use it for |
|:--|:--|
| `list_models` | Which models your key can use |
| `ask_qwen` | Asking qwen directly: a second opinion, uncensored answers (`qwen3.8-27b-refusal-off`), or JSON (`json_mode`) |
| `generate_image` | New images with `qwen-image-2.1`, optionally quality-scored; saved as local files |
| `edit_image` | Changing an existing local image; saved as a new file |
| `ask_clef` | A fast yes/no likelihood from Clef System One, optionally about images |
| `generate_3d_model` | A 3D model (`.glb`) from a prompt or an image; waits for the job, then saves the file |

The agent routes requests itself: ordinary questions and code stay with the agent, and the
tools are used when a request needs them. Errors come back as structured results (`{error,
message, retryable}`) the agent can act on. Your API key is never included in output.

## Requirements

- **Node.js 22 or newer** — runs the small launcher that starts the server
- **A Hyades API key** from the gateway operator. This repo contains no key
- **One of these platforms:**

| OS | CPU | Server binary |
|:--|:--|:--|
| Linux | x64, arm64 | static (musl), runs on any distribution |
| macOS | Apple Silicon, Intel | |
| Windows | x64 | |

On first start the launcher downloads the ~4 MB server binary for your platform from this
repo's GitHub release for the installed version, checks it against the SHA-256 recorded in
[`launcher/checksums.json`](launcher/checksums.json), and caches it. A binary that doesn't match
is refused. Later starts are offline.

## Install in Claude Code

Claude Code 2.1.275 or newer:

```
/plugin install hyades --marketplace Traves-Theberge/hyades-agent
```

Claude Code shows a dialog asking for your **Hyades API key**. Input is masked, and the key is
kept in your system's secure credential store, not in a settings file. To change it later:

```
/plugin configure hyades@hyades-agent
```

<details>
<summary>Other ways to install</summary>

**Two steps, or an older Claude Code:**

```
/plugin marketplace add Traves-Theberge/hyades-agent
/plugin install hyades@hyades-agent
```

**From a shell.** `claude plugin install` doesn't prompt for the key, so set it afterwards with
`/plugin configure hyades@hyades-agent` inside Claude Code:

```bash
claude plugin marketplace add Traves-Theberge/hyades-agent
claude plugin install hyades@hyades-agent
```

**Key without the plugin dialog.** If no key is configured, the server falls back to the
`HYADES_API_KEY` environment variable, then to the file `~/.omp/agent/hyades.key` (`chmod 600`).

</details>

## Install in omp

```bash
omp plugin marketplace add Traves-Theberge/hyades-agent
omp plugin install hyades@hyades-agent
```

Or inside a session: `/marketplace add Traves-Theberge/hyades-agent`, then
`/marketplace install hyades@hyades-agent` and `/reload-plugins`.

omp doesn't show Claude Code's key dialog, so give it the key one of these ways:

```bash
export HYADES_API_KEY="YOUR_HYADES_KEY"                 # in your shell profile
# or
mkdir -p ~/.omp/agent && printf '%s' 'YOUR_HYADES_KEY' > ~/.omp/agent/hyades.key && chmod 600 ~/.omp/agent/hyades.key
```

## Verify

```bash
# Claude Code
claude plugin details hyades@hyades-agent   # 1 skill, 1 agent, 1 MCP server
claude mcp list                             # plugin:hyades:gateway … ✔ Connected
claude -p "Call list_models and list the model ids" \
  --allowedTools mcp__plugin_hyades_gateway__list_models

# omp
omp plugin list                             # hyades@hyades-agent (user)
omp -p "Call the Hyades list_models tool and list the model ids"
```

The `-p` commands should print the models your key can use, such as `qwen3.8-27b`. The first
one also downloads the server binary.

## Use it

Ask in plain language:

```
> design a logo for my bakery, Crumb & Co, with the name in it
> quick sketch of a mountain at dawn
> edit ./photo.png so the scene is at sunset
> turn ./photo.png into a 3D model
> give me a 0–1 score for how well ./photo.png matches "a cozy desk at night"
> get a second opinion from qwen on this regex
```

Each host asks permission before a tool runs, depending on your approval settings. Generated
files are saved in the session's working directory. To call the agent yourself: in Claude Code
mention `@agent-hyades:hyades-agent`; in omp ask for the `hyades-agent` agent.

## Configuration

| Setting | Where | Purpose |
|:--|:--|:--|
| API key (Claude Code) | `/plugin configure hyades@hyades-agent` | Recommended in Claude Code. Kept in secure storage |
| `HYADES_API_KEY` | environment | Used when no plugin key is configured; the way to set the key in omp |
| `HYADES_KEY_FILE` | environment | Key file path; default `~/.omp/agent/hyades.key` |
| `HYADES_BASE_URL` | environment | Gateway URL; default `https://hyades.gnostr.cloud/v1` |
| `HYADES_OUTPUT_DIR` | environment | Where files are saved; default the working directory |
| `HYADES_3D_POLL_MS` | environment | 3D job poll interval; default 10000 |
| `HYADES_SERVER_BINARY` | environment | Use this server binary instead of downloading one (offline installs, own builds) |
| `HYADES_RELEASE_BASE_URL` | environment | Download binaries from a mirror instead of GitHub releases; checksums still apply |

Environment variables must be set where Claude Code or omp is started.

## Update and uninstall

```bash
# Claude Code
claude plugin marketplace update hyades-agent && claude plugin update hyades@hyades-agent
claude plugin uninstall hyades@hyades-agent

# omp
omp plugin marketplace update hyades-agent && omp plugin upgrade hyades@hyades-agent
omp plugin uninstall hyades@hyades-agent
```

Restart the session after updating (in omp, `/reload-plugins` is enough for the skill, agent and
MCP server). A new version downloads its matching binary on its first start. Uninstalling from
Claude Code also removes the key it stored.

## Troubleshooting

| Symptom | Fix |
|:--|:--|
| `no_credential` | Set the key: `/plugin configure hyades@hyades-agent` (omp: `HYADES_API_KEY` or the key file) |
| `unauthorized` | The key is wrong, revoked or rotated. Configure a new one. A key set in the plugin overrides `HYADES_API_KEY` and the key file |
| `forbidden` | Your key can't use that model. Ask the agent to run `list_models` |
| `rate_limited` | More than 2 requests in flight. Run image and 3D jobs one at a time |
| `backend_down` | The gateway's upstream is down. Retry later |
| `bad_args` | A path is wrong, or the file isn't a PNG, JPEG or WebP image |
| Server fails to start: `download failed` | No network on first start, or GitHub unreachable. Retry, set `HYADES_RELEASE_BASE_URL` to a mirror, or set `HYADES_SERVER_BINARY` |
| Server fails to start: `checksum mismatch` | The downloaded binary isn't the released one. Nothing was run or cached; check proxies or the mirror |
| Server fails to start: `no server binary for <platform>` | Your OS/CPU isn't in the supported list above |
| `plugin:hyades:gateway` shows **failed** in `claude mcp list` | `node` isn't on the `PATH` the host sees, or is older than 22 |
| The skill or agent isn't used | Restart the session after installing or updating (omp: `/reload-plugins`); check `claude plugin list` or `omp plugin list` |

## How it behaves

| Behaviour | Why |
|:--|:--|
| Files are saved locally before a tool returns | Gateway result URLs expire |
| Files never overwrite each other | Names carry a timestamp and a random suffix, and are created exclusively |
| Only PNG, JPEG and WebP files (max 20 MB) are uploaded, judged by their content | A tricked request can't upload `~/.ssh/id_rsa` or `.env` as an "image" |
| `429` is retried with backoff, 4 times | The gateway allows 2 requests in flight per key |
| `ask_qwen` with `json_mode` uses a prompt, not `response_format` | The gateway answers `response_format` with empty content |
| 3D jobs are submitted once, then polled | Every submission is a new, billable job |
| A `User-Agent` header is always sent | Cloudflare blocks requests without one (`error code: 1010`) |
| HTTPS is verified against bundled Mozilla root certificates, not the OS store | One static binary per platform, cross-built without Apple's SDK. Networks that intercept TLS with their own certificate authority aren't supported |

## Why Rust

The server was written in both TypeScript (MCP SDK v2 on Node) and Rust (`rmcp`), both on the
current MCP protocol (`2026-07-28`) with identical tools, and both passed the same test suite.
They were benchmarked side by side against the same fake gateway, through the official MCP client
over stdio, with nothing else running. Medians of two clean runs on Linux x64 (WSL2):

| Measure | TypeScript | Rust | Rust via launcher (as shipped) |
|:--|--:|--:|--:|
| Start: spawn → first `tools/list` (ms) | 578 | 30 | 345 |
| Tool call, p50 (ms) | 2.1 | 1.1 | 0.9 |
| Calls per second, 20 in flight | 996 | 2,850 | 2,690 |
| 15 MB image upload, p50 (ms) | 312 | 153 | 164 |
| Peak memory (MB) | 420 | 67 | 127 |
| Shipped size | 841 KB bundle | 3.2–4.3 MB per platform | same |

Rust was selected: it wins on every runtime measure even with the Node launcher in front, and
uses about a third of the memory. Real tool calls are dominated by the gateway itself (image
generation takes 25–60 s), so the practical gains are memory and start-up. `npm run bench`
reproduces the Rust half of the table.

## Development

```
hyades-agent/
├── .claude-plugin/
│   ├── plugin.json               # plugin manifest: MCP server, API key setting
│   └── marketplace.json          # lets this repo be added as a marketplace
├── agents/hyades-agent.md        # hyades:hyades-agent
├── skills/using-hyades-tools/
│   ├── SKILL.md                  # routing table and error handling
│   └── tools-reference.md        # arguments, quality fields, error codes
├── launcher/
│   ├── hyades-server.mjs         # picks, downloads, verifies and starts the binary
│   └── checksums.json            # SHA-256 of each released binary, for this version
├── rust/                         # the MCP server (rmcp, tokio, hyper + rustls)
├── test/                         # offline tests: fake gateway + fake release server
├── scripts/
│   ├── release.ts                # build one or all platforms; publish a release
│   ├── bench.ts                  # start-up, latency, throughput, upload, memory
│   └── smoke.ts                  # live check against the real gateway (costs credits)
└── assets/                       # banner and plugin icon
```

**Toolchain:** Node.js 22+, Rust 1.100+, [Zig](https://ziglang.org) 0.17+ and
[cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) 0.24+ (Zig is the C
compiler/linker, which lets one Linux machine build every platform). Then `npm install`.

```bash
npm run build            # build this machine's binary into release/ (the launcher prefers it)
npm test                 # 9 offline tests through the launcher: no key, no network, no cost
npm run check            # typecheck + build + test + plugin validation
npm run bench            # benchmark the binary, direct and through the launcher
npm run smoke            # live check against the real gateway; uses your key and costs credits
claude --plugin-dir .    # run Claude Code with your working copy
```

**Releasing a version:**

1. Bump `version` in `package.json`, `.claude-plugin/plugin.json` and `rust/Cargo.toml` (the
   release script refuses to run if they differ). Installed copies stay on their version until
   it changes.
2. `npm run release` builds all five platforms and writes `launcher/checksums.json`.
3. Commit and push, then `npm run release:publish` creates GitHub release `v<version>` with the
   five binaries. The launcher downloads from that release.

### Verified (2026-11-15)

| Check | Result |
|:--|:--|
| Offline tests (Rust, through the launcher) | 9/9: tool list, 3D polling, upload refusal, unique files, key precedence, first-run download + cache, checksum refusal |
| Live: models, chat, image generate, edit, Clef, `403` through the Rust binary over real HTTPS | all as expected |
| Live: 3D | **not verified**: the gateway's 3D backend was down (`503`) |
| Cross-builds | all five platforms build; Apple Silicon binary carries the required ad-hoc signature. macOS and Windows binaries were not run on real hardware |
| Plugin: Claude Code install, key prompt and fallbacks; omp install, skill and agent | as expected |
| Routing: 24 requests, headless, Hyades calls blocked, Rust server | omp 24/24; Claude Code 23/24. The miss: "use the model that won't refuse" — Claude Code writes it itself because it wouldn't refuse. Naming the model ("ask qwen's refusal-off model …") routes correctly 3/3 |

## License

[MIT](LICENSE) © 2026 Traves Theberge. Covers this repo's code and docs. Using the Hyades
gateway requires your own API key and is subject to the gateway operator's terms.
