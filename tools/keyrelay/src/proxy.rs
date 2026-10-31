//! The proxy: forwards `/v1/*` to a provider with a pooled key swapped in, and rotates on 429/401/403.
//!
//! Streaming works because the status line is decided before any body byte is sent: a 429 or 401 arrives as the
//! response head, so a retry happens before the caller has seen a byte. After the head the body is streamed
//! through untouched, and a failure mid-stream is the caller's to see (it cannot be recovered).

use crate::pool::{Handle, Policy, Pool, Unavailable};
use anyhow::{Result, bail};
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use axum::routing::get;
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_BODY: usize = 32 * 1024 * 1024;
/// Retries on the same key for 5xx and transport errors (they are not quota problems).
const SAME_KEY_RETRIES: u32 = 2;
pub const STATUS_PATH: &str = "/_keyrelay/status";

pub struct ProviderInit {
    pub name: String,
    /// What `/v1` maps to, e.g. `https://api.groq.com/openai/v1`.
    pub base_url: String,
    pub keys: Vec<String>,
    pub policy: Policy,
    /// Keys tried per request. 0 means the number of keys plus one.
    pub max_attempts: usize,
}

struct Provider {
    name: String,
    base_url: String,
    pool: Mutex<Pool>,
    max_attempts: usize,
}

impl Provider {
    fn acquire(&self) -> Result<(Handle, Arc<str>), Unavailable> {
        self.pool.lock().expect("pool lock").acquire(Instant::now())
    }

    fn rate_limited(&self, h: Handle, retry_after: Option<Duration>) {
        let rotated =
            self.pool
                .lock()
                .expect("pool lock")
                .rate_limited(h, retry_after, Instant::now());
        if rotated {
            let secs =
                retry_after.map_or_else(|| "default".to_string(), |d| format!("{}s", d.as_secs()));
            tracing::info!(provider = %self.name, key = h.index(), retry_after = %secs, "key rate limited; moved to the bottom");
        }
    }

    fn auth_failed(&self, h: Handle) {
        self.pool.lock().expect("pool lock").auth_failed(h);
        tracing::warn!(provider = %self.name, key = h.index(), "key refused (401/403); set aside until restart");
    }
}

struct Inner {
    token: String,
    providers: HashMap<String, Provider>,
    client: reqwest::Client,
    backoff: Duration,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl AppState {
    pub fn new(token: String, providers: Vec<ProviderInit>, backoff: Duration) -> Result<Self> {
        if token.is_empty() {
            bail!("the proxy token is empty");
        }
        if providers.is_empty() {
            bail!("no providers configured");
        }
        let mut map = HashMap::new();
        for p in providers {
            for (i, k) in p.keys.iter().enumerate() {
                if HeaderValue::from_str(&format!("Bearer {k}")).is_err() {
                    bail!(
                        "provider {}: key #{i} contains characters that cannot be sent in a header",
                        p.name
                    );
                }
            }
            let attempts = if p.max_attempts == 0 {
                p.keys.len() + 1
            } else {
                p.max_attempts
            };
            let Some(pool) = Pool::new(p.keys, p.policy) else {
                bail!("provider {} has no keys", p.name);
            };
            let provider = Provider {
                name: p.name.clone(),
                base_url: p.base_url,
                pool: Mutex::new(pool),
                max_attempts: attempts,
            };
            if map.insert(p.name.clone(), provider).is_some() {
                bail!("provider name {} is used twice", p.name);
            }
        }
        Ok(Self(Arc::new(Inner {
            token,
            providers: map,
            client: reqwest::Client::builder().build()?,
            backoff,
        })))
    }

    /// `/v1/...` when there is one provider, else `/<name>/v1/...`. Returns the provider and the path after `/v1`.
    fn route<'a>(&'a self, path: &'a str) -> Option<(&'a Provider, &'a str)> {
        let p = path.strip_prefix('/')?;
        if self.0.providers.len() == 1
            && let Some(rest) = p.strip_prefix("v1")
            && (rest.is_empty() || rest.starts_with('/'))
        {
            return Some((self.0.providers.values().next()?, rest));
        }
        let (name, after) = p.split_once('/')?;
        let provider = self.0.providers.get(name)?;
        let rest = after.strip_prefix("v1")?;
        (rest.is_empty() || rest.starts_with('/')).then_some((provider, rest))
    }

    fn authorised(&self, headers: &HeaderMap) -> bool {
        let presented = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        presented.is_some_and(|p| constant_time_eq(p.as_bytes(), self.0.token.as_bytes()))
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route(STATUS_PATH, get(status))
        .fallback(proxy)
        .with_state(state)
}

fn error(status: StatusCode, kind: &str, message: &str) -> Response {
    let body = serde_json::json!({"error": {"type": kind, "message": message}});
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("static response")
}

fn unavailable(u: Unavailable, keys: usize) -> Response {
    match u {
        Unavailable::AllLimited { next_at, limited } => {
            let wait = next_at.saturating_duration_since(Instant::now());
            let secs = wait.as_secs() + 1;
            let mut r = error(
                StatusCode::TOO_MANY_REQUESTS,
                "all_keys_limited",
                &format!(
                    "all {limited} of {keys} keys are rate limited; the first is usable again in about {secs}s"
                ),
            );
            r.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&secs.to_string()).expect("digits"),
            );
            r
        }
        Unavailable::AllDead => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "all_keys_dead",
            &format!("all {keys} keys were refused by the provider; replace them"),
        ),
    }
}

async fn status(State(st): State<AppState>, req: Request) -> Response {
    if !st.authorised(req.headers()) {
        return error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or wrong proxy token",
        );
    }
    let now = Instant::now();
    let providers: serde_json::Map<String, serde_json::Value> =
        st.0.providers
            .iter()
            .map(|(name, p)| {
                let keys = p.pool.lock().expect("pool lock").status(now);
                (
                    name.clone(),
                    serde_json::to_value(keys).expect("status serialises"),
                )
            })
            .collect();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({"providers": providers}).to_string(),
        ))
        .expect("static response")
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
    )
}

fn retry_after(r: &reqwest::Response) -> Option<Duration> {
    let secs: f64 = r
        .headers()
        .get(header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    (secs.is_finite() && secs > 0.0).then(|| Duration::from_secs_f64(secs.min(1e9)))
}

async fn send(
    client: &reqwest::Client,
    method: &Method,
    url: &str,
    headers: &HeaderMap,
    body: &Bytes,
    secret: &str,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut h = headers.clone();
    let mut auth = HeaderValue::from_str(&format!("Bearer {secret}"))
        .expect("validated when the pool was built");
    auth.set_sensitive(true);
    h.insert(header::AUTHORIZATION, auth);
    client
        .request(method.clone(), url)
        .headers(h)
        .body(body.clone())
        .send()
        .await
}

fn pass_through(r: reqwest::Response) -> Response {
    let mut builder = Response::builder().status(r.status());
    for (k, v) in r.headers() {
        if !is_hop_by_hop(k) {
            builder = builder.header(k, v);
        }
    }
    builder
        .body(Body::from_stream(r.bytes_stream()))
        .unwrap_or_else(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "bad_upstream",
                "the provider's response could not be relayed",
            )
        })
}

async fn proxy(State(st): State<AppState>, req: Request) -> Response {
    if !st.authorised(req.headers()) {
        return error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or wrong proxy token",
        );
    }
    let (parts, body) = req.into_parts();
    let Some((provider, rest)) = st.route(parts.uri.path()) else {
        return error(
            StatusCode::NOT_FOUND,
            "not_found",
            "no such route; use /v1/... or /<provider>/v1/...",
        );
    };
    let Ok(body) = axum::body::to_bytes(body, MAX_BODY).await else {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "the request body is too large",
        );
    };
    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!(
        "{}{}{}",
        provider.base_url.trim_end_matches('/'),
        rest,
        query
    );

    let mut headers = HeaderMap::new();
    for (k, v) in &parts.headers {
        // accept-encoding is dropped so the provider answers uncompressed and the body can be relayed as is.
        if !is_hop_by_hop(k) && k != header::AUTHORIZATION && k != header::ACCEPT_ENCODING {
            headers.append(k.clone(), v.clone());
        }
    }

    for _ in 0..provider.max_attempts {
        let (handle, secret) = match provider.acquire() {
            Ok(got) => got,
            Err(u) => return unavailable(u, key_count(provider)),
        };
        let mut tries = 0;
        let sent = loop {
            let result = send(&st.0.client, &parts.method, &url, &headers, &body, &secret).await;
            match &result {
                Ok(r) if r.status().is_server_error() && tries < SAME_KEY_RETRIES => {}
                Err(_) if tries < SAME_KEY_RETRIES => {}
                _ => break result,
            }
            tries += 1;
            tokio::time::sleep(st.0.backoff * tries).await;
        };
        match sent {
            Err(e) => {
                tracing::warn!(provider = %provider.name, key = handle.index(), "provider unreachable: {}", e.without_url());
                return error(
                    StatusCode::BAD_GATEWAY,
                    "upstream_unreachable",
                    "the provider could not be reached",
                );
            }
            Ok(r) => match r.status().as_u16() {
                429 => provider.rate_limited(handle, retry_after(&r)),
                401 | 403 => provider.auth_failed(handle),
                _ => return pass_through(r),
            },
        }
    }
    // Every attempt was a 429 or a refusal. Say why, from the pool's point of view.
    match provider.acquire() {
        Err(u) => unavailable(u, key_count(provider)),
        Ok(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "no_key_succeeded",
            "no key was accepted by the provider; try again",
        ),
    }
}

fn key_count(p: &Provider) -> usize {
    p.pool.lock().expect("pool lock").len()
}
