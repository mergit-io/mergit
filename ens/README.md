# mergit-ens

ENS gate checks for Mergit. Read-only on mainnet; role and gas tests run on a local anvil fork.
Design: `docs/HLD-ens-integration.md`. Plan: `docs/superpowers/plans/2026-11-06-ens-gate-m0-m1.md`.

Set `ENS_MAINNET_RPC` to an Ethereum mainnet RPC URL (never commit it). Without it, the tests that need a chain are skipped.

In a sandboxed shell, Node needs `NODE_USE_ENV_PROXY=1` so `fetch` honours the proxy settings.
