// Minimal MCP stdio client for smoke-testing hyades-server.mjs
import { spawn } from "node:child_process";

const KEY = process.argv[2]; // optional: inject HYADES_API_KEY
const server = spawn("node", [new URL("./hyades-server.mjs", import.meta.url).pathname], {
  env: { ...process.env, ...(KEY ? { HYADES_API_KEY: KEY } : {}) },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
const q = [];
server.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)(m);
    else q.push(m);
  }
});
server.stderr.on("data", (c) => process.stderr.write(`[server-stderr] ${c}`));

function call(method, params) {
  const id = Date.now() + Math.floor(Math.random() * 1e6);
  const p = new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => { pending.delete(id); rej(new Error(`timeout waiting for ${method}`)); }, 300000);
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}

const results = {};
async function main() {
  const t0 = Date.now();
  const init = await call("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "smoke", version: "1" } });
  results.initialize = init.result?.serverInfo;
  const list = await call("tools/list", {});
  results.tools = list.result?.tools?.map((t) => t.name);

  const models = await call("tools/call", { name: "list_models", arguments: {} });
  results.models = models.result?.content?.[0]?.text?.slice(0, 200);

  const pong = await call("tools/call", { name: "ask_qwen", arguments: { messages: [{ role: "user", content: "Reply with exactly: pong" }] } });
  results.pong = pong.result?.content?.[0]?.text?.slice(0, 300);

  const img = await call("tools/call", { name: "generate_image", arguments: { prompt: "A single solid red square on white background", size: "512x512", quality_check: true } });
  results.image = img.result?.content?.[0]?.text?.slice(0, 600);

  if (!img.result?.isError) {
    const p = JSON.parse(img.result.content[0].text).saved_paths?.[0];
    if (p) {
      const edit = await call("tools/call", { name: "edit_image", arguments: { image_path: p, prompt: "Make the square blue, keep everything else the same" } });
      results.edit = edit.result?.content?.[0]?.text?.slice(0, 400);
    }
    const clef = await call("tools/call", { name: "ask_clef", arguments: { question: "decision", instructions: "Is the statement '2+2=4' true?" } });
    results.clef = clef.result?.content?.[0]?.text?.slice(0, 600);
  }

  const bad = await call("tools/call", { name: "ask_qwen", arguments: { model: "qwen3.8-flash-next", messages: [{ role: "user", content: "hi" }] } });
  results.error403 = bad.result?.isError ? bad.result?.content?.[0]?.text?.slice(0, 200) : "no error (unexpected)";

}
main()
  .then(() => {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error("HARNESS ERROR", e);
    process.exit(1);
  });
setTimeout(() => { console.error("HARNESS TIMEOUT"); process.exit(2); }, 420000);
