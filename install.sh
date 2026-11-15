#!/usr/bin/env bash
# Install the Hyades agent into Claude Code (user scope).
# - copies the skill + subagent into ~/.claude
# - registers the MCP server (node, zero deps)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

echo "Installing Hyades agent from: $ROOT"
echo "Claude dir: $CLAUDE_DIR"

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

# 4. Register MCP (node — bun on this box is the Windows build and can't see the WSL key)
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
KEY="$HOME/.omp/agent/hyades.key"
if [ -f "$KEY" ]; then
  echo "  [ok] key present at $KEY"
else
  echo "  [warn] no key at $KEY — set HYADES_API_KEY or place the key there (chmod 600)."
fi

echo "Done. Verify with: claude mcp list"
