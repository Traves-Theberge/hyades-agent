---
name: hyades
description: Use when a task involves calling the Hyades AI gateway — qwen chat/LLM, image generation or editing, Clef System One decisions, or 3D model generation. Triggers on "hyades", "qwen", "clef", "system one", image generation with quality checks, or the hyades_*/hyades MCP tools.
---

# Hyades gateway

Hyades (https://hyades.gnostr.cloud) is an OpenAI-compatible gateway fronted by Cloudflare.
This repo registers it as an MCP server exposing five tools:

- `hyades_models` — list model ids this key is authorized for
- `hyades_chat` — qwen chat/completions (chat, code, tool calls, JSON mode)
- `hyades_image_generate` — qwen-image-2.1 generation (+ optional quality check), saves to disk
- `hyades_image_edit` — qwen-image-2.1 edit of a local image, saves to disk
- `hyades_clef` — Clef System One decision endpoint (`POST /v1/systemone`)
- `hyades_3d_generate` — 3D model generation (sync 200 or async 202 + polling)

Prefer calling these tools over hand-writing `curl`. The MCP server already handles the
three things that bite: Cloudflare User-Agent, 429 retry, and saving ephemeral image URLs.

## Quick start

- Chat/code: `hyades_chat({ model: "qwen3.8-27b", messages: [...] })`
- Uncensored (no refusal): use `model: "qwen3.8-27b-refusal-off"`
- JSON output: `hyades_chat({ ..., json_mode: true })`
- Image: `hyades_image_generate({ prompt: "...", quality_check: true })` → returns `saved_paths`
- Decision: `hyades_clef({ state: {...}, question: "q", instructions: "..." })`

## Pitfalls (must-know)

1. **JSON mode is broken upstream.** `response_format` returns empty content. Always use the
   `json_mode: true` workaround (prompt-based). Never set `response_format` yourself.
2. **Image URLs are temporary.** The server downloads them to `saved_paths` for you. If you ever
   get a raw URL, download it immediately.
3. **Concurrency limit = 2 in-flight turns** per silo. Extra parallel requests → `429
   tenant concurrency limit exceeded`. Serialize parallel image jobs; the tool retries 429, but
   a flood still stalls.
4. **User-Agent.** Cloudflare rejects the default UA with `error code: 1010`. The MCP server
   sends one; if you hand-craft a request, set `User-Agent`.
5. **Quality check semantics** — see reference.md for the full field table and error contract.

## Where things live

- API key: `~/.omp/agent/hyades.key` (chmod 600). Rotate with XenonFun if exposed.
- Key is never printed in tool output.
- Full endpoint reference, error codes, and quality-check field semantics: `reference.md` (same dir).
