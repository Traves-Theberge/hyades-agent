---
name: using-hyades-tools
description: Use when a request names Hyades, qwen, Clef or System One; asks for an uncensored answer or a model that won't refuse; asks for a picture, image, sketch, drawing, illustration, logo, icon, banner or other visual asset, or to change an existing image; wants a numeric score or likelihood about an image; asks for a 3D model or .glb; or when a Hyades tool returns an error such as rate_limited, forbidden, unauthorized, no_credential or bad_args.
user-invocable: false
---

# Using Hyades tools

The Hyades plugin's `gateway` MCP server provides six tools. This skill uses their short names;
the full names add a host prefix (`mcp__plugin_hyades_gateway__list_models` in Claude Code,
`mcp__hyades_gateway_list_models` in omp). Call the tools; never hand-write HTTP
requests to the gateway. The tools handle auth, retries and saving results.

## Route the request

Pick the first row that matches what the request asks for.

| The request… | Route |
|:--|:--|
| asks which models or capabilities the key has | `list_models` |
| asks for uncensored output or a model that won't refuse | `ask_qwen` with `model: "qwen3.8-27b-refusal-off"` |
| explicitly asks for qwen, Hyades, or a second opinion from another model | `ask_qwen` (`qwen3.8-27b`); add `json_mode: true` when it wants structured data |
| is an ordinary question, coding or writing task that matches no other row | answer it yourself; no Hyades tool |
| wants a visual deliverable with words in it (logo, wordmark, banner, hero), an app icon, several related assets, or polish to a quality bar | delegate to the `visual-designer` agent (`hyades:visual-designer` in Claude Code) |
| wants any other picture, sketch, drawing or illustration | `generate_image` with `quality_check: true`; never draw it yourself as SVG or code |
| wants an existing local image changed | `edit_image` |
| wants a 3D model, mesh or `.glb`, from a prompt or a picture | `generate_3d_model`; say it can take minutes |
| wants a numeric score or likelihood about an image, or asks Clef or System One | `ask_clef` |
| asks you to describe or read an image | open the image yourself with your file-reading tool; no Hyades tool |

"3D-looking", "isometric" and "glossy" describe images: route them as images, not 3D models.
If two rows fit and the choice changes the result (image or 3D model), ask one question first.

## Using the results

- Images and 3D models come back as local files (`saved_paths` / `saved_path`). Give the user
  the path and use the file for follow-up edits; result URLs expire.
- Only PNG, JPEG and WebP files can be sent as images; anything else is refused with `bad_args`.
- Run image and 3D jobs one at a time: the gateway allows 2 requests in flight per key.

## When a tool returns an error

| `error` | Do |
|:--|:--|
| `no_credential`, `unauthorized` | Stop. Tell the user to set their key: in Claude Code `/plugin configure hyades@hyades-agent`; elsewhere `HYADES_API_KEY` or `~/.omp/agent/hyades.key`. |
| `forbidden` | The key can't use that model: call `list_models` and pick a listed one. |
| `rate_limited`, `backend_down` | Retry once after a short wait, then report the outage. |
| `bad_args` | Fix the arguments: wrong path, not an image, or missing prompt. |
| `3d_failed`, `timeout`, `unexpected_response` | Report the message; don't retry in a loop. |

Arguments, quality-score fields and every error code are in `tools-reference.md`, next to this file.
