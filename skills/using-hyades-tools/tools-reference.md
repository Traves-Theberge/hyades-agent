# Hyades tool reference

Observations below were made live on 2026-11-15 unless marked otherwise. Authorization differs
per key, so confirm models with `list_models` rather than trusting this file.

## Tools

### `list_models`
No arguments. Returns `{ models: [ids] }`. Observed on one key: `qwen3.8-27b`,
`qwen3.8-27b-refusal-off`. Image and 3D models are not listed but still work if the key has
those capabilities.

### `ask_qwen`
| Argument | Notes |
|:--|:--|
| `messages` (required) | `[{role, content}]`, `content` is plain text |
| `model` | default `qwen3.8-27b`; `qwen3.8-27b-refusal-off` answers without refusals |
| `tools` | OpenAI-style function definitions; tool calls come back in `tool_calls` |
| `max_tokens` | qwen spends tokens on hidden reasoning first. Small values (≈20) can return an empty `content`; leave it unset unless you need a cap |
| `json_mode` | `true` → raw JSON in `content`. Use this instead of `response_format`, which the gateway answers with empty content |

Returns `{ content, tool_calls, finish_reason, usage, model }`.

### `generate_image`
| Argument | Notes |
|:--|:--|
| `prompt` (required) | Describe subject, palette (hex), composition. Add "no text, no letters" unless text is wanted: the model's own lettering is unreliable |
| `size` | default `1024x1024`; `1792x768` works for wide banners |
| `n` | number of images |
| `quality_check` | `true` runs the gateway's quality gate (adds ~1–60 s) |

Returns `{ saved_paths: [file], quality: [object|null] }`. Files are named
`hyades-img-gen-<timestamp>-<random>.png` in the working directory (or `HYADES_OUTPUT_DIR`).

**Quality fields**

| Field | Meaning | Act when |
|:--|:--|:--|
| `status` | `passed` or `flagged` (image is returned either way) | `flagged` → rework prompt |
| `score` | overall 0–1 | below ~0.7 → regenerate |
| `match_level` | prompt match 0–3 | below ~2.5 → sharpen prompt or regenerate |
| `artifact_probability` | 0–1, visual defects | above ~0.5 → regenerate |
| `safe_probability` | 0–1; below 0.5 is flagged for safety | rework prompt |
| `text_legible` | `correct`, `incorrect`, `not_applicable` | `incorrect` → generate without text, add real text afterwards |
| `attempts` | the gate may retry by itself (`2` ≈ +60 s) | normal, not an error |

### `edit_image`
`image_path` (local PNG/JPEG/WebP), `prompt` (the change), optional `size`, `quality_check`.
Works well for lighting and scene changes (night → sunny, scene → sunset). Returns the same
shape as generation; files are named `hyades-img-edit-…`.

### `ask_clef`
Clef System One: a fast (<1 s) scored judgment.

| Argument | Notes |
|:--|:--|
| `instructions` (required) | The question, e.g. "Does the image show an error state?" |
| `images` | local PNG/JPEG/WebP paths |
| `state` | object passed through to System One |
| `question` | answer key, default `q` |

Returns `{ answers: { <question>: { type: "noul", noul: <0–1> } }, usage }`. Observed: `noul`
0.994 for the clearly true statement "2+2=4". Treat it as a likelihood that the answer is yes.

### `generate_3d_model`
`prompt` **or** `image` (local PNG/JPEG/WebP), optional `remove_background`, `seed`, `steps`,
`response_format`, `timeoutMs` (default 600000). Submits once, then polls every 10 s until done.
Returns `{ saved_path, model_url, id }`; the model is saved as `hyades-3d-…` (`.glb` unless the
gateway returns another format).

Unverified: on 2026-11-15 the gateway's 3D backend was down (`backend_down`,
`generate3d_failed`), so a finished 3D response has not been observed live. The tool accepts
`model_url` at `data[0]`, top level or under `result`.

## Error codes

Every tool returns errors as `{ error, message, retryable }`.

| `error` | Cause | `retryable` |
|:--|:--|:--|
| `no_credential` | no key in the plugin settings, `HYADES_API_KEY` or `~/.omp/agent/hyades.key` | no |
| `unauthorized` | key missing, wrong or revoked (HTTP 401) | no |
| `forbidden` | key not allowed to use that model or path (HTTP 403) | no |
| `rate_limited` | more than 2 requests in flight (HTTP 429); already retried 4× with backoff | yes |
| `backend_down` | gateway's upstream unavailable (HTTP 503) | yes |
| `bad_args` | missing argument, path not found, not a regular file, not a PNG/JPEG/WebP image, or over 20 MB | no |
| `3d_failed` | gateway reported the 3D job failed | no |
| `timeout` | 3D job still running after `timeoutMs` | no |
| `unexpected_response` | 3D job finished without a model URL | no |
| `http_<status>` | any other HTTP failure | no |
| `internal` | bug in the server; the message has the stack | no |

## Limits

- 2 requests in flight per key. Run image and 3D jobs one at a time.
- Uploads: PNG, JPEG or WebP only, detected from file content, max 20 MB.
- Result URLs expire; the tools save files before returning.
