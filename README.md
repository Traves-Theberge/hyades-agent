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
| MCP server | `plugin:hyades:gateway` | `hyades:gateway` | Six tools that call the gateway (below) |
| Skill | `hyades:using-hyades-tools` | `using-hyades-tools` | Says which tool fits a request and how to handle each error. Loads automatically when relevant |
| Agent | `hyades:visual-designer` | `visual-designer` | Produces finished visual assets: logos, icons, banners, brand kits, anything with exact text. Iterates on quality scores and checks its own output |

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

## Install in Claude Code

**Requirements:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 2.1.275+,
Node.js 18+, and a Hyades API key from the gateway operator. This repo contains no key.

Inside Claude Code:

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

**Two steps, or Claude Code older than 2.1.275:**

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

**Requirements:** [omp](https://omp.sh), Node.js 18+, and a Hyades API key.

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

The `-p` commands should print the models your key can use, such as `qwen3.8-27b`.

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
mention `@agent-hyades:visual-designer`; in omp ask for the `visual-designer` agent.

## Configuration

| Setting | Where | Purpose |
|:--|:--|:--|
| API key (Claude Code) | `/plugin configure hyades@hyades-agent` | Recommended in Claude Code. Kept in secure storage |
| `HYADES_API_KEY` | environment | Used when no plugin key is configured; the way to set the key in omp |
| `HYADES_KEY_FILE` | environment | Key file path; default `~/.omp/agent/hyades.key` |
| `HYADES_BASE_URL` | environment | Gateway URL; default `https://hyades.gnostr.cloud/v1` |
| `HYADES_OUTPUT_DIR` | environment | Where files are saved; default the working directory |
| `HYADES_3D_POLL_MS` | environment | 3D job poll interval; default 10000 |

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
MCP server). Uninstalling from Claude Code also removes the key it stored.

## Troubleshooting

| Symptom | Fix |
|:--|:--|
| `no_credential` | Set the key: `/plugin configure hyades@hyades-agent` |
| `unauthorized` | The key is wrong, revoked or rotated. Configure a new one. A key set in the plugin overrides `HYADES_API_KEY` and the key file |
| `forbidden` | Your key can't use that model. Ask Claude to run `list_models` |
| `rate_limited` | More than 2 requests in flight. Run image and 3D jobs one at a time |
| `backend_down` | The gateway's upstream is down. Retry later |
| `bad_args` | A path is wrong, or the file isn't a PNG, JPEG or WebP image |
| `plugin:hyades:gateway` shows **failed** in `claude mcp list` | `node` isn't on the `PATH` Claude Code sees, or is older than 18 |
| The skill or agent isn't used | Restart the session after installing or updating (omp: `/reload-plugins`); check `claude plugin list` or `omp plugin list` |

## How it behaves

| Behaviour | Why |
|:--|:--|
| Files are saved locally before a tool returns | Gateway result URLs expire |
| Files never overwrite each other | Names carry a timestamp and a random suffix, and are opened create-only |
| Only PNG, JPEG and WebP files (max 20 MB) are uploaded, judged by their content | A tricked request can't upload `~/.ssh/id_rsa` or `.env` as an "image" |
| `429` is retried with backoff, 4 times | The gateway allows 2 requests in flight per key |
| `ask_qwen` with `json_mode` uses a prompt, not `response_format` | The gateway answers `response_format` with empty content |
| 3D jobs are submitted once, then polled | Every submission is a new, billable job |
| A `User-Agent` header is always sent | Cloudflare blocks requests without one (`error code: 1010`) |

## Development

```
hyades-agent/
├── .claude-plugin/
│   ├── plugin.json               # plugin manifest: MCP server, API key setting
│   └── marketplace.json          # lets this repo be added as a marketplace
├── agents/visual-designer.md     # hyades:visual-designer
├── skills/using-hyades-tools/
│   ├── SKILL.md                  # routing table and error handling
│   └── tools-reference.md        # arguments, quality fields, error codes
├── mcp/
│   ├── hyades-server.mjs         # the MCP server (zero dependencies)
│   ├── smoke.mjs                 # live end-to-end check (makes billable calls)
│   └── test/offline.test.mjs     # tests against a fake gateway
└── assets/                       # banner and plugin icon
```

```bash
claude --plugin-dir .                     # run Claude Code with your working copy
claude plugin validate --strict .         # check the manifests
node --test mcp/test/*.test.mjs           # offline tests: no key, no network, no cost
node mcp/smoke.mjs                        # live check; uses your key and costs credits
```

Bump `version` in `.claude-plugin/plugin.json` for each release: installed copies stay on the
version they have until it changes.

### Verified (2026-11-15)

| Check | Result |
|:--|:--|
| Offline tests | 5/5: 3D polls once-submitted jobs and saves the model; non-images refused before upload; unique file names |
| Live: chat, JSON mode, image generate, edit, Clef, `403` | all as expected |
| Live: 3D | **not verified** — the gateway's 3D backend was down (`503`) |
| Claude Code: plugin install; key unset → key-file fallback; key set → used and overrides the file | as expected |
| omp: plugin install, server starts, live `list_models`; agent receives the skill and all six tools | as expected |
| Routing: 22 requests, headless, Hyades calls blocked | Claude Code 22/22, omp 22/22 to the expected tool, agent or no tool (the previous text missed 3 of 10 hard requests) |
| `visual-designer` end to end in Claude Code | made this README's banner: 2 generations, Clef self-checks, exact composited text |

## License

[MIT](LICENSE) © 2026 Traves Theberge. Covers this repo's code and docs. Using the Hyades
gateway requires your own API key and is subject to the gateway operator's terms.
