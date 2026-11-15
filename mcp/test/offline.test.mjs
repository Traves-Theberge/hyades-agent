// Offline tests: the MCP server against a fake local gateway. No network, no API key, no cost.
// Run: node --test mcp/test/
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = new URL("../hyades-server.mjs", import.meta.url).pathname;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]);
const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.from([2, 0, 0, 0]), Buffer.from("fake-glb-body")]);

let gw, base, log, pollsUntilDone, work;

before(async () => {
  gw = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      const json = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && req.url === "/v1/3d/generations")
        return json(202, { id: "job1", status: "queued", poll: "/v1/3d/generations/job1" });
      if (req.method === "GET" && req.url === "/v1/3d/generations/job1") {
        if (pollsUntilDone-- > 1) return json(200, { id: "job1", status: "running" });
        return json(200, { id: "job1", status: "completed", data: [{ model_url: `${base}/files/model.glb` }] });
      }
      if (req.method === "GET" && req.url === "/files/model.glb") {
        res.writeHead(200, { "content-type": "model/gltf-binary" });
        return res.end(GLB);
      }
      if (req.method === "POST" && (req.url === "/v1/images/generations" || req.url === "/v1/images/edits")) {
        const n = JSON.parse(body).n ?? 1;
        return json(200, { data: Array.from({ length: n }, (_, i) => ({ url: `${base}/img/${i}` })) });
      }
      if (req.method === "GET" && req.url.startsWith("/img/")) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      if (req.method === "POST" && req.url === "/v1/systemone") return json(200, { answers: {} });
      if (req.method === "GET" && req.url === "/v1/models") return json(200, { data: [{ id: "qwen3.8-27b" }] });
      json(404, { error: { message: "not found" } });
    });
  });
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${gw.address().port}`;
});
after(() => gw.close());
beforeEach(() => {
  log = [];
  pollsUntilDone = 2;
  work = mkdtempSync(join(tmpdir(), "hyades-test-"));
});

async function callTool(name, args, env = {}) {
  const proc = spawn("node", [SERVER], {
    env: {
      ...process.env,
      HYADES_BASE_URL: `${base}/v1`,
      HYADES_API_KEY: "test-key",
      HYADES_OUTPUT_DIR: work,
      HYADES_3D_POLL_MS: "20",
      ...env,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  const done = new Promise((resolve, reject) => {
    proc.stdout.on("data", (c) => {
      out += c;
      const line = out.split("\n").find((l) => l.trim());
      if (line && out.includes("\n")) resolve(JSON.parse(line));
    });
    proc.on("exit", () => reject(new Error(`server exited early: ${out}`)));
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  const msg = await done;
  proc.kill();
  return { isError: !!msg.result.isError, body: JSON.parse(msg.result.content[0].text) };
}

const gatewayRequests = () => log.filter((r) => r.url.startsWith("/v1/"));

test("3D: posts once, polls the job URL, downloads the model", async () => {
  pollsUntilDone = 3;
  const r = await callTool("generate_3d_model", { prompt: "a cube" });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const posts = log.filter((x) => x.method === "POST");
  const polls = log.filter((x) => x.method === "GET" && x.url.includes("/3d/generations/"));
  assert.equal(posts.length, 1, "must not re-submit the generation while polling");
  assert.equal(polls.length, 3);
  assert.ok(polls.every((p) => p.url === "/v1/3d/generations/job1"), `poll URLs: ${polls.map((p) => p.url)}`);
  assert.ok(r.body.saved_path && existsSync(r.body.saved_path), "model must be saved locally");
  assert.ok(r.body.saved_path.endsWith(".glb"));
  assert.deepEqual(readFileSync(r.body.saved_path), GLB);
});

test("rejects non-image files before uploading anything", async () => {
  const secret = join(work, "secret.png"); // image extension, but not image content
  writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\nnot really\n");
  for (const [tool, args] of [
    ["edit_image", { image_path: secret, prompt: "x" }],
    ["ask_clef", { images: [secret], instructions: "x" }],
    ["generate_3d_model", { image: secret }],
  ]) {
    const r = await callTool(tool, args);
    assert.equal(r.isError, true, `${tool} accepted a non-image`);
    assert.equal(r.body.error, "bad_args", tool);
  }
  assert.equal(gatewayRequests().length, 0, "nothing may be sent to the gateway");
});

test("rejects directories as images", async () => {
  const r = await callTool("edit_image", { image_path: work, prompt: "x" });
  assert.equal(r.body.error, "bad_args");
  assert.equal(gatewayRequests().length, 0);
});

test("real images are accepted and sent with a mime type from their content", async () => {
  const img = join(work, "photo.jpg"); // PNG bytes behind a .jpg name
  writeFileSync(img, PNG);
  const r = await callTool("edit_image", { image_path: img, prompt: "make it blue" });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  assert.ok(JSON.parse(gatewayRequests()[0].body).image.startsWith("data:image/png;base64,"));
});

test("saved images get unique names and never overwrite existing files", async () => {
  const first = await callTool("generate_image", { prompt: "x", n: 3 });
  const second = await callTool("generate_image", { prompt: "x", n: 3 });
  const paths = [...first.body.saved_paths, ...second.body.saved_paths];
  assert.equal(paths.length, 6);
  assert.equal(new Set(paths).size, 6, "every saved image needs its own file");
  assert.equal(readdirSync(work).length, 6);
});

test("an unset plugin key never hides HYADES_API_KEY; a set one takes priority", async () => {
  for (const [pluginKey, expected] of [
    ["${user_config.api_key}", "user-key"], // host didn't fill in the option
    ["", "user-key"], // option left empty
    ["plugin-key", "plugin-key"], // option set
  ]) {
    log = [];
    const r = await callTool("list_models", {}, { HYADES_PLUGIN_API_KEY: pluginKey, HYADES_API_KEY: "user-key" });
    assert.equal(r.isError, false, JSON.stringify(r.body));
    assert.equal(log[0].auth, `Bearer ${expected}`, `plugin key ${JSON.stringify(pluginKey)}`);
  }
});
