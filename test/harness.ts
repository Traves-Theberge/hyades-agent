// Shared by the tests and the benchmark: a fake Hyades gateway on localhost, and a way to connect
// the official MCP client to the server over stdio.
//   HYADES_SERVER=launcher/hyades-server.mjs  (default) — the launcher, which runs release/<binary>
//   HYADES_SERVER=<path to binary>                    — a server binary, run directly
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]);
export const GLB = Buffer.concat([Buffer.from("glTF"), Buffer.from([2, 0, 0, 0]), Buffer.from("fake-glb-body")]);

export type Logged = { method: string; url: string; body: string; auth?: string };

export interface FakeGateway {
  base: string;
  log: Logged[];
  /** Polls answered "running" before the 3D job completes. */
  pollsUntilDone: number;
  close(): void;
}

export async function startFakeGateway(): Promise<FakeGateway> {
  const state: FakeGateway = { base: "", log: [], pollsUntilDone: 2, close: () => server.close() };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = Buffer.concat(chunks).toString();
      state.log.push({ method: req.method ?? "", url, body, auth: req.headers.authorization });
      const json = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && url === "/v1/3d/generations") return json(202, { id: "job1", status: "queued", poll: "/v1/3d/generations/job1" });
      if (req.method === "GET" && url === "/v1/3d/generations/job1") {
        if (state.pollsUntilDone-- > 1) return json(200, { id: "job1", status: "running" });
        return json(200, { id: "job1", status: "completed", data: [{ model_url: `${state.base}/files/model.glb` }] });
      }
      if (req.method === "GET" && url === "/files/model.glb") {
        res.writeHead(200, { "content-type": "model/gltf-binary" });
        return res.end(GLB);
      }
      if (req.method === "POST" && (url === "/v1/images/generations" || url === "/v1/images/edits")) {
        const n = JSON.parse(body).n ?? 1;
        return json(200, { data: Array.from({ length: n }, (_, i) => ({ url: `${state.base}/img/${i}` })) });
      }
      if (req.method === "GET" && url.startsWith("/img/")) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      if (req.method === "POST" && url === "/v1/systemone") return json(200, { answers: {} });
      if (req.method === "GET" && url === "/v1/models") return json(200, { data: [{ id: "qwen3.8-27b" }] });
      json(404, { error: { message: "not found" } });
    });
  });
  const { promise, resolve: listening } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening);
  await promise;
  const address = server.address();
  state.base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return state;
}

const ROOT = new URL("..", import.meta.url).pathname;

/** Default server under test, from HYADES_SERVER, resolved from the repo root. */
export const SERVER = resolve(ROOT, process.env.HYADES_SERVER ?? "launcher/hyades-server.mjs");

/** A stdio transport that launches a server (default: the one under test) with the given environment. */
export function serverTransport(env: Record<string, string> = {}, server = SERVER): StdioClientTransport {
  const path = resolve(ROOT, server);
  const isScript = path.endsWith(".mjs") || path.endsWith(".js");
  return new StdioClientTransport({
    command: isScript ? process.execPath : path,
    args: isScript ? [path] : [],
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", ...env },
  });
}

/** Spawns a server and connects the official client (2026-07-28 when both sides speak it). */
export async function connect(env: Record<string, string> = {}, transport = serverTransport(env)): Promise<Client> {
  const client = new Client({ name: "hyades-harness", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  return client;
}

/** Calls one tool and parses the JSON text body both implementations return. */
export async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: !!result.isError, body: JSON.parse(first.text) };
}
