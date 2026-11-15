<div align="center">

<img src="assets/banner.png" alt="hyades-agent — Hyades AI as Claude Code tools" width="100%">

# hyades-agent

**Claude Code integration for the [Hyades](https://hyades.gnostr.cloud) AI gateway**

qwen LLM · image generation & editing with quality checks · Clef System One decisions · 3D model generation

`MCP tools` · `skill` · `media subagent` — zero dependencies, one-command install

</div>

---

## Tools

Six typed tools exposed over MCP (stdio):

| Tool | What it does | Notes |
|:--|:--|:--|
| `hyades_models` | List model ids this key is actually authorized for | Authorization changes per key — always confirm |
| `hyades_chat` | qwen chat/completions: Q&A, code, tool calls, JSON | Auto-retries `429`; `json_mode: true` routes around Hyades' broken `response_format` |
| `hyades_image_generate` | `qwen-image-2.1` generation | `quality_check: true` runs Clef's quality gate; **saves the ephemeral result URL to a local file** before returning |
| `hyades_image_edit` | Scene/element edits on a local image | Same quality gate available |
| `hyades_clef` | Clef System One decision (`POST /v1/systemone`) | Local image paths in, data URLs out; returns score / choice / noul + probabilities |
| `hyades_3d_generate` | 3D model from prompt or source image | Handles sync (`200`) *and* async (`202` + polling, 10 min default window) |

Errors come back as **structured tool results** (`{error: <code>, message, retryable}`), not crashes — the agent can read and react. The API key is never echoed in output.

## Setup

### Prerequisites

| Requirement | Check | Notes |
|:--|:--|:--|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI | `claude --version` | Must be on `PATH` so `install.sh` can register the server |
| Node.js **18+** | `node --version` | Server uses the built-in `fetch`; no `npm install` needed |
| `bash` + `git` | — | macOS, Linux, or WSL. On native Windows use Git Bash *(untested)* |
| A **Hyades API key** | — | Issued by the Hyades gateway operator. This repo contains no key |

### 1. Clone

```bash
git clone https://github.com/Traves-Theberge/hyades-agent.git
cd hyades-agent
```

### 2. Store your API key

**Option A: key file (recommended).** Works no matter how Claude Code is launched.

```bash
mkdir -p ~/.omp/agent
printf '%s' 'YOUR_HYADES_KEY' > ~/.omp/agent/hyades.key
chmod 600 ~/.omp/agent/hyades.key
```

**Option B: environment variable.** Claude Code passes its environment to the server, and
`HYADES_API_KEY` takes priority over the key file. Start Claude Code from a shell where it is set:

```bash
echo 'export HYADES_API_KEY="YOUR_HYADES_KEY"' >> ~/.bashrc   # or ~/.zshrc
```

> [!WARNING]
> Never commit the key. `*.key` is already in `.gitignore`.

### 3. Install

```bash
./install.sh
```

This checks that Node 18+ is installed and copies the skill, subagent, and server into `~/.claude`.
It then registers the MCP server at user scope, so every Claude Code session gets it, and checks
that a key is available. Expected output:

```
  [ok] node v22.x
  [ok] skill -> ~/.claude/skills/hyades/
  [ok] subagent -> ~/.claude/agents/hyades-media.md
  [ok] mcp server -> ~/.claude/mcp/hyades/
  [ok] mcp registered: hyades (stdio, node)
  [ok] key file present at ~/.omp/agent/hyades.key
```

To install somewhere other than `~/.claude`, set `CLAUDE_DIR=/path ./install.sh`.

### 4. Verify

```bash
claude mcp list                      # expect: hyades: node …/hyades-server.mjs - ✔ Connected
claude -p "Call hyades_models and list the models my key can use" \
  --allowedTools mcp__hyades__hyades_models
```

The second command should print the models your key can use (for example `qwen3.8-27b`). If you
get `unauthorized`, the key is missing or wrong; see [Troubleshooting](#troubleshooting).

Optional full end-to-end check. It **makes real, billable calls** (chat, one image generation, one
edit, one Clef decision) and saves images in the current directory:

```bash
node mcp/smoke.mjs
```

### 5. Use it

Open Claude Code anywhere and ask in plain language:

```
> generate a product hero for a coffee app, quality-checked
> call clef and ask whether the attached screenshot shows an error state
> ask qwen to write a regex for ISO dates
> list the models my key can use
```

Claude Code asks permission the first time each `hyades_*` tool runs. Image and brand requests are
routed to the `hyades-media` subagent automatically. Generated images are saved to the directory
Claude Code is working in.

### Configuration

All optional. Set them in the environment Claude Code is started from.

| Variable | Default | Purpose |
|:--|:--|:--|
| `HYADES_API_KEY` | — | API key; takes priority over any key file |
| `HYADES_KEY_FILE` | `~/.omp/agent/hyades.key` | Alternative key file location |
| `HYADES_BASE_URL` | `https://hyades.gnostr.cloud/v1` | Gateway base URL |
| `HYADES_OUTPUT_DIR` | current working directory | Where generated images are saved |

### Updating

```bash
git pull && ./install.sh
```

`install.sh` is safe to re-run. It overwrites the copies in `~/.claude` and re-registers the server.
Restart any open Claude Code sessions to pick up changes.

### Uninstall

```bash
claude mcp remove --scope user hyades
rm -rf ~/.claude/skills/hyades ~/.claude/agents/hyades-media.md ~/.claude/mcp/hyades
```

Your key file is left in place; delete `~/.omp/agent/hyades.key` yourself if you no longer need it.

### Troubleshooting

| Symptom | Cause | Fix |
|:--|:--|:--|
| `install.sh`: `node not found` / `too old` | Node missing or below 18 | Install Node.js 18+ |
| `install.sh`: `'claude' not on PATH` | CLI not installed or not on `PATH` | Install Claude Code, re-run, or run the printed `claude mcp add` command |
| `claude mcp list` shows hyades **failed** | `node` not on the `PATH` Claude Code sees | `claude mcp remove --scope user hyades`, then re-add with the full path from `which node` |
| Tool returns `no_credential` | No key file and no `HYADES_API_KEY` | Do [step 2](#2-store-your-api-key) |
| Tool returns `unauthorized` | Key wrong, revoked, or rotated; a stale `HYADES_API_KEY` overrides a good key file | Fix the key; `unset HYADES_API_KEY` if you use the file |
| Tool returns `forbidden` | Your key isn't allowed to use that model | Call `hyades_models` and pick a listed model |
| `rate_limited` after retries | More than 2 requests in flight | Run image jobs one at a time |
| `backend_down` | Gateway upstream temporarily unavailable | Retry later |
| Skill or subagent not picked up | Session started before install | Restart Claude Code |

## Verified (2026-11-15, live against the gateway)

| Check | Result |
|:--|:--|
| `hyades_models` via MCP | `qwen3.8-27b`, `qwen3.8-27b-refusal-off` |
| Chat (`pong`) | exact `pong`, 1.5s |
| JSON mode workaround | clean `{"answer": 42}` |
| Image gen + quality gate | `passed`, score 0.93, file on disk |
| Image edit | saved, no gate → `null` quality |
| Clef decision | `noul: 0.994` in <1s |
| `403` contract | structured `forbidden` for unauthorized model |
| Skill discovery | headless `claude -p` read the skill and answered from it |
| End-to-end | headless session called `hyades_models` and returned the live list |

## Repo layout

```
hyades-agent/
├── mcp/
│   ├── hyades-server.mjs     # MCP stdio server (zero deps, Node ≥ 18)
│   └── smoke.mjs             # stdio smoke test (harness)
├── skills/hyades/
│   ├── SKILL.md              # trigger description + pitfalls
│   └── reference.md          # endpoint contracts, error table, quality fields
├── agents/hyades-media.md    # subagent: image/brand specialist
├── assets/banner.png         # README banner (generated with Hyades)
├── install.sh                # user-scope install
├── LICENSE                   # MIT
└── README.md
```

This repo is the source of truth; `install.sh` copies files into `~/.claude`, so re-run it after any change.

## Known pitfalls (baked into the server)

| Pitfall | Handled how |
|:--|:--|
| Cloudflare `1010` without a `User-Agent` | Server always sends one |
| 2 in-flight turns per silo → `429` | Automatic backoff retry (2.5s·n, ≤4); image jobs should stay serialized |
| `response_format` returns empty content | `json_mode` prompt-based workaround |
| Image result URLs are temporary | Downloaded to `saved_paths` before the tool returns |
| Quality gate self-retries (`attempts: 2`, ~60s) | Expected, not an error |
| On WSL, a Windows `bun` on `PATH` resolves the home directory to `C:\Users\…` | Registered under `node`; the key lookup also checks `$HOME`, `USERPROFILE`, and `\\wsl.localhost` paths |

## Error contract

| Status | Meaning | Action |
|:--|:--|:--|
| `401` | no / invalid bearer | fix the key |
| `403` | model not authorized for this key | use an authorized model |
| `403` · `1010` | Cloudflare block (missing User-Agent) | set User-Agent |
| `429` | concurrency limit (2 turns/silo) | back off, serialize |
| `400` | bad request (Clef URL image, wrong model) | fix the body |
| `503` | upstream backend down | transient — retry |

## Key rotation

If the key was ever pasted in chat: `POST /admin/keys/<key-name>/rotate` (via the gateway admin), then replace
`~/.omp/agent/hyades.key`. Nothing else to change.

## License

[MIT](LICENSE) © 2026 Traves Theberge. Covers this repo's code and docs. Using the Hyades gateway
requires your own API key and is governed by the gateway operator's terms.
