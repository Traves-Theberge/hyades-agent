// Benchmarks the Rust server against a fake gateway through the official MCP client over stdio:
// started directly, and started the way the plugin ships it (Node launcher → binary).
// No network, no key, no cost. Run `npm run build` first (Linux x64 host).
// Measures: cold start (spawn → first tools/list), warm tool-call latency, concurrent throughput,
// a 15 MB upload path, peak memory (VmHWM, launcher + server) and binary size.
import { readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { call, connect, PNG, serverTransport, startFakeGateway } from "../test/harness.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const BINARY = "release/hyades-server-x86_64-unknown-linux-musl";
const IMPLS: { name: string; server: string; artifact?: string }[] = [
  { name: "Rust binary", server: BINARY },
  { name: "Rust via launcher (as shipped)", server: "launcher/hyades-server.mjs", artifact: BINARY },
];
const COLD_RUNS = 20;
const WARM_CALLS = 500;
const CONCURRENT_CALLS = 400;
const CONCURRENCY = 20;
const UPLOADS = 10;

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const ms = (x: number) => Number(x.toFixed(2));
/** Peak resident memory of a process plus its direct children (a launcher and the server it starts). */
function peakRssMb(pid: number | null): number {
  const hwmKb = (p: string) => Number(readFileSync(`/proc/${p}/status`, "utf8").match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
  const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
  return Number(((hwmKb(String(pid)) + children.reduce((sum, c) => sum + hwmKb(c), 0)) / 1024).toFixed(1));
}

const gw = await startFakeGateway();
const work = mkdtempSync(join(tmpdir(), "hyades-bench-"));
const upload = join(work, "large.png");
writeFileSync(upload, Buffer.concat([PNG, randomBytes(15 * 1024 * 1024)])); // PNG header + 15 MB payload
const env = { HYADES_BASE_URL: `${gw.base}/v1`, HYADES_API_KEY: "bench-key", HYADES_OUTPUT_DIR: work };

const results: Record<string, Record<string, number | string>> = {};
for (const impl of IMPLS) {
  const server = impl.server;

  // Cold start: spawn, negotiate, list tools, exit.
  const cold: number[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const t0 = performance.now();
    const client = await connect(env, serverTransport(env, server));
    await client.listTools();
    cold.push(performance.now() - t0);
    await client.close();
  }

  const transport = serverTransport(env, server);
  const client = await connect(env, transport);
  const protocol = client.getNegotiatedProtocolVersion() ?? "?";

  // Warm sequential latency.
  for (let i = 0; i < 20; i++) await call(client, "list_models", {});
  const warm: number[] = [];
  for (let i = 0; i < WARM_CALLS; i++) {
    const t0 = performance.now();
    await call(client, "list_models", {});
    warm.push(performance.now() - t0);
  }

  // Concurrent throughput: CONCURRENCY calls in flight at once.
  const t0 = performance.now();
  for (let done = 0; done < CONCURRENT_CALLS; done += CONCURRENCY) {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => call(client, "list_models", {})));
  }
  const throughput = CONCURRENT_CALLS / ((performance.now() - t0) / 1000);

  // Upload path: read, sniff, base64-encode and POST a 15 MB image, then save the result.
  const uploads: number[] = [];
  for (let i = 0; i < UPLOADS; i++) {
    const t1 = performance.now();
    const r = await call(client, "edit_image", { image_path: upload, prompt: "x" });
    if (r.isError) throw new Error(`${impl.name} upload failed: ${JSON.stringify(r.body)}`);
    uploads.push(performance.now() - t1);
  }

  const rss = peakRssMb(transport.pid);
  await client.close();

  results[impl.name] = {
    protocol,
    "cold start p50 (ms)": ms(pct(cold, 50)),
    "cold start p95 (ms)": ms(pct(cold, 95)),
    "warm call p50 (ms)": ms(pct(warm, 50)),
    "warm call p95 (ms)": ms(pct(warm, 95)),
    "concurrent calls/s": Math.round(throughput),
    "15 MB upload p50 (ms)": ms(pct(uploads, 50)),
    "peak memory (MB)": rss,
    "artifact size (KB)": Math.round(statSync(join(ROOT, impl.artifact ?? impl.server)).size / 1024),
  };
  console.error(`${impl.name}: done`);
}
gw.close();

const metrics = Object.keys(results[IMPLS[0].name]);
console.log(`| Metric | ${IMPLS.map((i) => i.name).join(" | ")} |`);
console.log(`|:--|${IMPLS.map(() => "--:").join("|")}|`);
for (const m of metrics) console.log(`| ${m} | ${IMPLS.map((i) => results[i.name][m]).join(" | ")} |`);
writeFileSync(join(ROOT, "bench-results.json"), JSON.stringify({ date: new Date().toISOString(), node: process.version, results }, null, 2));
