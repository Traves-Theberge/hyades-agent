// Builds the Rust server and stages it for the launcher.
//   npm run build            — this machine's platform only, into release/ (development; no checksums)
//   npm run release          — all five platforms into release/, and writes launcher/checksums.json
//   npm run release:publish  — the above, then creates GitHub release v<version> with the binaries
// Cross-compiling uses cargo-zigbuild (Zig as the C compiler/linker), so every target builds on one
// Linux machine. Build output goes to ~/.cache/hyades-agent-target, outside the plugin folder, so
// hosts that copy a local plugin never copy the build directory.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(homedir(), ".cache", "hyades-agent-target");
const ALL = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-gnu"];
const HOST: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-gnu",
};

const mode = process.argv[2] ?? "host";
const version: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const versions = {
  "package.json": version,
  ".claude-plugin/plugin.json": JSON.parse(readFileSync(join(ROOT, ".claude-plugin/plugin.json"), "utf8")).version,
  "rust/Cargo.toml": readFileSync(join(ROOT, "rust/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1],
};
if (Object.values(versions).some((v) => v !== version)) throw new Error(`version mismatch: ${JSON.stringify(versions)}`);

const targets = mode === "host" ? [HOST[`${process.platform}-${process.arch}`]] : ALL;
if (!targets[0]) throw new Error(`unsupported build host ${process.platform}-${process.arch}`);
const env = { ...process.env, CARGO_TARGET_DIR: TARGET_DIR, PATH: `${join(homedir(), ".cargo/bin")}:${join(homedir(), ".local/bin")}:${process.env.PATH}` };

mkdirSync(join(ROOT, "release"), { recursive: true });
const assets: Record<string, string> = {};
for (const target of targets) {
  console.error(`building ${target}…`);
  execFileSync("cargo", ["zigbuild", "--release", "--target", target], { cwd: join(ROOT, "rust"), env, stdio: ["ignore", "inherit", "inherit"] });
  const exe = target.includes("windows") ? ".exe" : "";
  const asset = `hyades-server-${target}${exe}`;
  // Copy then rename: a running server keeps its old file, and Linux refuses to overwrite a
  // running executable in place (ETXTBSY).
  const staged = join(ROOT, "release", `${asset}.${process.pid}.tmp`);
  copyFileSync(join(TARGET_DIR, target, "release", `hyades-server${exe}`), staged);
  renameSync(staged, join(ROOT, "release", asset));
  assets[asset] = createHash("sha256").update(readFileSync(join(ROOT, "release", asset))).digest("hex");
  console.error(`  ${asset}  ${assets[asset]}`);
}

if (mode === "host") process.exit(0);

writeFileSync(join(ROOT, "launcher/checksums.json"), JSON.stringify({ version, assets }, null, 2) + "\n");
console.error(`wrote launcher/checksums.json for ${version}`);

if (mode === "publish") {
  const files = Object.keys(assets).map((a) => join(ROOT, "release", a));
  execFileSync("gh", ["release", "create", `v${version}`, ...files, "--title", `v${version}`, "--notes", `Hyades MCP server binaries for ${version}. SHA-256 checksums are in launcher/checksums.json.`], {
    cwd: ROOT,
    stdio: "inherit",
  });
}
