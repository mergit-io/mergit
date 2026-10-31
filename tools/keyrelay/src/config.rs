//! `keyrelay.toml`: where to listen, the caller token, and one or more providers with their key files.
//!
//! Paths in the file are relative to the file's own directory. Keys are read from a file (one per line; blank
//! lines and lines starting with `#` are skipped; duplicates are dropped) or from an environment variable
//! (newline or comma separated). Nothing here ever prints a key.

use crate::pool::Policy;
use crate::proxy::{AppState, ProviderInit};
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub server: Server,
    #[serde(rename = "provider")]
    pub providers: Vec<ProviderCfg>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Server {
    #[serde(default = "default_listen")]
    pub listen: String,
    /// File holding the token callers must send as `Authorization: Bearer <token>`.
    pub token_file: Option<PathBuf>,
    /// Or the name of an environment variable holding it.
    pub token_env: Option<String>,
}

fn default_listen() -> String {
    "127.0.0.1:8787".into()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderCfg {
    pub name: String,
    pub base_url: String,
    pub keys_file: Option<PathBuf>,
    pub keys_env: Option<String>,
    #[serde(default = "default_cooldown")]
    pub default_cooldown_s: u64,
    #[serde(default = "default_max_cooldown")]
    pub max_cooldown_s: u64,
    /// Keys tried per request; 0 means the number of keys plus one.
    #[serde(default)]
    pub max_attempts: usize,
}

fn default_cooldown() -> u64 {
    60
}

fn default_max_cooldown() -> u64 {
    86_400
}

pub struct Loaded {
    pub config: Config,
    pub base_dir: PathBuf,
}

impl Config {
    pub fn load(path: &Path) -> Result<Loaded> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read {}", path.display()))?;
        let config: Config =
            toml::from_str(&text).with_context(|| format!("{} is not valid", path.display()))?;
        let base_dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        Ok(Loaded { config, base_dir })
    }
}

fn resolve(base: &Path, p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

/// Warns (never fails) when a secrets file can be read by other users.
#[cfg(unix)]
fn warn_if_world_readable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path)
        && meta.permissions().mode() & 0o077 != 0
    {
        tracing::warn!(
            "{} is readable by other users; run chmod 600 on it",
            path.display()
        );
    }
}

#[cfg(not(unix))]
fn warn_if_world_readable(_path: &Path) {}

pub fn parse_keys(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split(['\n', ',']) {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !out.iter().any(|k| k == line) {
            out.push(line.to_string());
        }
    }
    out
}

fn read_token(server: &Server, base: &Path) -> Result<String> {
    let token = match (&server.token_file, &server.token_env) {
        (Some(f), _) => {
            let path = resolve(base, f);
            warn_if_world_readable(&path);
            std::fs::read_to_string(&path)
                .with_context(|| format!("cannot read {}", path.display()))?
        }
        (None, Some(var)) => {
            std::env::var(var).with_context(|| format!("environment variable {var} is not set"))?
        }
        (None, None) => {
            bail!("[server] needs token_file or token_env: the proxy must not be an open relay")
        }
    };
    let token = token.trim().to_string();
    if token.is_empty() {
        bail!("the proxy token is empty");
    }
    Ok(token)
}

pub fn read_provider_keys(p: &ProviderCfg, base: &Path) -> Result<Vec<String>> {
    let text = match (&p.keys_file, &p.keys_env) {
        (Some(f), _) => {
            let path = resolve(base, f);
            warn_if_world_readable(&path);
            std::fs::read_to_string(&path)
                .with_context(|| format!("cannot read {}", path.display()))?
        }
        (None, Some(var)) => {
            std::env::var(var).with_context(|| format!("environment variable {var} is not set"))?
        }
        (None, None) => bail!("provider {} needs keys_file or keys_env", p.name),
    };
    let keys = parse_keys(&text);
    if keys.is_empty() {
        bail!("provider {} has no keys", p.name);
    }
    Ok(keys)
}

impl Loaded {
    pub fn token(&self) -> Result<String> {
        read_token(&self.config.server, &self.base_dir)
    }

    pub fn build_state(&self) -> Result<AppState> {
        let mut providers = Vec::new();
        for p in &self.config.providers {
            if p.default_cooldown_s == 0 || p.max_cooldown_s < p.default_cooldown_s {
                bail!(
                    "provider {}: need 0 < default_cooldown_s <= max_cooldown_s",
                    p.name
                );
            }
            providers.push(ProviderInit {
                name: p.name.clone(),
                base_url: p.base_url.clone(),
                keys: read_provider_keys(p, &self.base_dir)?,
                policy: Policy {
                    default_cooldown: Duration::from_secs(p.default_cooldown_s),
                    min_cooldown: Duration::from_secs(1),
                    max_cooldown: Duration::from_secs(p.max_cooldown_s),
                },
                max_attempts: p.max_attempts,
            });
        }
        AppState::new(self.token()?, providers, Duration::from_millis(250))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_skip_blanks_comments_and_duplicates_and_keep_order() {
        let keys = parse_keys("# my keys\n\nk1\n k2 \nk1\n,k3,\n");
        assert_eq!(keys, vec!["k1", "k2", "k3"]);
    }

    #[test]
    fn an_unknown_config_field_is_an_error_not_silently_ignored() {
        let bad = "[server]\nlisten = \"127.0.0.1:1\"\ntoken_env = \"T\"\nlstn = 1\n[[provider]]\nname=\"a\"\nbase_url=\"http://x\"\n";
        assert!(toml::from_str::<Config>(bad).is_err());
    }

    #[test]
    fn a_server_without_a_token_source_is_refused() {
        let server = Server {
            listen: "127.0.0.1:1".into(),
            token_file: None,
            token_env: None,
        };
        let err = read_token(&server, Path::new(".")).unwrap_err().to_string();
        assert!(err.contains("open relay"), "{err}");
    }
}
