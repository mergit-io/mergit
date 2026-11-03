//! One test, in its own process, because it installs the global log subscriber to capture every line.
mod common;

use common::{B, TOKEN, init, proxy_over, serve, stub};
use keyrelay::pool::Policy;
use keyrelay::proxy::AppState;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn no_log_line_and_no_error_body_contains_any_part_of_a_key() {
    let logs = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&logs);
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(move || Capture(Arc::clone(&sink)))
            .finish(),
    )
    .unwrap();

    // Rotation (429), a refused key (401), a retried 5xx, an unreachable provider, all-limited and all-dead.
    let s = stub(vec![
        ("needle-aaaa", B::Ok),
        ("needle-bbbb", B::Unauthorized),
        ("needle-cccc", B::Limited(Some("30"))),
    ])
    .await;
    let p = proxy_over(&s, &["needle-aaaa", "needle-bbbb", "needle-cccc"]).await;
    // Only what the proxy itself writes is checked. A 200 body is the provider's own answer, relayed untouched (the
    // stub echoes the key it got in that body, which a real provider does not).
    let mut bodies = Vec::new();
    for _ in 0..3 {
        let r = p
            .post("/v1/chat/completions")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
    }
    bodies.push(
        p.get("/_keyrelay/status")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    );

    let all_dead = stub(vec![]).await;
    let dead = proxy_over(&all_dead, &["needle-dddd", "needle-eeee"]).await;
    bodies.push(
        dead.post("/v1/x")
            .body("{}")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    );

    let unreachable = serve(
        AppState::new(
            TOKEN.into(),
            vec![init(
                "g",
                "http://127.0.0.1:9/v1",
                &["needle-ffff"],
                Policy::default(),
            )],
            Duration::from_millis(1),
        )
        .unwrap(),
    )
    .await;
    bodies.push(
        unreachable
            .post("/g/v1/x")
            .body("{}")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    );

    let log_text = String::from_utf8(logs.lock().unwrap().clone()).unwrap();
    assert!(
        log_text.contains("rate limited"),
        "the test must have exercised the rotation log: {log_text}"
    );
    assert!(
        log_text.contains("refused"),
        "and the refusal log: {log_text}"
    );
    for (name, text) in std::iter::once(("log", log_text.as_str()))
        .chain(bodies.iter().map(|b| ("body", b.as_str())))
    {
        assert!(
            !text.contains("needle"),
            "a key leaked into a {name}: {text}"
        );
    }
}
