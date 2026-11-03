# The orchestration API (the `api` service in deploy/compose.yaml), plan task O10.
#   docker build -f control-plane/Dockerfile -t mergit-api:local .
# Build from the repository root, like deploy/docker/rust.Dockerfile: mergit_receipt is a path
# dependency on ../runtime/py (runtime/py/README.md), and that crate is itself a member of the
# repo's Cargo workspace, so the build needs the whole tree, not just control-plane/.

FROM python:3.13-slim AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl build-essential pkg-config ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# mergit_receipt is built from source by maturin at `uv sync` time; needs a Rust toolchain
# (runtime/py/README.md), pinned to the workspace's rust-version (Cargo.toml).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain 1.98
ENV PATH="/root/.cargo/bin:${PATH}"
RUN pip install --no-cache-dir uv

WORKDIR /src
COPY . .
WORKDIR /src/control-plane
RUN uv sync --locked --python 3.13 --no-dev

FROM python:3.13-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 mergit
WORKDIR /app
COPY --from=builder /src/control-plane/.venv .venv
COPY control-plane/mergit_cp mergit_cp
# app.py imports mergit_worker.meter (the shared price table); the API never touches the rest of it.
COPY control-plane/mergit_worker mergit_worker
COPY control-plane/migrations migrations
# Plans and events are validated against spec/schemas (mergit_cp/spec.py); without them every plan draft fails.
COPY spec/schemas spec/schemas
ENV MERGIT_SPEC_DIR=/app/spec
COPY control-plane/agents.toml control-plane/prices.toml ./
COPY deploy/agents.local.json deploy/agents.local.json
ENV PATH="/app/.venv/bin:${PATH}"
USER mergit
EXPOSE 8000
# Not "uvicorn ...": that entry-point script's shebang bakes in the builder stage's absolute venv
# path (/src/control-plane/.venv/bin/python), which doesn't exist once .venv is copied to /app here.
# "python -m uvicorn" only needs python itself, whose own path is a stage-independent symlink.
CMD ["python", "-m", "uvicorn", "mergit_cp.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
