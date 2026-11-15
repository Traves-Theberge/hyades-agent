// Launcher tests: first-run download, checksum verification and caching, against a fake release
// server. Runs the launcher from a temporary copy of the plugin so no local build in release/ is
// used. Needs `npm run build` (the served bytes are the real binary for this machine).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, serverTransport } from "./harness.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const ASSET = "hyades-server-x86_64-unknown-linux-musl";
const real = readFileSync(join(ROOT, "release", ASSET));

let server: Server;
let base: string;
let served: Buffer;
let downloads: number;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === `/v0.0.0-test/${ASSET}`) {
      downloads++;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(served);
    }
    res.writeHead(404).end();
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
after(() => server.close());

/** A copy of the launcher with checksums for `real`, and an empty cache directory. */
function stagePlugin() {
  const dir = mkdtempSync(join(tmpdir(), "hyades-launcher-"));
  mkdirSync(join(dir, "plugin", "launcher"), { recursive: true });
  copyFileSync(join(ROOT, "launcher/hyades-server.mjs"), join(dir, "plugin/launcher/hyades-server.mjs"));
  const sha = createHash("sha256").update(real).digest("hex");
  writeFileSync(join(dir, "plugin/launcher/checksums.json"), JSON.stringify({ version: "0.0.0-test", assets: { [ASSET]: sha } }));
  return { launcher: join(dir, "plugin/launcher/hyades-server.mjs"), cache: join(dir, "cache") };
}

test("downloads the binary once, verifies it, caches it and serves MCP", async () => {
  served = real;
  downloads = 0;
  const { launcher, cache } = stagePlugin();
  const env = { HYADES_RELEASE_BASE_URL: base, CLAUDE_PLUGIN_DATA: cache };
  for (let start = 0; start < 2; start++) {
    const client = await connect(env, serverTransport(env, launcher));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    await client.close();
  }
  assert.equal(downloads, 1, "second start must reuse the cache");
  assert.ok(existsSync(join(cache, "bin", "0.0.0-test", ASSET)));
});

test("refuses a binary whose checksum doesn't match and caches nothing", async () => {
  served = Buffer.concat([real, Buffer.from("tampered")]);
  downloads = 0;
  const { launcher, cache } = stagePlugin();
  const env = { HYADES_RELEASE_BASE_URL: base, CLAUDE_PLUGIN_DATA: cache };
  await assert.rejects(connect(env, serverTransport(env, launcher)));
  // The client's version negotiation retries a failed start once, so the launcher may run twice.
  assert.ok(downloads >= 1, "the launcher must have tried the download");
  const cached = existsSync(join(cache, "bin", "0.0.0-test")) ? readdirSync(join(cache, "bin", "0.0.0-test")) : [];
  assert.deepEqual(cached, [], "nothing may be cached after a checksum mismatch");
});
