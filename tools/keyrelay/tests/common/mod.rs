//! A stub provider and a helper that serves the proxy on an ephemeral port. No real key or network is used.
#![allow(dead_code)]

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::any;
use keyrelay::pool::Policy;
use keyrelay::proxy::{AppState, ProviderInit, app};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const TOKEN: &str = "proxy-token";

/// (key presented, request body) for every request the provider received, in order.
pub type Seen = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

#[derive(Clone)]
pub enum B {
    /// 200 with the key echoed back so a test can see which key served it.
    Ok,
    /// 429, optionally with a Retry-After header value.
    Limited(Option<&'static str>),
    Unauthorized,
    /// 500 this many times, then 200.
    FailTimes(Arc<AtomicUsize>),
    /// 200 with the body "abc" in three chunks.
    Stream,
    /// 200, one chunk, then the connection breaks.
    MidStreamFail,
}

pub fn fail_times(n: usize) -> B {
    B::FailTimes(Arc::new(AtomicUsize::new(n)))
}

#[derive(Clone)]
pub struct Stub {
    pub url: String,
    pub seen: Seen,
}

impl Stub {
    pub fn keys_seen(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|(k, _)| k.clone())
            .collect()
    }
}

#[derive(Clone)]
struct StubState {
    behaviours: Arc<Vec<(String, B)>>,
    seen: Seen,
}

async fn handle(State(st): State<StubState>, headers: HeaderMap, body: Bytes) -> Response {
    let key = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_string();
    st.seen.lock().unwrap().push((key.clone(), body.to_vec()));
    let behaviour = st
        .behaviours
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, b)| b.clone());
    let json = |status: StatusCode, text: String| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(text))
            .unwrap()
    };
    match behaviour {
        None | Some(B::Unauthorized) => {
            json(StatusCode::UNAUTHORIZED, r#"{"error":"bad key"}"#.into())
        }
        Some(B::Ok) => json(StatusCode::OK, format!(r#"{{"ok":true,"key":"{key}"}}"#)),
        Some(B::Limited(retry_after)) => {
            let mut r = json(
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":"rate limited"}"#.into(),
            );
            if let Some(v) = retry_after {
                r.headers_mut()
                    .insert(header::RETRY_AFTER, v.parse().unwrap());
            }
            r
        }
        Some(B::FailTimes(left)) => {
            if left.load(Ordering::SeqCst) > 0 {
                left.fetch_sub(1, Ordering::SeqCst);
                json(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    r#"{"error":"boom"}"#.into(),
                )
            } else {
                json(StatusCode::OK, format!(r#"{{"ok":true,"key":"{key}"}}"#))
            }
        }
        Some(B::Stream) => {
            let chunks = futures_util::stream::unfold(0u8, |i| async move {
                if i == 3 {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
                let piece = Bytes::from(["a", "b", "c"][i as usize]);
                Some((Ok::<Bytes, std::io::Error>(piece), i + 1))
            });
            Response::builder()
                .status(StatusCode::OK)
                .body(Body::from_stream(chunks))
                .unwrap()
        }
        Some(B::MidStreamFail) => {
            // One chunk, then a pause long enough for the response head and that chunk to reach the proxy, then the
            // connection breaks. Failing at once would drop the head too, which is a different case (a 502).
            let chunks = futures_util::stream::unfold(0u8, |i| async move {
                match i {
                    0 => Some((Ok::<Bytes, std::io::Error>(Bytes::from("a")), 1)),
                    1 => {
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        Some((Err(std::io::Error::other("connection broke")), 2))
                    }
                    _ => None,
                }
            });
            Response::builder()
                .status(StatusCode::OK)
                .body(Body::from_stream(chunks))
                .unwrap()
        }
    }
}

/// Serves the stub on 127.0.0.1; `behaviours` maps the key a request carries to what the provider does.
/// A key that is not listed gets a 401.
pub async fn stub(behaviours: Vec<(&str, B)>) -> Stub {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let state = StubState {
        behaviours: Arc::new(
            behaviours
                .into_iter()
                .map(|(k, b)| (k.to_string(), b))
                .collect(),
        ),
        seen: Arc::clone(&seen),
    };
    let router = Router::new()
        .route("/v1/{*rest}", any(handle))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    Stub { url, seen }
}

pub fn init(name: &str, base_url: &str, keys: &[&str], policy: Policy) -> ProviderInit {
    ProviderInit {
        name: name.into(),
        base_url: base_url.into(),
        keys: keys.iter().map(|k| k.to_string()).collect(),
        policy,
        max_attempts: 0,
    }
}

pub struct Proxy {
    pub base: String,
    pub client: reqwest::Client,
}

impl Proxy {
    pub fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .get(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
    }

    pub fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}{path}", self.base))
            .bearer_auth(TOKEN)
    }
}

pub async fn serve(state: AppState) -> Proxy {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    Proxy {
        base,
        client: reqwest::Client::new(),
    }
}

/// One provider "groq" over the stub with the given keys; `keys` are in file order (the last is the top).
pub async fn proxy_over(stub: &Stub, keys: &[&str]) -> Proxy {
    let state = AppState::new(
        TOKEN.into(),
        vec![init(
            "groq",
            &format!("{}/v1", stub.url),
            keys,
            Policy::default(),
        )],
        Duration::from_millis(1),
    )
    .unwrap();
    serve(state).await
}
