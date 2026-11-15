#!/usr/bin/env bun
// Hyades MCP server — stdio, zero dependencies (Node >= 18 / Bun).
//
// Exposes the hyades.gnostr.cloud OpenAI-compatible endpoints as tools for
// Claude Code: chat (qwen), image generation/editing with optional quality
// check, Clef System One decisions, and model listing.
//
// Protocol: MCP (JSON-RPC 2.0 over stdio, newline-delimited).
// Errors are returned as tool *results* with isError=true, never as protocol
// errors — the calling agent can read and react to them.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = process.env.HYADES_BASE_URL ?? "https://hyades.gnostr.cloud/v1";
const UA = "claude-code-hyades-mcp/1.0";

function keyCandidates() {
  const c = [];
  if (process.env.HYADES_KEY_FILE) c.push(process.env.HYADES_KEY_FILE);
  c.push(join(homedir(), ".omp/agent/hyades.key"));
  // bun on WSL may resolve homedir() to the Windows profile, not $HOME
  if (process.env.HOME) c.push(join(process.env.HOME, ".omp/agent/hyades.key"));
  // a Windows-side home may live under /mnt/c
  const win = process.env.USERPROFILE;
  if (win) c.push(win.replace(/\\/g, "/").replace(/^\/?C:/, "/mnt/c") + "/.omp/agent/hyades.key");
  // bun launched from a Windows shell may only reach WSL via UNC path
  const u = process.env.USER;
  if (u) c.push(`\\\\wsl.localhost\\Ubuntu\\home\\${u}\\.omp\\agent\\hyades.key`);
  try {
    for (const user of readdirSync("/mnt/c/Users")) {
      if (user.toLowerCase() === "public" || user.startsWith("all users") || user.startsWith("default")) continue;
      c.push(`/mnt/c/Users/${user}/.omp/agent/hyades.key`);
    }
  } catch {
    /* not on a WSL/Windows mount; ignore */
  }
  return c;
}

function getKey() {
  if (process.env.HYADES_API_KEY) return process.env.HYADES_API_KEY.trim();
  for (const p of keyCandidates()) {
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  }
  throw new HyadesError(
    "no_credential",
    `No API key found. Set HYADES_API_KEY (or HYADES_KEY_FILE) or put the key in ~/.omp/agent/hyades.key (chmod 600). ` +
      "Ask XenonFun for a rotated key if it was ever pasted in chat: POST /admin/keys/travis/rotate",
  );
}

class HyadesError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function hyades(path, body, { timeoutMs = 240000, expect = 200 } = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getKey()}`,
      "User-Agent": UA, // Cloudflare blocks default UAs with error 1010
    },
    body: JSON.stringify(body),
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
    throw new HyadesError("backend_down", `503: upstream backend unavailable. ${t.slice(0, 200)}`);
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
  const res = await retry429(() => fetch(BASE + "/models", { headers: { Authorization: `Bearer ${getKey()}`, "User-Agent": UA } }));
  if (!res.ok) throw new HyadesError(`http_${res.status}`, `HTTP ${res.status} on /models: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { models: (j.data ?? []).map((m) => m.id) };
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
  const outDir = process.env.HYADES_OUTPUT_DIR ?? process.cwd();
  const i = (Date.now() % 100000).toString().padStart(5, "0");
  const p = join(outDir, `hyades-img-${i}-${suffix}.png`);
  if (data.url) {
    const res = await fetch(data.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new HyadesError(`http_${res.status}`, `Failed to download image URL: HTTP ${res.status}`);
    writeFileSync(p, Buffer.from(await res.arrayBuffer()));
  } else if (data.b64_json) {
    writeFileSync(p, Buffer.from(data.b64_json, "base64"));
  } else {
    return null;
  }
  return p;
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
  if (!image_path || !existsSync(image_path)) {
    throw new HyadesError("bad_args", `image_path does not exist: ${image_path ?? "(missing)"}`);
  }
  if (!prompt) throw new HyadesError("bad_args", "prompt is required");
  const b64 = readFileSync(image_path).toString("base64");
  const mime = image_path.toLowerCase().endsWith(".jpg") || image_path.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
  const j = await retry429(() => hyades("/images/edits", { model: "qwen-image-2.1", prompt, size, quality_check, image: `data:${mime};base64,${b64}` }));
  const items = j.data ?? [];
  const saved = [];
  for (const d of items) saved.push(await saveImage(d, "edit"));
  return { saved_paths: saved.filter(Boolean), quality: items.map((d) => d.quality ?? null) };
}

async function tClef({ state = {}, images = [], question = "q", instructions }) {
  const dataUrls = images.map((p) => {
    if (!existsSync(p)) throw new HyadesError("bad_args", `image file does not exist: ${p}`);
    const mime = p.toLowerCase().endsWith(".jpg") || p.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
  });
  const j = await retry429(() =>
    hyades("/systemone", {
      state,
      images: dataUrls,
      questions: { [question]: { type: "noul", instructions: instructions ?? `Answer question "${question}".` } },
    }),
  );
  return j;
}

async function t3dGenerate({ prompt, image, remove_background, seed, steps, response_format, timeoutMs = 600000 }) {
  if (!prompt && !image) throw new HyadesError("bad_args", "provide prompt or image (local path to a source image)");
  const body = {};
  if (prompt) body.prompt = prompt;
  if (image) {
    if (!existsSync(image)) throw new HyadesError("bad_args", `image does not exist: ${image}`);
    const mime = image.toLowerCase().endsWith(".jpg") || image.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png";
    body.image_url = `data:${mime};base64,${readFileSync(image).toString("base64")}`;
  }
  for (const [k, v] of [
    ["remove_background", remove_background],
    ["seed", seed],
    ["steps", steps],
    ["response_format", response_format],
  ])
    if (v !== undefined) body[k] = v;

  const done = new Set(["completed", "complete", "succeeded", "success", "done"]);
  const deadline = Date.now() + timeoutMs;
  let j;
  for (;;) {
    j = await retry429(() => hyades("/3d/generations", body, { expect: [200, 202], timeoutMs: 300000 }));
    if (j.data?.[0]?.model_url) return { model_url: j.data[0].model_url };
    if (j.id && j.status) {
      if (done.has(String(j.status).toLowerCase())) return { id: j.id, status: j.status, result: j };
      if (String(j.status).toLowerCase() === "failed") throw new HyadesError("3d_failed", `3D generation failed: ${JSON.stringify(j).slice(0, 300)}`);
      if (Date.now() > deadline) throw new HyadesError("timeout", `3D generation still ${j.status} after ${timeoutMs / 1000}s; last state: ${JSON.stringify(j).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 10000));
      const res = await fetch(BASE + (j.poll ?? `/3d/generations/${j.id}`), {
        headers: { Authorization: `Bearer ${getKey()}`, "User-Agent": UA },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new HyadesError(`http_${res.status}`, `3D poll HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    return j;
  }
}

// ---------- MCP plumbing ----------

const TOOLS = [
  {
    name: "hyades_models",
    description: "List the model ids this API key is actually authorized for on Hyades.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hyades_chat",
    description:
      "Chat/completions via Hyades qwen models. Use for quick Q&A, code generation, and tool-calling round trips. " +
      "Models: qwen3.8-27b, qwen3.8-27b-refusal-off (uncensored). Hyades response_format JSON mode is broken — " +
      "set json_mode=true to get JSON output via the prompt-based workaround.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Default qwen3.8-27b" },
        messages: { type: "array", items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } }, required: ["role", "content"] } },
        tools: { type: "array", description: "Optional OpenAI-style function tools" },
        max_tokens: { type: "number" },
        json_mode: { type: "boolean", description: "True = force raw JSON output (prompt workaround, since response_format is broken)" },
      },
      required: ["messages"],
    },
  },
  {
    name: "hyades_image_generate",
    description:
      "Generate images with qwen-image-2.1 and save them to local files (hosted URLs are temporary). " +
      "Set quality_check=true to run Hyades' Clef quality gate (returns status, prompt match, artifact risk, safety).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        size: { type: "string", description: "Default 1024x1024" },
        n: { type: "number" },
        quality_check: { type: "boolean" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "hyades_image_edit",
    description:
      "Edit an existing local image with qwen-image-2.1 (e.g. change lighting, add/remove elements) and save the result to a local file. " +
      "Optional quality_check runs Hyades' quality gate.",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "Local path to the source image" },
        prompt: { type: "string" },
        size: { type: "string" },
        quality_check: { type: "boolean" },
      },
      required: ["image_path", "prompt"],
    },
  },
  {
    name: "hyades_clef",
    description:
      "Clef System One decision via Hyades (POST /v1/systemone). Pass state (object), local image paths, a question name and instructions. " +
      "Returns the decision with score/choice/noul probabilities.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "object", description: "System One state payload" },
        images: { type: "array", items: { type: "string" }, description: "Local image paths (converted to data URLs)" },
        question: { type: "string", description: "Question key, default 'q'" },
        instructions: { type: "string" },
      },
      required: ["instructions"],
    },
  },
  {
    name: "hyades_3d_generate",
    description:
      "Generate a 3D model via Hyades (POST /v1/3d/generations) from a prompt or a source image (local path). " +
      "Returns the model URL (200) or polls the async job (202) until it completes — can take minutes.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        image: { type: "string", description: "Local path to a source image (alternative to prompt)" },
        remove_background: { type: "boolean" },
        seed: { type: "number" },
        steps: { type: "number" },
        response_format: { type: "string" },
        timeoutMs: { type: "number", description: "Max polling window, default 600000" },
      },
    },
  },
];

const IMPLS = {
  hyades_models: tModels,
  hyades_chat: tChat,
  hyades_image_generate: tImageGenerate,
  hyades_image_edit: tImageEdit,
  hyades_clef: tClef,
  hyades_3d_generate: t3dGenerate,
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
        serverInfo: { name: "hyades", version: "1.0.0" },
        instructions:
          "Hyades (hyades.gnostr.cloud) qwen chat, image generation/editing with quality checks, and Clef decisions. " +
          "Read the 'hyades' skill for endpoint contracts, error codes, and pitfalls before heavy use.",
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
