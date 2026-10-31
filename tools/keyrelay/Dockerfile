# keyrelay as a container. Build context is this directory:
#   docker build -t mergit-keyrelay tools/keyrelay
FROM rust:1.98-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/keyrelay /usr/local/bin/keyrelay
# The user is set by the compose file: it must be the host user that owns the secrets directory, so that it can
# read files that are mode 600.
EXPOSE 8787
ENTRYPOINT ["keyrelay"]
