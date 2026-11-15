#!/usr/bin/env bash
# Install the Hyades agent into Claude Code (user scope).
# - copies the skill + subagent into ~/.claude
# - registers the MCP server (node, zero deps)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

echo "Installing Hyades agent from: $ROOT"
echo "Claude dir: $CLAUDE_DIR"

# 0. Node >= 18 (the server uses the built-in fetch)
if ! command -v node >/dev/null 2>&1; then
  echo "  [error] node not found on PATH — install Node.js 18 or newer." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  [error] node $(node -v) is too old — Node.js 18 or newer is required." >&2
  exit 1
fi
echo "  [ok] node $(node -v)"

# 1. Skill
mkdir -p "$CLAUDE_DIR/skills/hyades"
cp "$ROOT/skills/hyades/SKILL.md" "$ROOT/skills/hyades/reference.md" "$CLAUDE_DIR/skills/hyades/"
echo "  [ok] skill -> $CLAUDE_DIR/skills/hyades/"

# 2. Subagent
mkdir -p "$CLAUDE_DIR/agents"
cp "$ROOT/agents/hyades-media.md" "$CLAUDE_DIR/agents/"
echo "  [ok] subagent -> $CLAUDE_DIR/agents/hyades-media.md"

# 3. MCP server
mkdir -p "$CLAUDE_DIR/mcp/hyades"
cp "$ROOT/mcp/hyades-server.mjs" "$CLAUDE_DIR/mcp/hyades/"
echo "  [ok] mcp server -> $CLAUDE_DIR/mcp/hyades/"

# 4. Register MCP under node. Node is used rather than bun because on WSL a Windows bun on PATH
#    resolves the home directory to C:\Users\..., where the key file isn't.
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user hyades 2>/dev/null || true
  claude mcp add --scope user --transport stdio hyades \
    "node" "$CLAUDE_DIR/mcp/hyades/hyades-server.mjs"
  echo "  [ok] mcp registered: hyades (stdio, node)"
else
  echo "  [skip] 'claude' not on PATH — register manually:"
  echo "    claude mcp add --scope user --transport stdio hyades node $CLAUDE_DIR/mcp/hyades/hyades-server.mjs"
fi

# 5. Key presence check
KEY="${HYADES_KEY_FILE:-$HOME/.omp/agent/hyades.key}"
if [ -n "${HYADES_API_KEY:-}" ]; then
  echo "  [ok] HYADES_API_KEY is set in this shell (make sure Claude Code is started from an environment that has it)"
elif [ -f "$KEY" ]; then
  echo "  [ok] key file present at $KEY"
else
  echo "  [warn] no key found — create $KEY (chmod 600) or set HYADES_API_KEY. See README → Setup."
fi

echo "Done. Verify with: claude mcp list"
