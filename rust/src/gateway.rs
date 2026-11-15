//! HTTP client for the Hyades gateway: key lookup, requests, error mapping and 429 retries.
use std::{env, fs, path::PathBuf, sync::LazyLock, time::Duration};

use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, body::Bytes};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use serde_json::Value;

/// Cloudflare in front of the gateway rejects requests without a User-Agent (error 1010).
const UA: &str = "hyades-plugin/1.2";

pub static BASE: LazyLock<String> = LazyLock::new(|| env::var("HYADES_BASE_URL").unwrap_or_else(|_| "https://hyades.gnostr.cloud/v1".into()));

// TLS uses rustls with bundled Mozilla roots rather than the OS store, so one static build per
// platform works everywhere (see Cargo.toml). The gateway presents a public Cloudflare certificate.
// Plain http stays allowed for local gateways (tests, HYADES_BASE_URL overrides).
static CLIENT: LazyLock<Client<hyper_rustls::HttpsConnector<HttpConnector>, Full<Bytes>>> = LazyLock::new(|| {
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
        .expect("TLS provider")
        .https_or_http()
        .enable_http1()
        .enable_http2()
        .build();
    Client::builder(TokioExecutor::new()).build(https)
});

/// Sends one request and returns status, content type and the full body.
async fn send(method: Method, url: &str, body: Option<Vec<u8>>, key: Option<&str>, timeout: Duration) -> Result<(u16, String, Bytes)> {
    let mut request = Request::builder().method(method).uri(url).header("user-agent", UA);
    if let Some(key) = key {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request
        .body(Full::new(Bytes::from(body.unwrap_or_default())))
        .map_err(|e| HyadesError::new("bad_args", format!("invalid request to {url}: {e}")))?;
    let exchange = async {
        let res = CLIENT.request(request).await.map_err(|e| HyadesError::new("network", format!("request to {url} failed: {e}")))?;
        let status = res.status().as_u16();
        let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        let bytes = res.into_body().collect().await.map_err(|e| HyadesError::new("network", format!("reading {url} failed: {e}")))?.to_bytes();
        Ok((status, content_type, bytes))
    };
    tokio::time::timeout(timeout, exchange)
        .await
        .unwrap_or_else(|_| Err(HyadesError::new("network", format!("request to {url} timed out after {}s", timeout.as_secs()))))
}

/// A failure the agent can act on; returned to it as `{ error, message, retryable }`.
#[derive(Debug)]
pub struct HyadesError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl HyadesError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), retryable: false }
    }
    fn retryable(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), retryable: true }
    }
}

pub type Result<T, E = HyadesError> = std::result::Result<T, E>;

// Key sources, first match wins:
//   1. HYADES_PLUGIN_API_KEY — the Claude Code plugin's saved `api_key` option
//   2. HYADES_API_KEY        — the user's environment
//   3. HYADES_KEY_FILE, then ~/.omp/agent/hyades.key
// The plugin option has its own variable so an unset option can't mask a user's HYADES_API_KEY.
// Hosts that don't fill in the option (unset in Claude Code, or omp) pass it empty or as the
// literal "${user_config.api_key}"; both count as unset.
fn env_value(name: &str) -> Option<String> {
    let v = env::var(name).ok()?.trim().to_owned();
    (!v.is_empty() && !v.starts_with("${")).then_some(v)
}

pub fn get_key() -> Result<String> {
    if let Some(key) = env_value("HYADES_PLUGIN_API_KEY").or_else(|| env_value("HYADES_API_KEY")) {
        return Ok(key);
    }
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let files = [env::var_os("HYADES_KEY_FILE").map(PathBuf::from), Some(home.join(".omp/agent/hyades.key"))];
    for path in files.into_iter().flatten() {
        if let Ok(key) = fs::read_to_string(&path) {
            return Ok(key.trim().to_owned());
        }
    }
    Err(HyadesError::new(
        "no_credential",
        "No Hyades API key. In Claude Code run `/plugin configure hyades@hyades-agent`; anywhere else set \
         HYADES_API_KEY or put the key in ~/.omp/agent/hyades.key (chmod 600).",
    ))
}

/// POST JSON when `body` is given, otherwise GET. `path` is relative to the base URL or absolute.
pub async fn hyades(path: &str, body: Option<&Value>, timeout: Duration, expect: &[u16]) -> Result<Value> {
    let url = if path.starts_with("http") { path.to_owned() } else { format!("{}{path}", *BASE) };
    let (method, payload) = match body {
        Some(body) => (Method::POST, Some(serde_json::to_vec(body).unwrap_or_default())),
        None => (Method::GET, None),
    };
    let (status, _, bytes) = send(method, &url, payload, Some(&get_key()?), timeout).await?;
    let detail = || String::from_utf8_lossy(&bytes).chars().take(300).collect::<String>();
    match status {
        // At most 2 requests may be in flight per key.
        429 => return Err(HyadesError::retryable("rate_limited", "429: tenant concurrency limit exceeded — too many in-flight requests")),
        401 => return Err(HyadesError::new("unauthorized", "401: key rejected (missing or invalid bearer)")),
        403 => return Err(HyadesError::new("forbidden", format!("403: this key is not authorized for the requested model or path. {}", detail()))),
        // An outage, not a bad request: retrying later can succeed.
        503 => return Err(HyadesError::retryable("backend_down", format!("503: upstream backend unavailable. {}", detail()))),
        _ => {}
    }
    if !expect.contains(&status) {
        return Err(HyadesError::new(&format!("http_{status}"), format!("HTTP {status} on {path}: {}", detail())));
    }
    serde_json::from_slice(&bytes).map_err(|e| HyadesError::new("unexpected_response", format!("invalid JSON from {path}: {e}")))
}

/// Default request timeout (4 min) for ordinary calls.
pub const TIMEOUT: Duration = Duration::from_secs(240);

/// Retries `rate_limited` with linear backoff (2.5 s, 5 s, …); other errors pass through.
pub async fn retry429<T, F, Fut>(mut call: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    for attempt in 1u64.. {
        match call().await {
            Err(e) if e.code == "rate_limited" && attempt <= 4 => tokio::time::sleep(Duration::from_millis(2500 * attempt)).await,
            other => return other,
        }
    }
    unreachable!()
}

/// Downloads a result URL. The key is sent only to the gateway's own host.
pub async fn download(url: &str) -> Result<(Vec<u8>, String)> {
    let target = url::Url::parse(url).map_err(|e| HyadesError::new("unexpected_response", format!("bad result URL {url}: {e}")))?;
    let same_host = url::Url::parse(&BASE).is_ok_and(|b| b.origin() == target.origin());
    let key = if same_host { Some(get_key()?) } else { None };
    let (status, content_type, bytes) = send(Method::GET, url, None, key.as_deref(), Duration::from_secs(300)).await?;
    if !(200..300).contains(&status) {
        return Err(HyadesError::new(&format!("http_{status}"), format!("Failed to download result: HTTP {status}")));
    }
    Ok((bytes.to_vec(), content_type))
}
