# Sourced by update.sh (and by test-stack-check.sh).
#
# Every service on the server is long-running (`restart: unless-stopped`), so after a deploy anything that is not
# `running`, or whose healthcheck says unhealthy, is wrong: a restart loop (the gateway after #38 lost postgres's DNS
# alias), an exited container, a failed start. Health is empty for services without a healthcheck, hence the `|`
# separator: with spaces an empty field would shift the ones after it.
STACK_PS_FORMAT='{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}'

# stdin: lines from `docker compose ps -a --format "$STACK_PS_FORMAT"`; stdout: one service name per bad line.
unhealthy_services() {
  awk -F'|' '$2 != "running" || $3 == "unhealthy" { print $1 }'
}
