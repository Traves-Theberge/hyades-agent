// Offline tests against a fake local gateway, driven by the official MCP client over stdio. No
// network, no API key, no cost. Runs against whichever server HYADES_SERVER names (see harness.ts):
//   npm test          — TypeScript bundle (run `npm run build` first; `npm run check` does both)
//   npm run test:rust — Rust binary (run `npm run build:rust` first)
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, connect, GLB, PNG, startFakeGateway, type FakeGateway } from "./harness.ts";

let gw: FakeGateway;
let work: string;

before(async () => {
  gw = await startFakeGateway();
});
after(() => gw.close());
beforeEach(() => {
  gw.log.length = 0;
  gw.pollsUntilDone = 2;
  work = mkdtempSync(join(tmpdir(), "hyades-test-"));
});

async function callTool(name: string, args: Record<string, unknown>, env: Record<string, string> = {}) {
  const client = await connect({ HYADES_BASE_URL: `${gw.base}/v1`, HYADES_API_KEY: "test-key", HYADES_OUTPUT_DIR: work, HYADES_3D_POLL_MS: "20", ...env });
  try {
    return await call(client, name, args);
  } finally {
    await client.close();
  }
}

const gatewayRequests = () => gw.log.filter((r) => r.url.startsWith("/v1/"));

test("lists the six tools", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["ask_clef", "ask_qwen", "edit_image", "generate_3d_model", "generate_image", "list_models"]);
  } finally {
    await client.close();
  }
});

test("3D: posts once, polls the job URL, downloads the model", async () => {
  gw.pollsUntilDone = 3;
  const r = await callTool("generate_3d_model", { prompt: "a cube" });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const posts = gw.log.filter((x) => x.method === "POST");
  const polls = gw.log.filter((x) => x.method === "GET" && x.url.includes("/3d/generations/"));
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
  ] as const) {
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
    gw.log.length = 0;
    const r = await callTool("list_models", {}, { HYADES_PLUGIN_API_KEY: pluginKey, HYADES_API_KEY: "user-key" });
    assert.equal(r.isError, false, JSON.stringify(r.body));
    assert.equal(gw.log[0].auth, `Bearer ${expected}`, `plugin key ${JSON.stringify(pluginKey)}`);
  }
});
