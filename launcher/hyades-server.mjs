#!/usr/bin/env node
// @ts-check
// Starts the Hyades MCP server: a Rust binary built per platform. A plugin's MCP `command` is one
// value for every OS, so this launcher picks the binary for this machine and relays stdio to it.
//
// Binaries are not in the repository. On first run the one for this platform is downloaded from the
// GitHub release matching this plugin version, checked against the SHA-256 in checksums.json (a
// mismatch is refused and nothing is cached), and cached; later starts reuse the cached copy.
//
// Resolution order:
//   1. HYADES_SERVER_BINARY        — an explicit binary path (offline installs, custom builds)
//   2. <plugin>/release/<asset>    — a local build from `npm run build` (development checkouts)
//   3. <cache>/<version>/<asset>   — a verified download from an earlier run
//   4. download from HYADES_RELEASE_BASE_URL (default: this repo's GitHub releases), then 3
// stdout is the MCP channel: every message here goes to stderr.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TARGETS = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-gnu",
};

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`hyades: ${message}`);
  process.exit(1);
}

/** @type {{ version: string, assets: Record<string, string> }} */
const checksums = JSON.parse(readFileSync(new URL("./checksums.json", import.meta.url), "utf8"));
const platform = `${process.platform}-${process.arch}`;
const target = TARGETS[/** @type {keyof typeof TARGETS} */ (platform)];
if (!target) fail(`no server binary for ${platform}; supported: ${Object.keys(TARGETS).join(", ")}`);
const asset = `hyades-server-${target}${process.platform === "win32" ? ".exe" : ""}`;

async function resolveBinary() {
  if (process.env.HYADES_SERVER_BINARY) return process.env.HYADES_SERVER_BINARY;
  const local = join(ROOT, "release", asset);
  if (existsSync(local)) return local;

  const cacheRoot =
    process.env.CLAUDE_PLUGIN_DATA ??
    join(process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "hyades-plugin");
  const dir = join(cacheRoot, "bin", checksums.version);
  const cached = join(dir, asset);
  if (existsSync(cached)) return cached;

  const expected = checksums.assets[asset];
  if (!expected) fail(`checksums.json has no entry for ${asset} (version ${checksums.version})`);
  const base = process.env.HYADES_RELEASE_BASE_URL ?? "https://github.com/Traves-Theberge/hyades-agent/releases/download";
  const url = `${base}/v${checksums.version}/${asset}`;
  console.error(`hyades: downloading ${asset} ${checksums.version} (first run only)…`);
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch((e) => fail(`download failed: ${e.message} (${url})`));
  if (!res.ok) fail(`download failed: HTTP ${res.status} (${url})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) fail(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Refusing to run it.`);

  // Write beside the target and rename, so a concurrent first start never sees a partial file.
  mkdirSync(dir, { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  writeFileSync(partial, bytes, { mode: 0o755 });
  chmodSync(partial, 0o755);
  try {
    renameSync(partial, cached);
  } catch (e) {
    rmSync(partial, { force: true });
    if (!existsSync(cached)) throw e;
  }
  return cached;
}

const binary = await resolveBinary();
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (e) => fail(`could not start ${binary}: ${e.message}`));
// The host stops the server by closing stdin or signalling the launcher; pass signals on.
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
