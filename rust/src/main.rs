//! Hyades MCP server, Rust implementation: exposes the hyades.gnostr.cloud gateway as six tools
//! over stdio, built on rmcp (protocol 2026-07-28). Mirrors `src/server.ts` tool for tool, so the
//! same test suite and benchmarks run against both.
//! Tool failures come back as results with isError=true and a JSON body { error, message,
//! retryable }, so the calling agent can read the code and react; they never crash the server.
mod files;
mod gateway;

use std::time::Duration;

use base64::prelude::*;
use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    schemars::{self, JsonSchema},
    tool, tool_handler, tool_router,
    transport::stdio,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use files::{image_data_url, image_ext, sniff_image, write_unique};
use gateway::{BASE, HyadesError, Result, TIMEOUT, download, hyades, retry429};

/// Converts a tool body's outcome into a tool result the agent can act on.
fn respond(outcome: Result<Value>) -> CallToolResult {
    match outcome {
        Ok(value) => CallToolResult::success(vec![ContentBlock::text(serde_json::to_string_pretty(&value).unwrap_or_default())]),
        Err(e) => {
            let payload = json!({ "error": e.code, "message": e.message, "retryable": e.retryable });
            CallToolResult::error(vec![ContentBlock::text(serde_json::to_string_pretty(&payload).unwrap_or_default())])
        }
    }
}

/// Saves every returned image locally (result URLs expire) and keeps the quality scores.
async fn save_images(items: &[Value], kind: &str) -> Result<Value> {
    let mut saved_paths = Vec::new();
    for item in items {
        let buf = if let Some(url) = item["url"].as_str() {
            download(url).await?.0
        } else if let Some(b64) = item["b64_json"].as_str() {
            BASE64_STANDARD.decode(b64).map_err(|e| HyadesError::new("unexpected_response", format!("bad b64_json: {e}")))?
        } else {
            continue;
        };
        saved_paths.push(write_unique(&buf, &format!("hyades-img-{kind}"), image_ext(sniff_image(&buf)))?);
    }
    let quality: Vec<Value> = items.iter().map(|item| item.get("quality").cloned().unwrap_or(Value::Null)).collect();
    Ok(json!({ "saved_paths": saved_paths, "quality": quality }))
}

/// 3D jobs: submit once (each POST is a new billable job), then poll the job URL until done.
async fn generate_3d(body: Value, timeout_ms: u64) -> Result<Value> {
    let poll_every = Duration::from_millis(std::env::var("HYADES_3D_POLL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(10_000));
    let mut job = retry429(|| hyades("/3d/generations", Some(&body), Duration::from_secs(300), &[200, 202])).await?;
    // `poll` is root-relative ("/v1/3d/generations/<id>"): resolve it against the origin, not BASE + path.
    let poll_url = match (job["poll"].as_str(), job["id"].as_str()) {
        (Some(poll), _) => Some(url::Url::parse(&BASE).and_then(|b| b.join(poll)).map(String::from).unwrap_or_else(|_| poll.to_owned())),
        (None, Some(id)) => Some(format!("{}/3d/generations/{id}", *BASE)),
        _ => None,
    };
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let model_url = [&job["data"][0]["model_url"], &job["model_url"], &job["result"]["data"][0]["model_url"], &job["result"]["model_url"]]
            .into_iter()
            .find_map(Value::as_str)
            .map(str::to_owned);
        if let Some(url) = model_url {
            // The model URL is likely as temporary as image URLs, so keep a local copy.
            let (buf, content_type) = download(&url).await?;
            let from_url = url::Url::parse(&url)
                .ok()
                .and_then(|u| u.path().rsplit_once('.').map(|(_, ext)| format!(".{}", ext.to_lowercase())))
                .filter(|ext| matches!(ext.as_str(), ".glb" | ".gltf" | ".obj" | ".fbx" | ".usdz" | ".ply" | ".stl"));
            let ext = if buf.starts_with(b"glTF") || content_type.contains("gltf-binary") { ".glb".to_owned() } else { from_url.unwrap_or_else(|| ".glb".into()) };
            return Ok(json!({ "saved_path": write_unique(&buf, "hyades-3d", &ext)?, "model_url": url, "id": job["id"] }));
        }
        let status = job["status"].as_str().unwrap_or_default().to_lowercase();
        let snippet: String = job.to_string().chars().take(300).collect();
        if matches!(status.as_str(), "failed" | "error" | "cancelled" | "canceled") {
            return Err(HyadesError::new("3d_failed", format!("3D generation {status}: {snippet}")));
        }
        let Some(poll_url) = poll_url.as_deref().filter(|_| !matches!(status.as_str(), "completed" | "complete" | "succeeded" | "success" | "done")) else {
            return Err(HyadesError::new("unexpected_response", format!("3D response has no model_url to download: {snippet}")));
        };
        if std::time::Instant::now() > deadline {
            let id = job["id"].as_str().unwrap_or("?");
            return Err(HyadesError::new("timeout", format!("3D job {id} still {status} after {}s (poll: {poll_url})", timeout_ms / 1000)));
        }
        tokio::time::sleep(poll_every).await;
        job = retry429(|| hyades(poll_url, None, TIMEOUT, &[200])).await?;
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct Message {
    role: Role,
    content: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct AskQwenParams {
    /// Conversation in OpenAI format; content is plain text.
    messages: Vec<Message>,
    /// qwen3.8-27b (default) or qwen3.8-27b-refusal-off for answers without refusals.
    model: Option<String>,
    /// true to get raw JSON back in content. Use this, not response_format, which the gateway answers with empty content.
    json_mode: Option<bool>,
    /// Optional OpenAI-style function definitions; calls come back in tool_calls.
    tools: Option<Vec<Map<String, Value>>>,
    /// Optional reply cap. qwen reasons before answering, so small values (around 20) can return empty content.
    max_tokens: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GenerateImageParams {
    /// Subject, palette (hex), composition. Add 'no text, no letters' unless the model should draw text.
    prompt: String,
    /// WIDTHxHEIGHT, default 1024x1024; 1792x768 works for wide banners.
    size: Option<String>,
    /// Number of images, default 1.
    n: Option<u32>,
    /// true to score each image (status, score, match_level, artifact and safety probabilities). Adds up to ~60 s.
    quality_check: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct EditImageParams {
    /// Local PNG, JPEG or WebP file to edit (max 20 MB). Other files are refused.
    image_path: String,
    /// The change to make, e.g. 'make the scene a bright sunny morning'.
    prompt: String,
    /// Output WIDTHxHEIGHT, default 1024x1024.
    size: Option<String>,
    /// true to score the result.
    quality_check: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct AskClefParams {
    /// The question, e.g. 'Does the image show an error state?'
    instructions: String,
    /// Local PNG, JPEG or WebP paths to judge.
    images: Option<Vec<String>>,
    /// Optional context object passed through to System One.
    state: Option<Map<String, Value>>,
    /// Key for the answer in the result, default 'q'.
    question: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct Generate3dParams {
    /// What to model. Give either prompt or image.
    prompt: Option<String>,
    /// Local PNG, JPEG or WebP to turn into a model. Give either prompt or image.
    image: Option<String>,
    /// Remove the source image background first.
    remove_background: Option<bool>,
    /// Seed for reproducible results.
    seed: Option<i64>,
    /// Generation steps (more is slower).
    steps: Option<u32>,
    /// Passed through to the gateway.
    response_format: Option<String>,
    /// How long to wait for the job, default 600000 (10 min).
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

#[derive(Clone)]
struct Hyades;

// `description` is what the model reads when choosing a tool: say what it does and when to use it.
// `title` is the label clients show. Every tool calls an external service (open_world_hint).
#[tool_router]
impl Hyades {
    #[tool(
        title = "Hyades: list models",
        description = "List the chat model ids this Hyades API key may use. Use when asked what models or capabilities are available, or after a `forbidden` error to pick an allowed model.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn list_models(&self) -> CallToolResult {
        respond(async {
            let j = retry429(|| hyades("/models", None, TIMEOUT, &[200])).await?;
            let models: Vec<Value> = j["data"].as_array().into_iter().flatten().filter_map(|m| m.get("id").cloned()).collect();
            Ok(json!({ "models": models }))
        }
        .await)
    }

    #[tool(
        title = "Hyades: ask qwen",
        description = "Send a conversation to a qwen model on the Hyades gateway and return its reply. Use it when the user asks for qwen, Hyades, \
                       a second opinion from another model, or an uncensored answer from a model that won't refuse (qwen3.8-27b-refusal-off). \
                       An explicit request for one of these is the user's choice of model: call this tool even if you could answer yourself. \
                       Answer ordinary questions that ask for none of these yourself.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn ask_qwen(&self, Parameters(p): Parameters<AskQwenParams>) -> CallToolResult {
        respond(async {
            if p.messages.is_empty() {
                return Err(HyadesError::new("bad_args", "messages must be a non-empty array of {role, content}"));
            }
            let mut conversation: Vec<Value> = p.messages.iter().map(|m| json!({ "role": format!("{:?}", m.role).to_lowercase(), "content": m.content })).collect();
            if p.json_mode == Some(true) {
                // The gateway answers response_format with empty content, so JSON mode is a system instruction.
                conversation.insert(0, json!({ "role": "system", "content": "Output only raw JSON, no prose, no code fences." }));
            }
            let mut body = json!({ "model": p.model.as_deref().unwrap_or("qwen3.8-27b"), "messages": conversation });
            if let Some(tools) = p.tools.filter(|t| !t.is_empty()) {
                body["tools"] = json!(tools);
            }
            if let Some(max_tokens) = p.max_tokens {
                body["max_tokens"] = json!(max_tokens);
            }
            let j = retry429(|| hyades("/chat/completions", Some(&body), TIMEOUT, &[200])).await?;
            let choice = &j["choices"][0];
            Ok(json!({
                "content": choice["message"]["content"].as_str().unwrap_or_default(),
                "tool_calls": choice["message"]["tool_calls"],
                "finish_reason": choice["finish_reason"],
                "usage": j["usage"],
                "model": j["model"],
            }))
        }
        .await)
    }

    #[tool(
        title = "Hyades: generate image",
        description = "Generate images with qwen-image-2.1 and save them as local files; returns saved_paths and optional quality scores. Use for new pictures, \
                       illustrations, icons or artwork. For logos, banners, icons, anything with exact text, or multi-step work, prefer delegating to hyades-agent.",
        annotations(read_only_hint = false, destructive_hint = false, open_world_hint = true)
    )]
    async fn generate_image(&self, Parameters(p): Parameters<GenerateImageParams>) -> CallToolResult {
        respond(async {
            let body = json!({
                "model": "qwen-image-2.1",
                "prompt": p.prompt,
                "size": p.size.as_deref().unwrap_or("1024x1024"),
                "n": p.n.unwrap_or(1),
                "quality_check": p.quality_check.unwrap_or(false),
            });
            let j = retry429(|| hyades("/images/generations", Some(&body), TIMEOUT, &[200])).await?;
            save_images(j["data"].as_array().map(Vec::as_slice).unwrap_or_default(), "gen").await
        }
        .await)
    }

    #[tool(
        title = "Hyades: edit image",
        description = "Change an existing local image with qwen-image-2.1 (lighting, scene, adding or removing elements) and save the result as a new local file. \
                       Use when the user supplies an image and wants it altered.",
        annotations(read_only_hint = false, destructive_hint = false, open_world_hint = true)
    )]
    async fn edit_image(&self, Parameters(p): Parameters<EditImageParams>) -> CallToolResult {
        respond(async {
            let image = image_data_url(&p.image_path, "image_path")?;
            let body = json!({
                "model": "qwen-image-2.1",
                "prompt": p.prompt,
                "size": p.size.as_deref().unwrap_or("1024x1024"),
                "quality_check": p.quality_check.unwrap_or(false),
                "image": image,
            });
            let j = retry429(|| hyades("/images/edits", Some(&body), TIMEOUT, &[200])).await?;
            save_images(j["data"].as_array().map(Vec::as_slice).unwrap_or_default(), "edit").await
        }
        .await)
    }

    #[tool(
        title = "Hyades: Clef decision",
        description = "Ask Clef System One a yes/no question, optionally about local images; returns a 0–1 likelihood (noul) in under a second. \
                       Use when the user asks for Clef or System One, or needs a numeric score. To describe an image, read it yourself instead.",
        annotations(read_only_hint = true, open_world_hint = true)
    )]
    async fn ask_clef(&self, Parameters(p): Parameters<AskClefParams>) -> CallToolResult {
        respond(async {
            let images = p.images.unwrap_or_default().iter().enumerate().map(|(i, path)| image_data_url(path, &format!("images[{i}]"))).collect::<Result<Vec<_>>>()?;
            let question = p.question.unwrap_or_else(|| "q".into());
            let body = json!({
                "state": p.state.unwrap_or_default(),
                "images": images,
                "questions": { question: { "type": "noul", "instructions": p.instructions } },
            });
            retry429(|| hyades("/systemone", Some(&body), TIMEOUT, &[200])).await
        }
        .await)
    }

    #[tool(
        title = "Hyades: generate 3D model",
        description = "Generate a 3D model from a text prompt or a local image and save it as a local file (usually .glb). Takes minutes; waits until done. \
                       Use only when the user wants an actual 3D model or mesh, not an image that merely looks 3D.",
        annotations(read_only_hint = false, destructive_hint = false, open_world_hint = true)
    )]
    async fn generate_3d_model(&self, Parameters(p): Parameters<Generate3dParams>) -> CallToolResult {
        respond(async {
            if p.prompt.is_none() && p.image.is_none() {
                return Err(HyadesError::new("bad_args", "provide prompt or image (local path to a source image)"));
            }
            let mut body = Map::new();
            if let Some(v) = p.remove_background {
                body.insert("remove_background".into(), json!(v));
            }
            if let Some(v) = p.seed {
                body.insert("seed".into(), json!(v));
            }
            if let Some(v) = p.steps {
                body.insert("steps".into(), json!(v));
            }
            if let Some(v) = p.response_format {
                body.insert("response_format".into(), json!(v));
            }
            if let Some(prompt) = p.prompt {
                body.insert("prompt".into(), json!(prompt));
            }
            if let Some(image) = p.image {
                body.insert("image_url".into(), json!(image_data_url(&image, "image")?));
            }
            generate_3d(Value::Object(body), p.timeout_ms.unwrap_or(600_000)).await
        }
        .await)
    }
}

#[tool_handler(
    name = "hyades-gateway",
    version = "1.2.0",
    instructions = "Tools for the Hyades gateway: qwen chat, image generation and editing, Clef decisions and 3D models. \
                    The using-hyades-tools skill says which tool fits a request and how to handle each error code."
)]
impl ServerHandler for Hyades {}

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    Hyades.serve(stdio()).await?.waiting().await?;
    Ok(())
}
