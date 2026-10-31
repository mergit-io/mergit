use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use keyrelay::config::Config;
use keyrelay::{check, proxy};
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "keyrelay",
    about = "One OpenAI-compatible proxy in front of many API keys",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the proxy.
    Serve {
        #[arg(long, default_value = "keyrelay.toml")]
        config: PathBuf,
    },
    /// Show each key's state (by index) on a running proxy.
    Status {
        #[arg(long, default_value = "keyrelay.toml")]
        config: PathBuf,
    },
    /// Call each provider once per key and report valid, dead, limited or error (by index).
    Check {
        #[arg(long, default_value = "keyrelay.toml")]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    match run(Cli::parse()).await {
        Ok(code) => code,
        Err(e) => {
            eprintln!("keyrelay: {e:#}");
            ExitCode::from(2)
        }
    }
}

async fn run(cli: Cli) -> Result<ExitCode> {
    match cli.command {
        Command::Serve { config } => {
            let loaded = Config::load(&config)?;
            let state = loaded.build_state()?;
            let listener = tokio::net::TcpListener::bind(&loaded.config.server.listen)
                .await
                .with_context(|| format!("cannot listen on {}", loaded.config.server.listen))?;
            tracing::info!(
                "listening on {} for {} provider(s)",
                loaded.config.server.listen,
                loaded.config.providers.len()
            );
            axum::serve(listener, proxy::app(state))
                .with_graceful_shutdown(async {
                    let _ = tokio::signal::ctrl_c().await;
                })
                .await?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Status { config } => {
            let loaded = Config::load(&config)?;
            let url = format!(
                "http://{}{}",
                loaded.config.server.listen,
                proxy::STATUS_PATH
            );
            let body = reqwest::Client::new()
                .get(&url)
                .bearer_auth(loaded.token()?)
                .send()
                .await
                .with_context(|| {
                    format!("is keyrelay running on {}?", loaded.config.server.listen)
                })?
                .error_for_status()?
                .text()
                .await?;
            let v: serde_json::Value = serde_json::from_str(&body)?;
            println!("{}", serde_json::to_string_pretty(&v)?);
            Ok(ExitCode::SUCCESS)
        }
        Command::Check { config } => {
            let loaded = Config::load(&config)?;
            let not_valid = check::run(&loaded).await?;
            Ok(if not_valid == 0 {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
    }
}
