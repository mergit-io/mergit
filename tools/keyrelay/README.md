# keyrelay

One OpenAI-compatible proxy in front of many API keys. Your projects point their base URL at it and send a dummy
key; keyrelay puts a real key on each request and rotates when one is spent.

Built with the `api-keys-ka-jugad` skill. Not specific to any project.

## Read this first

1. **Limits may be per organization, not per key.** For Groq (as I recall its docs: check the current ones), rate
   limits apply to the whole account, so many keys from one account share one limit and rotation gains nothing. It
   only helps with keys from separate accounts.
2. **Terms of service.** Using many separate accounts' free keys to get around limits may breach the provider's
   terms. Read them. That is your decision.
3. **There is no "credits left" to ask for.** On most free tiers keyrelay learns a key is spent only from a `429`.
   It reacts; it cannot know in advance.

## How it behaves

- Keys are an ordered list. The **last** line of the keys file is the top and is used first, and kept in use until
  it fails (LIFO), so keys are spent one at a time.
- **429**: that key is removed from the top, appended to the bottom, and put on a cooldown from `Retry-After`
  (default 60 s, clamped to `max_cooldown_s`). The same request is retried straight away on the next usable key.
- **401 / 403**: the key is revoked or invalid. It is set aside until the process restarts and logged by index.
- A key on cooldown is skipped. If every key is limited the caller gets `429` with `Retry-After` and a message
  saying when the first key is usable. If every key was refused the caller gets `503`.
- **5xx and network errors** are retried on the same key (twice), not rotated: they are not quota problems.
- Streaming works. A `429`/`401` arrives before the first byte, so the retry is invisible. A failure after bytes
  have been sent cannot be recovered and is passed through.
- A pool of one key works.

## Run it

```sh
cargo build --release                      # binary: target/release/keyrelay
cp keyrelay.example.toml keyrelay.toml     # git-ignored
printf '%s\n' "$(head -c 24 /dev/urandom | base64)" > proxy-token.txt && chmod 600 proxy-token.txt
# Put your keys, one per line, in groq-keys.txt (build it yourself; never paste keys into a chat or a ticket):
chmod 600 groq-keys.txt
./target/release/keyrelay check            # one cheap call per key: valid, dead, limited or error (by index)
./target/release/keyrelay serve            # keyrelay.toml in the current directory, or --config path
./target/release/keyrelay status           # which keys are ok / cooling / dead, by index
```

## Point a project at it

Set the provider's base URL to `http://127.0.0.1:8787/v1` and the API key to the contents of `proxy-token.txt`.
With several providers configured, use `http://127.0.0.1:8787/<name>/v1` instead.

Example with the OpenAI-compatible Python client:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key=open("proxy-token.txt").read().strip())
```

`base_url` in the config is what `/v1` maps to, so `https://api.groq.com/openai/v1` is right for Groq.

## Security

- Keys are read from a file (or environment variable) and held in memory. They are never logged: logs and `status`
  show a key's **index** in the file, nothing else. The pool's `Debug` output redacts them.
- Callers must send the proxy token. Without it every request is `401` and nothing reaches the provider. The server
  refuses to start with no token configured.
- It binds to `127.0.0.1` by default. Do not expose it to a network without something in front that authenticates.
- `keyrelay.toml`, key files, the token file and any state file are in `.gitignore`. The loader warns if a secrets
  file is readable by other users.

## systemd

```ini
[Unit]
Description=keyrelay
After=network.target

[Service]
ExecStart=/usr/local/bin/keyrelay serve --config /etc/keyrelay/keyrelay.toml
User=keyrelay
Restart=on-failure
# Keys and token live next to the config, readable only by the service user (chmod 600).

[Install]
WantedBy=multi-user.target
```

## Docker

```sh
docker run --rm -p 127.0.0.1:8787:8787 -v "$PWD/config:/etc/keyrelay:ro" keyrelay \
  serve --config /etc/keyrelay/keyrelay.toml   # set listen = "0.0.0.0:8787" inside the container only
```
(There is no published image; build one from a Rust base image and copy the release binary in.)

## Tests

```sh
cargo test    # 36 tests, all against a stub provider: no real key or network
```

Covered: LIFO order, rotation on 429 with the cooldown, cooling keys skipped, all-limited (429 with the soonest
time), a refused key set aside, all dead (503), 5xx retried on the same key, the token check, request body replayed
identically on retry, a stream retried before the first byte and passed through after, concurrent requests, a pool of
one, routing, and that no log line or proxy-written body contains any part of a key.

## Not done / not tested

- Not tested against a real provider, or with a long soak.
- Cooldowns are in memory only; a restart forgets them and may hit a spent key once before relearning.
- Each process has its own pool. Two keyrelay instances do not share cooldowns.
- No early rotation from `x-ratelimit-remaining-*` headers yet; it reacts to the 429.
