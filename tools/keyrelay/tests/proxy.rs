mod common;

use common::{B, TOKEN, fail_times, init, proxy_over, serve, stub};
use keyrelay::pool::Policy;
use keyrelay::proxy::AppState;
use std::time::Duration;

const CHAT: &str = "/v1/chat/completions";
const KEYS: [&str; 3] = ["secret-a", "secret-b", "secret-c"];

async fn key_of(r: reqwest::Response) -> String {
    assert_eq!(r.status(), 200);
    r.json::<serde_json::Value>().await.unwrap()["key"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn the_last_key_is_used_first_and_kept_while_it_works() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", B::Ok),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    for _ in 0..3 {
        assert_eq!(
            key_of(p.post(CHAT).body("{}").send().await.unwrap()).await,
            "secret-c"
        );
    }
}

#[tokio::test]
async fn a_429_rotates_the_key_and_the_same_request_succeeds_on_the_next() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", B::Limited(Some("30"))),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    assert_eq!(
        key_of(p.post(CHAT).body("{}").send().await.unwrap()).await,
        "secret-b"
    );
    assert_eq!(s.keys_seen(), vec!["secret-c", "secret-b"]);
    // The limited key is not tried again while it cools: the next request goes straight to secret-b.
    assert_eq!(
        key_of(p.post(CHAT).body("{}").send().await.unwrap()).await,
        "secret-b"
    );
    assert_eq!(s.keys_seen(), vec!["secret-c", "secret-b", "secret-b"]);

    let status: serde_json::Value = p
        .get("/_keyrelay/status")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let keys = status["providers"]["groq"].as_array().unwrap();
    let order: Vec<u64> = keys.iter().map(|k| k["index"].as_u64().unwrap()).collect();
    assert_eq!(order, vec![1, 0, 2], "key #2 went to the bottom");
    assert_eq!(keys[2]["state"], "cooling");
}

#[tokio::test]
async fn when_every_key_is_limited_the_caller_gets_a_429_with_the_soonest_time() {
    let s = stub(vec![
        ("secret-a", B::Limited(Some("30"))),
        ("secret-b", B::Limited(Some("30"))),
        ("secret-c", B::Limited(Some("30"))),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    let r = p.post(CHAT).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 429);
    let wait: u64 = r.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((30..=31).contains(&wait), "retry-after was {wait}");
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["error"]["type"], "all_keys_limited");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("3 of 3")
    );
    assert_eq!(
        s.keys_seen().len(),
        3,
        "each key was tried once, then the proxy stopped"
    );
    // A second request does not touch the provider at all: every key is cooling.
    assert_eq!(p.post(CHAT).body("{}").send().await.unwrap().status(), 429);
    assert_eq!(s.keys_seen().len(), 3);
}

#[tokio::test]
async fn a_401_sets_the_key_aside_for_good_and_the_request_goes_on() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", B::Unauthorized),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    assert_eq!(
        key_of(p.post(CHAT).body("{}").send().await.unwrap()).await,
        "secret-b"
    );
    for _ in 0..3 {
        assert_eq!(
            key_of(p.post(CHAT).body("{}").send().await.unwrap()).await,
            "secret-b"
        );
    }
    let c_calls = s.keys_seen().iter().filter(|k| *k == "secret-c").count();
    assert_eq!(c_calls, 1, "the refused key was never used again");
}

#[tokio::test]
async fn when_every_key_is_refused_the_caller_gets_a_503() {
    let s = stub(vec![]).await; // every key is unknown to the provider: 401
    let p = proxy_over(&s, &KEYS).await;
    let r = p.post(CHAT).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 503);
    assert_eq!(
        r.json::<serde_json::Value>().await.unwrap()["error"]["type"],
        "all_keys_dead"
    );
}

#[tokio::test]
async fn a_5xx_is_retried_on_the_same_key_and_the_key_is_not_rotated() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", fail_times(1)),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    assert_eq!(
        key_of(p.post(CHAT).body("{}").send().await.unwrap()).await,
        "secret-c"
    );
    assert_eq!(s.keys_seen(), vec!["secret-c", "secret-c"]);
}

#[tokio::test]
async fn a_persistent_5xx_is_returned_to_the_caller_and_does_not_burn_other_keys() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", fail_times(100)),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    let r = p.post(CHAT).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 500);
    assert_eq!(
        s.keys_seen(),
        vec!["secret-c"; 3],
        "one try plus two retries, same key"
    );
}

#[tokio::test]
async fn a_request_without_the_proxy_token_never_reaches_the_provider() {
    let s = stub(vec![("secret-a", B::Ok)]).await;
    let p = proxy_over(&s, &["secret-a"]).await;
    let none = p
        .client
        .post(format!("{}{CHAT}", p.base))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(none.status(), 401);
    let wrong = p
        .client
        .post(format!("{}{CHAT}", p.base))
        .bearer_auth("not-the-token")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 401);
    let status = p
        .client
        .get(format!("{}/_keyrelay/status", p.base))
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), 401);
    assert!(s.keys_seen().is_empty());
}

#[tokio::test]
async fn the_body_is_replayed_identically_on_the_retry() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", B::Limited(None)),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    let body = format!(
        r#"{{"messages":[{{"role":"user","content":"{}"}}]}}"#,
        "x".repeat(200_000)
    );
    assert_eq!(
        key_of(p.post(CHAT).body(body.clone()).send().await.unwrap()).await,
        "secret-b"
    );
    let seen = s.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].1, body.as_bytes());
    assert_eq!(seen[1].1, body.as_bytes());
}

#[tokio::test]
async fn a_429_before_the_first_byte_is_retried_and_a_stream_is_relayed() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Stream),
        ("secret-c", B::Limited(Some("30"))),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    let r = p.post(CHAT).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.text().await.unwrap(), "abc");
    assert_eq!(s.keys_seen(), vec!["secret-c", "secret-b"]);
}

#[tokio::test]
async fn a_failure_after_the_stream_started_is_passed_through_and_not_retried() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", B::MidStreamFail),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    let r = p.post(CHAT).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 200, "the head was already sent");
    assert!(r.text().await.is_err(), "the caller sees the broken stream");
    assert_eq!(
        s.keys_seen(),
        vec!["secret-c"],
        "no retry once bytes were sent"
    );
}

#[tokio::test]
async fn status_lists_indexes_and_states_and_never_a_key() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", B::Limited(Some("30"))),
    ])
    .await;
    let p = proxy_over(&s, &KEYS).await;
    p.post(CHAT).body("{}").send().await.unwrap();
    let text = p
        .get("/_keyrelay/status")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!text.contains("secret"), "{text}");
    assert!(text.contains("cooling") && text.contains("ok"));
}

#[tokio::test]
async fn many_parallel_requests_survive_the_top_key_being_limited() {
    let s = stub(vec![
        ("secret-a", B::Ok),
        ("secret-b", B::Ok),
        ("secret-c", B::Limited(Some("30"))),
    ])
    .await;
    let p = std::sync::Arc::new(proxy_over(&s, &KEYS).await);
    let tasks: Vec<_> = (0..40)
        .map(|_| {
            let p = std::sync::Arc::clone(&p);
            tokio::spawn(async move { p.post(CHAT).body("{}").send().await.unwrap().status() })
        })
        .collect();
    for t in tasks {
        assert_eq!(t.await.unwrap(), 200);
    }
    let status: serde_json::Value = p
        .get("/_keyrelay/status")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        status["providers"]["groq"].as_array().unwrap().len(),
        3,
        "no key lost or duplicated"
    );
}

#[tokio::test]
async fn a_missing_retry_after_uses_the_configured_default_cooldown() {
    let s = stub(vec![("secret-a", B::Limited(None))]).await;
    let p = proxy_over(&s, &["secret-a"]).await;
    assert_eq!(p.post(CHAT).body("{}").send().await.unwrap().status(), 429);
    let status: serde_json::Value = p
        .get("/_keyrelay/status")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let wait = status["providers"]["groq"][0]["usable_in_s"]
        .as_u64()
        .unwrap();
    assert!(
        (55..=61).contains(&wait),
        "default cooldown is 60s, got {wait}"
    );
}

#[tokio::test]
async fn a_pool_of_one_works_and_names_itself_when_limited() {
    let s = stub(vec![("secret-a", B::Limited(Some("5")))]).await;
    let p = proxy_over(&s, &["secret-a"]).await;
    let r = p.post(CHAT).body("{}").send().await.unwrap();
    assert_eq!(r.status(), 429);
    let body: serde_json::Value = r.json().await.unwrap();
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("1 of 1")
    );
}

#[tokio::test]
async fn routes_by_provider_name_and_rejects_unknown_paths() {
    let s = stub(vec![("secret-a", B::Ok)]).await;
    let p = proxy_over(&s, &["secret-a"]).await;
    assert_eq!(
        key_of(
            p.post("/groq/v1/chat/completions")
                .body("{}")
                .send()
                .await
                .unwrap()
        )
        .await,
        "secret-a"
    );
    assert_eq!(
        p.post("/nope/v1/x")
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        p.post("/v2/chat/completions")
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}

#[tokio::test]
async fn with_two_providers_the_bare_v1_path_is_ambiguous_and_refused() {
    let one = stub(vec![("a-key", B::Ok)]).await;
    let two = stub(vec![("b-key", B::Ok)]).await;
    let state = AppState::new(
        TOKEN.into(),
        vec![
            init(
                "one",
                &format!("{}/v1", one.url),
                &["a-key"],
                Policy::default(),
            ),
            init(
                "two",
                &format!("{}/v1", two.url),
                &["b-key"],
                Policy::default(),
            ),
        ],
        Duration::from_millis(1),
    )
    .unwrap();
    let p = serve(state).await;
    assert_eq!(
        p.post("/v1/chat/completions")
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        key_of(
            p.post("/one/v1/chat/completions")
                .body("{}")
                .send()
                .await
                .unwrap()
        )
        .await,
        "a-key"
    );
    assert_eq!(
        key_of(
            p.post("/two/v1/chat/completions")
                .body("{}")
                .send()
                .await
                .unwrap()
        )
        .await,
        "b-key"
    );
}

#[tokio::test]
async fn an_unreachable_provider_is_a_502_and_does_not_rotate_keys() {
    let state = AppState::new(
        TOKEN.into(),
        vec![init(
            "groq",
            "http://127.0.0.1:9/v1",
            &KEYS,
            Policy::default(),
        )],
        Duration::from_millis(1),
    )
    .unwrap();
    let p = serve(state).await;
    assert_eq!(p.post(CHAT).body("{}").send().await.unwrap().status(), 502);
    let status: serde_json::Value = p
        .get("/_keyrelay/status")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let all_ok = status["providers"]["groq"]
        .as_array()
        .unwrap()
        .iter()
        .all(|k| k["state"] == "ok");
    assert!(all_ok, "a network failure is not a quota problem");
}

#[tokio::test]
async fn a_key_that_cannot_be_sent_in_a_header_is_refused_at_start_without_printing_it() {
    let err = AppState::new(
        TOKEN.into(),
        vec![init(
            "groq",
            "http://x/v1",
            &["fine", "bad\nkey-needle"],
            Policy::default(),
        )],
        Duration::from_millis(1),
    )
    .err()
    .expect("must be refused")
    .to_string();
    assert!(err.contains("key #1"), "{err}");
    assert!(!err.contains("needle"), "{err}");
}
