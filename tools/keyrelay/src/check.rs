//! `keyrelay check`: one cheap authenticated call per key, reported by index. Never prints a key.

use crate::config::{Loaded, read_provider_keys};
use anyhow::Result;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Valid,
    Dead,
    Limited,
    Error,
}

pub fn classify(status: u16) -> Verdict {
    match status {
        200..=299 => Verdict::Valid,
        401 | 403 => Verdict::Dead,
        429 => Verdict::Limited,
        _ => Verdict::Error,
    }
}

/// Prints `provider key #i: <verdict>` for every key; returns how many are not valid.
pub async fn run(loaded: &Loaded) -> Result<usize> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let mut not_valid = 0;
    for p in &loaded.config.providers {
        let keys = read_provider_keys(p, &loaded.base_dir)?;
        let url = format!("{}/models", p.base_url.trim_end_matches('/'));
        for (i, key) in keys.iter().enumerate() {
            let verdict = match client.get(&url).bearer_auth(key).send().await {
                Ok(r) => classify(r.status().as_u16()),
                Err(_) => Verdict::Error,
            };
            if verdict != Verdict::Valid {
                not_valid += 1;
            }
            println!(
                "{} key #{i}: {}",
                p.name,
                format!("{verdict:?}").to_lowercase()
            );
        }
    }
    Ok(not_valid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_verdicts() {
        assert_eq!(classify(200), Verdict::Valid);
        assert_eq!(classify(401), Verdict::Dead);
        assert_eq!(classify(403), Verdict::Dead);
        assert_eq!(classify(429), Verdict::Limited);
        assert_eq!(classify(500), Verdict::Error);
        assert_eq!(classify(404), Verdict::Error);
    }
}
