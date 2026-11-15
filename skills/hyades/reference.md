# Hyades — Endpoint Reference (verified 2026-11-15)

Base URL: `https://hyades.gnostr.cloud/v1`
Auth: `Authorization: Bearer <key>`. Key at `~/.omp/agent/hyades.key` (chmod 600).
**Every request must send a `User-Agent` header** or Cloudflare returns HTTP 403 `error code: 1010`.

## Models

| Model | Purpose | Status (2026-11-15) |
|---|---|---|
| `qwen3.8-27b` | chat / code / tool calls | 200 |
| `qwen3.8-27b-refusal-off` | same, no refusal | 200 |
| `qwen3.8-flash-next` | (was allowed earlier) | **403** — key swapped |
| `qwen-image-2.1` | image generation + editing | 200 |
| Claude models | — | 403 |
| `z-image-turbo` | — | 503 (backend down) |

Always confirm with `hyades_models` / `GET /v1/models` — authorization changes per key.

## Chat completions — `POST /chat/completions`

Standard OpenAI shape. Tool calls work (functions, multi-turn round-trip). Streaming works
(SSE, TTFB ~0.4s).

**JSON mode is broken**: `response_format: {"type":"json_object"}` (and `json_schema`) returns
empty `content` with `finish_reason: "stop"` and no `usage`. Workaround: add a system message
"Output only raw JSON, no prose, no code fences" and parse the content (strip fences if present).
The MCP `hyades_chat` does this via `json_mode: true`.

## Image generation — `POST /images/generations`

Body: `{model: "qwen-image-2.1", prompt, size?, n?, quality_check?}`. `size` default 1024x1024.
Response:
```json
{"data":[{"url":"https://hyades.gnostr.cloud/v1/images/content/<id>/0",
  "quality":{"status":"passed|flagged","attempts":1,"match_level":2.5,
  "artifact_probability":0.33,"safe_probability":0.93,"text_legible":"correct|incorrect|not_applicable",
  "score":0.82,"check_ms":2265,"check_tokens":3288}}]}
```
- **The `url` is a temporary hosted link — download it immediately** (no base64 in the response).
- With `quality_check: true` the quality gate may **self-retry** (`attempts: 2`, ~60s extra latency).
- `status: "flagged"` means safety or prompt-match concern; the image is still returned.
  `safe_probability < 0.5` → flagged for safety (e.g. nude imagery).
- `match_level` 0–3 (higher = closer to prompt); `score` overall 0–1.

## Image edit — `POST /images/edits`

Same body plus the source image. Edit works well for lighting/scene changes (e.g. night→sunny).
Response shape identical to generations.

## Clef System One — `POST /v1/systemone`

Body:
```json
{
  "state": { },
  "images": ["data:image/png;base64,..."],
  "questions": {"q": {"type": "noul", "instructions": "..."}}
}
```
- `images` entries **must be data URLs**, not https URLs (URL → 400).
- Wrong/missing model context → 400. No/invalid bearer → 401.
- 200 returns the decision: score, choice, noul + probabilities. Fast (~0.6s).
- The `state` payload is System One's own structure; pass whatever the decision requires.

## 3D generation — `POST /v1/3d/generations`

Body: `{prompt}` or `{image_url}`; optional `remove_background`, `seed`, `steps`, `response_format`.
- `200` → `{data:[{model_url}]}` (sync).
- `202` → `{id, status, poll:"/v1/3d/generations/<id>"}` — poll `poll` (GET, bearer) until done. Can take minutes.
- Requires the `generate3d` capability on the key.

## Error contract

| Status | Meaning | Retry? |
|---|---|---|
| 401 | no/invalid bearer | fix key |
| 403 | model not authorized for this key (`this key is not authorized for model 'X'`) | different model |
| 403 `error code: 1010` | Cloudflare blocked (missing/wrong User-Agent) | set User-Agent |
| 429 | `tenant concurrency limit exceeded` (2 in-flight turns/silo) | **yes** — back off, serialize |
| 400 | bad request (Clef URL image, wrong model) | fix body |
| 503 | upstream backend down (`images_failed`, `Connection refused ...`) | **yes** — transient |

## Key rotation

Key was pasted in chat → rotate if it matters: `POST /admin/keys/travis/rotate`
(ask XenonFun). After rotation, replace `~/.omp/agent/hyades.key`; nothing else to change.

## Concurrency / rate

2 simultaneous turns per silo. Run image jobs one at a time. The MCP server retries 429 with
backoff (2.5s·n, up to 4 tries) but a sustained flood still stalls — don't parallelize images.
