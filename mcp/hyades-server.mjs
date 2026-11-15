#!/usr/bin/env node
// Hyades MCP server: stdio, zero dependencies, Node >= 18.
//
// Exposes the hyades.gnostr.cloud gateway as tools: qwen chat, image generation and editing with
// an optional quality check, Clef System One decisions, 3D model generation and model listing.
//
// Protocol: MCP (JSON-RPC 2.0 over stdio, newline-delimited).
// Errors are returned as tool *results* with isError=true, never as protocol
// errors — the calling agent can read and react to them.

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const BASE = process.env.HYADES_BASE_URL ?? "https://hyades.gnostr.cloud/v1";
const UA = "hyades-claude-plugin/1.0";

// Key sources, first match wins:
//   1. HYADES_PLUGIN_API_KEY — the Claude Code plugin's saved `api_key` option
//   2. HYADES_API_KEY        — the user's environment
//   3. HYADES_KEY_FILE, then ~/.omp/agent/hyades.key
// The plugin option has its own variable so an unset option can't mask a user's HYADES_API_KEY.
// Hosts that don't fill in the option (unset in Claude Code, or omp) pass it empty or as the
// literal "${user_config.api_key}"; both count as unset.
function envValue(name) {
  const v = process.env[name]?.trim();
  return v && !v.startsWith("${") ? v : null;
}

function getKey() {
  const fromEnv = envValue("HYADES_PLUGIN_API_KEY") ?? envValue("HYADES_API_KEY");
  if (fromEnv) return fromEnv;
  const files = [process.env.HYADES_KEY_FILE, join(process.env.HOME ?? homedir(), ".omp/agent/hyades.key")];
  for (const p of files) if (p && existsSync(p)) return readFileSync(p, "utf8").trim();
  throw new HyadesError(
    "no_credential",
    "No Hyades API key. In Claude Code run `/plugin configure hyades@hyades-agent`; anywhere else set " +
      "HYADES_API_KEY or put the key in ~/.omp/agent/hyades.key (chmod 600).",
  );
}

class HyadesError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// POST JSON when `body` is given, otherwise GET. `path` is relative to BASE or an absolute URL.
async function hyades(path, body, { timeoutMs = 240000, expect = 200 } = {}) {
  const res = await fetch(path.startsWith("http") ? path : BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Authorization: `Bearer ${getKey()}`,
      "User-Agent": UA, // Cloudflare blocks default UAs with error 1010
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) {
    // Concurrency/rate limit (2 simultaneous turns per silo): retryable.
    const err = new HyadesError("rate_limited", "429: tenant concurrency limit exceeded — too many in-flight turns");
    err.retryable = true;
    throw err;
  }
  if (res.status === 401) {
    throw new HyadesError("unauthorized", "401: key rejected (missing or invalid bearer)");
  }
  if (res.status === 403) {
    const t = await res.text().catch(() => "");
    throw new HyadesError("forbidden", `403: this key is not authorized for the requested model/path. ${t.slice(0, 200)}`);
  }
  if (res.status === 503) {
    const t = await res.text().catch(() => "");
    const err = new HyadesError("backend_down", `503: upstream backend unavailable. ${t.slice(0, 200)}`);
    err.retryable = true; // an outage, not a bad request: retrying later can succeed
    throw err;
  }
  const okStatuses = Array.isArray(expect) ? expect : [expect];
  if (!okStatuses.includes(res.status)) {
    const t = await res.text().catch(() => "");
    throw new HyadesError(`http_${res.status}`, `HTTP ${res.status} on ${path}: ${t.slice(0, 400)}`);
  }
  return res.json();
}

async function retry429(fn, retries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e?.code === "rate_limited" && i < retries) {
        await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

// ---------- tool implementations ----------

async function tModels() {
  const j = await retry429(() => hyades("/models"));
  return { models: (j.data ?? []).map((m) => m.id) };
}

// ---------- files ----------

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// Every tool argument that names a local file is uploaded to the gateway. Only real image content
// may leave the machine, so a prompt-injected path such as ~/.ssh/id_rsa or .env is refused before
// any request is made. The type comes from the bytes, never from the file extension.
function imageDataUrl(path, field) {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new HyadesError("bad_args", `${field} does not exist: ${path ?? "(missing)"}`);
  }
  if (!st.isFile()) throw new HyadesError("bad_args", `${field} is not a regular file: ${path}`);
  if (st.size > MAX_UPLOAD_BYTES) throw new HyadesError("bad_args", `${field} is larger than 20 MB: ${path}`);
  const buf = readFileSync(path);
  const mime = sniffImage(buf);
  if (!mime) throw new HyadesError("bad_args", `${field} is not a PNG, JPEG or WebP image: ${path}`);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// Result URLs are temporary, so results are written to disk before the tool returns. The `wx`
// flag makes writing fail rather than replace an existing file; on a name clash we pick another.
function writeUnique(buf, prefix, ext) {
  const outDir = process.env.HYADES_OUTPUT_DIR ?? process.cwd();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  for (;;) {
    const p = join(outDir, `${prefix}-${stamp}-${randomBytes(3).toString("hex")}${ext}`);
    try {
      writeFileSync(p, buf, { flag: "wx" });
      return p;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

async function download(url) {
  const headers = { "User-Agent": UA };
  // The key only ever goes to the gateway's own host.
  if (new URL(url).origin === new URL(BASE).origin) headers.Authorization = `Bearer ${getKey()}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new HyadesError(`http_${res.status}`, `Failed to download result: HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "" };
}

async function tChat({ model = "qwen3.8-27b", messages, tools, max_tokens, json_mode }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HyadesError("bad_args", "messages must be a non-empty array of {role, content}");
  }
  const body = { model, messages };
  if (tools?.length) body.tools = tools;
  if (max_tokens) body.max_tokens = max_tokens;
  if (json_mode) {
    // Hyades response_format is broken (returns empty content); use the
    // prompt-based workaround instead.
    body.messages = [
      { role: "system", content: "Output only raw JSON, no prose, no code fences." },
      ...messages,
    ];
  }
  const j = await retry429(() => hyades("/chat/completions", body));
  const m = j.choices?.[0]?.message ?? {};
  return {
    content: m.content ?? "",
    tool_calls: m.tool_calls ?? null,
    finish_reason: j.choices?.[0]?.finish_reason ?? null,
    usage: j.usage ?? null,
    model: j.model,
  };
}

async function saveImage(data, suffix) {
  let buf;
  if (data.url) buf = (await download(data.url)).buf;
  else if (data.b64_json) buf = Buffer.from(data.b64_json, "base64");
  else return null;
  return writeUnique(buf, `hyades-img-${suffix}`, IMAGE_EXT[sniffImage(buf)] ?? ".png");
}

async function tImageGenerate({ prompt, size = "1024x1024", n = 1, quality_check = false }) {
  if (!prompt) throw new HyadesError("bad_args", "prompt is required");
  const j = await retry429(() => hyades("/images/generations", { model: "qwen-image-2.1", prompt, size, n, quality_check }));
  const items = j.data ?? [];
  const saved = [];
  for (const d of items) saved.push(await saveImage(d, "gen"));
  return {
    saved_paths: saved.filter(Boolean),
    // Hosted URLs are temporary — the saved files are the durable copies.
    quality: items.map((d) => d.quality ?? null),
    note: quality_check
      ? "quality.status: passed|flagged (flagged = safety or match concern, image still returned)"
      : undefined,
  };
}

async function tImageEdit({ image_path, prompt, size = "1024x1024", quality_check = false }) {
  const image = imageDataUrl(image_path, "image_path");
  if (!prompt) throw new HyadesError("bad_args", "prompt is required");
  const j = await retry429(() => hyades("/images/edits", { model: "qwen-image-2.1", prompt, size, quality_check, image }));
  const items = j.data ?? [];
  const saved = [];
  for (const d of items) saved.push(await saveImage(d, "edit"));
  return { saved_paths: saved.filter(Boolean), quality: items.map((d) => d.quality ?? null) };
}

async function tClef({ state = {}, images = [], question = "q", instructions }) {
  const dataUrls = images.map((p, i) => imageDataUrl(p, `images[${i}]`));
  const j = await retry429(() =>
    hyades("/systemone", {
      state,
      images: dataUrls,
      questions: { [question]: { type: "noul", instructions: instructions ?? `Answer question "${question}".` } },
    }),
  );
  return j;
}

const POLL_MS = Number(process.env.HYADES_3D_POLL_MS) || 10000;
const DONE = new Set(["completed", "complete", "succeeded", "success", "done"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);
const MODEL_EXT = new Set([".glb", ".gltf", ".obj", ".fbx", ".usdz", ".ply", ".stl"]);

const modelUrlOf = (j) => j.data?.[0]?.model_url ?? j.model_url ?? j.result?.data?.[0]?.model_url ?? j.result?.model_url;

function modelExt(url, buf, type) {
  if (buf.subarray(0, 4).toString("ascii") === "glTF" || type.includes("gltf-binary")) return ".glb";
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  return MODEL_EXT.has(fromUrl) ? fromUrl : ".glb";
}

async function t3dGenerate({ prompt, image, remove_background, seed, steps, response_format, timeoutMs = 600000 }) {
  if (!prompt && !image) throw new HyadesError("bad_args", "provide prompt or image (local path to a source image)");
  const body = {};
  if (prompt) body.prompt = prompt;
  if (image) body.image_url = imageDataUrl(image, "image");
  for (const [k, v] of [
    ["remove_background", remove_background],
    ["seed", seed],
    ["steps", steps],
    ["response_format", response_format],
  ])
    if (v !== undefined) body[k] = v;

  // Submit exactly once (each POST is a new billable job), then poll the job URL with GET.
  let j = await retry429(() => hyades("/3d/generations", body, { expect: [200, 202], timeoutMs: 300000 }));
  // `poll` is root-relative ("/v1/3d/generations/<id>"); resolve it against the origin, not BASE + path.
  const pollUrl = j.poll ? new URL(j.poll, BASE).href : j.id ? `${BASE}/3d/generations/${j.id}` : null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const url = modelUrlOf(j);
    if (url) {
      // The model URL is likely as temporary as image URLs, so keep a local copy.
      const { buf, type } = await download(url);
      return { saved_path: writeUnique(buf, "hyades-3d", modelExt(url, buf, type)), model_url: url, id: j.id ?? null };
    }
    const status = String(j.status ?? "").toLowerCase();
    if (FAILED.has(status)) throw new HyadesError("3d_failed", `3D generation ${status}: ${JSON.stringify(j).slice(0, 300)}`);
    if (DONE.has(status) || !pollUrl)
      throw new HyadesError("unexpected_response", `3D response has no model_url to download: ${JSON.stringify(j).slice(0, 300)}`);
    if (Date.now() > deadline)
      throw new HyadesError("timeout", `3D job ${j.id} still ${status} after ${timeoutMs / 1000}s (poll: ${pollUrl})`);
    await new Promise((r) => setTimeout(r, POLL_MS));
    j = await retry429(() => hyades(pollUrl));
  }
}

// ---------- MCP plumbing ----------

// `description` is what the model reads when choosing a tool: say what it does and when to use it.
// `title` is the human label clients show. All tools call an external service (openWorldHint).
const TOOLS = [
  {
    name: "list_models",
    title: "Hyades: list models",
    description: "List the chat model ids this Hyades API key may use. Use when asked what models or capabilities are available, or after a `forbidden` error to pick an allowed model.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ask_qwen",
    title: "Hyades: ask qwen",
    description:
      "Send a conversation to a qwen model on the Hyades gateway and return its reply. Use only when the user explicitly asks for qwen, Hyades, " +
      "a second opinion from another model, or uncensored output (model qwen3.8-27b-refusal-off). Answer ordinary questions yourself instead.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          description: "Conversation in OpenAI format; content is plain text.",
          items: {
            type: "object",
            properties: { role: { type: "string", enum: ["system", "user", "assistant", "tool"] }, content: { type: "string" } },
            required: ["role", "content"],
          },
        },
        model: { type: "string", description: "qwen3.8-27b (default) or qwen3.8-27b-refusal-off for answers without refusals." },
        json_mode: { type: "boolean", description: "true to get raw JSON back in content. Use this, not response_format, which the gateway answers with empty content." },
        tools: { type: "array", description: "Optional OpenAI-style function definitions; calls come back in tool_calls." },
        max_tokens: { type: "number", description: "Optional reply cap. qwen reasons before answering, so small values (around 20) can return empty content." },
      },
      required: ["messages"],
    },
  },
  {
    name: "generate_image",
    title: "Hyades: generate image",
    description:
      "Generate images with qwen-image-2.1 and save them as local files; returns saved_paths and optional quality scores. Use for new pictures, " +
      "illustrations, icons or artwork. For logos, banners, icons or anything with exact text, prefer delegating to the visual-designer agent.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Subject, palette (hex), composition. Add 'no text, no letters' unless the model should draw text." },
        size: { type: "string", description: "WIDTHxHEIGHT, default 1024x1024; 1792x768 works for wide banners." },
        n: { type: "number", description: "Number of images, default 1." },
        quality_check: { type: "boolean", description: "true to score each image (status, score, match_level, artifact and safety probabilities). Adds up to ~60 s." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    title: "Hyades: edit image",
    description:
      "Change an existing local image with qwen-image-2.1 (lighting, scene, adding or removing elements) and save the result as a new local file. " +
      "Use when the user supplies an image and wants it altered.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "Local PNG, JPEG or WebP file to edit (max 20 MB). Other files are refused." },
        prompt: { type: "string", description: "The change to make, e.g. 'make the scene a bright sunny morning'." },
        size: { type: "string", description: "Output WIDTHxHEIGHT, default 1024x1024." },
        quality_check: { type: "boolean", description: "true to score the result." },
      },
      required: ["image_path", "prompt"],
    },
  },
  {
    name: "ask_clef",
    title: "Hyades: Clef decision",
    description:
      "Ask Clef System One a yes/no question, optionally about local images; returns a 0–1 likelihood (noul) in under a second. " +
      "Use when the user asks for Clef or System One, or needs a numeric score. To describe an image, read it yourself instead.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        instructions: { type: "string", description: "The question, e.g. 'Does the image show an error state?'" },
        images: { type: "array", items: { type: "string" }, description: "Local PNG, JPEG or WebP paths to judge." },
        state: { type: "object", description: "Optional context object passed through to System One." },
        question: { type: "string", description: "Key for the answer in the result, default 'q'." },
      },
      required: ["instructions"],
    },
  },
  {
    name: "generate_3d_model",
    title: "Hyades: generate 3D model",
    description:
      "Generate a 3D model from a text prompt or a local image and save it as a local file (usually .glb). Takes minutes; waits until done. " +
      "Use only when the user wants an actual 3D model or mesh, not an image that merely looks 3D.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to model. Give either prompt or image." },
        image: { type: "string", description: "Local PNG, JPEG or WebP to turn into a model. Give either prompt or image." },
        remove_background: { type: "boolean", description: "Remove the source image background first." },
        seed: { type: "number", description: "Seed for reproducible results." },
        steps: { type: "number", description: "Generation steps (more is slower)." },
        response_format: { type: "string", description: "Passed through to the gateway." },
        timeoutMs: { type: "number", description: "How long to wait for the job, default 600000 (10 min)." },
      },
    },
  },
];

const IMPLS = {
  list_models: tModels,
  ask_qwen: tChat,
  generate_image: tImageGenerate,
  edit_image: tImageEdit,
  ask_clef: tClef,
  generate_3d_model: t3dGenerate,
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function toolResult(payload) {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "hyades-gateway", version: "1.0.0" },
        instructions:
          "Tools for the Hyades gateway: qwen chat, image generation and editing, Clef decisions and 3D models. " +
          "The using-hyades-tools skill says which tool fits a request and how to handle each error code.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const fn = IMPLS[params?.name];
      if (!fn) {
        return { content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true };
      }
      try {
        return toolResult(await fn(params?.arguments ?? {}));
      } catch (e) {
        if (e instanceof HyadesError) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: e.code, message: e.message, retryable: !!e.retryable }, null, 2) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "internal", message: String(e?.stack ?? e) }, null, 2) }],
          isError: true,
        };
      }
    }
    default:
      if (id === undefined || id === null) return undefined; // notification
      return { code: -32601, message: `Method not found: ${method}` };
  }
}

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg)
      .then((result) => {
        if (result !== undefined && msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
      })
      .catch((e) => {
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e?.message ?? e) } });
      });
  }
});
