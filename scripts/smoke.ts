// Live end-to-end check against the real gateway. Uses your API key (plugin env, HYADES_API_KEY
// or ~/.omp/agent/hyades.key) and costs credits: one chat call, one image generation, one edit
// and one Clef decision. Files are saved in the current directory.
//   npm run smoke                         — through the launcher (release/<binary>, or a download)
//   HYADES_SERVER=<binary> npm run smoke  — a server binary directly
import { connect, SERVER, serverTransport } from "../test/harness.ts";

const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
const client = await connect(env, serverTransport(env));
console.log("server:", SERVER);
console.log("protocol:", client.getNegotiatedProtocolVersion());

let failed = false;
async function step(name: string, args: Record<string, unknown>, expectError = false) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  const ok = !!result.isError === expectError;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  return JSON.parse(text);
}

try {
  await step("list_models", {});
  await step("ask_qwen", { messages: [{ role: "user", content: "Reply with exactly: pong" }] });
  const image = await step("generate_image", { prompt: "A single solid red square on a white background", size: "512x512", quality_check: true });
  if (image.saved_paths?.[0]) await step("edit_image", { image_path: image.saved_paths[0], prompt: "Make the square blue" });
  await step("ask_clef", { instructions: "Is the statement '2+2=4' true?" });
  await step("ask_qwen", { model: "qwen3.8-flash-next", messages: [{ role: "user", content: "hi" }] }, true);
} finally {
  await client.close();
}
process.exitCode = failed ? 1 : 0;
