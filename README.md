# hyades-agent

Claude Code integration for the [Hyades](https://hyades.gnostr.cloud) AI gateway: qwen LLM,
qwen-image-2.1 generation/editing with quality checks, Clef System One decisions, and 3D
model generation — all as MCP tools plus a skill and a media subagent.

## What's in the box

| Path | Purpose |
|---|---|
| `mcp/hyades-server.mjs` | MCP stdio server (zero deps, Node ≥ 18 / Bun). Tools: `hyades_models`, `hyades_chat`, `hyades_image_generate`, `hyades_image_edit`, `hyades_clef`, `hyades_3d_generate` |
| `skills/hyades/` | `SKILL.md` + `reference.md` — endpoint contracts, error table, pitfalls |
| `agents/hyades-media.md` | Subagent: image/brand specialist (gen → quality-score iteration → exact-text compositing → vision verification) |
| `install.sh` | Copies skill+agent into `~/.claude` and registers the MCP server (user scope) |
| `mcp/smoke.mjs` | stdio smoke test for the server |

## Install

```bash
./install.sh          # user scope: any Claude Code session gets it
```

Requires a key at `~/.omp/agent/hyades.key` (chmod 600) or `HYADES_API_KEY` in the environment.
Runner is `node` by default (deliberate: `bun` on this machine is the Windows build and cannot
read the WSL key path).

## Verify

```bash
claude mcp list                                  # "hyades: ... - ✓ connected"
node mcp/smoke.mjs                               # e2e: models/chat/image/edit/clef/403
claude -p "which hyades models can I use?"       # skill discovery
```

## Notes

- 2 in-flight turns per silo → image jobs are serialized by design.
- Image URLs are ephemeral; the server saves files before returning.
- Hyades `response_format` JSON mode is broken; `hyades_chat(json_mode: true)` uses the
  prompt workaround.
- 3D generation can run async (202 + polling, up to 10 min by default).

## Repo layout (private, for sharing)

This folder is the source of truth. `~/.claude/...` copies are produced by `install.sh`;
re-run it after any change. The key never leaves `~/.omp/agent/hyades.key`.
