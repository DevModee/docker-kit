# Docker Kit

Docker plugin for [Google Antigravity](https://antigravity.google). It bundles:

- An MCP server with 14 tools for containers, logs, resource stats, Docker Compose stacks, images, networks, volumes, and disk usage.
- 4 skills: container triage, Compose debugging, Dockerfile audit, and disk cleanup.
- A `PreToolUse` hook that blocks or asks before destructive docker commands.
- Plugin rules that keep container secrets out of output and require confirmation for state-changing actions.

The server and the hook use only Node.js built-ins. There is nothing to `npm install`.

## Requirements

- Node.js 20 or newer.
- The Docker CLI on `PATH` and a running daemon: Docker Desktop on Windows and macOS, or Docker Engine on Linux.
- Docker Compose v2 (`docker compose`) for the Compose tools.

The tools use the active Docker context, so `DOCKER_HOST` and `DOCKER_CONTEXT` work as they do in your terminal.

## Installation

From GitHub:

```bash
agy plugin install https://github.com/DevModee/docker-kit
```

From a local clone:

```bash
git clone https://github.com/DevModee/docker-kit.git
agy plugin validate --strict ./docker-kit
agy plugin install ./docker-kit
agy plugin list
```

## Tools

State-changing tools are marked with **write**. The plugin rules tell the agent to confirm them with you first.

| Tool | What it does | Required inputs |
|------|--------------|-----------------|
| `docker_info` | Client and server versions, OS and architecture, CPU and memory, container and image counts | none |
| `docker_list_containers` | Containers with ID, name, image, state, status, ports, and Compose project; filters `all`, `status`, `name`, `limit` | none |
| `docker_inspect_container` | State, exit code, OOMKilled, restart count, health checks, limits, ports, networks, mounts, and redacted environment | `container` |
| `docker_container_logs` | Last `tail` lines (default 150, max 1000) with stdout and stderr merged in time order; optional `since` and `timestamps` | `container` |
| `docker_container_stats` | One-time CPU, memory, network I/O, block I/O, and PIDs snapshot, sorted by memory use | none |
| `docker_list_images` | Repository, tag, ID, size, and age; filters `reference` (wildcards allowed) and `dangling_only` | none |
| `docker_list_networks` | ID, name, driver, and scope; filter `name` | none |
| `docker_list_volumes` | Name, driver, mountpoint, and owning Compose project; filter `dangling_only` | none |
| `docker_disk_usage` | Size and reclaimable space of images, containers, volumes, and build cache | none |
| `docker_compose_ps` | Services of a Compose stack with state, health, exit code, and published ports | `cwd` |
| `docker_compose_logs` | Logs for one `service` or all services, `tail` lines each | `cwd` |
| `docker_restart_container` | **write** Restart a container, with an optional stop `timeout` | `container` |
| `docker_stop_container` | **write** Stop a container without removing it | `container` |
| `docker_compose_up` | **write** `docker compose up -d` for all or some `services`, with optional `build` | `cwd` |

Compose tools need `cwd`, the absolute path of the folder that holds the Compose file. Pass `file` for a non-default file such as `compose.dev.yml`; relative paths resolve against `cwd`.

Timeouts are 15 s for read tools, 60 s for restart, stop, and `compose up`, and 10 min for `compose up` with `build: true`. Log and inspect output above 40000 characters is cut with a `[truncated: ...]` notice; logs keep the newest lines.

Errors are reported in plain terms: Docker CLI not found, Docker daemon not running, timeout, or the trimmed `stderr` of the failed command.

## Skills

| Skill | Use it to |
|-------|-----------|
| `container-triage` | Find out why a container exits, restarts, is unhealthy, or was OOMKilled, and propose a fix before restarting it. |
| `compose-debug` | Track down failing Compose services: port conflicts, unhealthy dependencies, networking, and missing configuration. |
| `dockerfile-audit` | Review a Dockerfile and `.dockerignore` for caching order, multi-stage builds, non-root users, pinned bases, and size. |
| `image-cleanup` | Measure disk usage and present a cleanup plan, safest first, before any prune or rm command runs. |

## Docker safety hook

`hooks/docker-guard.mjs` runs before every `run_command` call. It parses the command line (quotes, `&&`, `;`, pipes, subshells, environment prefixes, `sudo`, `docker.exe` and full paths, `docker --context`, `docker compose -f`, and `bash -c` / `powershell -Command` / `cmd /c` wrappers up to three levels) and returns one decision. The strictest decision across chained commands wins.

| Decision | Commands |
|----------|----------|
| `deny` | `docker system prune` with both `--all` and `--volumes`. `docker volume prune --force`. `docker volume rm --force`. |
| `force_ask` | Any other `docker system prune`. `docker volume rm`. `docker volume prune`. `docker compose down -v` / `--volumes`. `docker rm -f`. `docker rmi -f`. `docker image prune -a`. `docker container prune -f`. |
| `allow` | Everything else: `ps`, `logs`, `inspect`, `stats`, `images`, `info`, `system df`, `compose ps/logs/config`, `build`, `run`, `up`, `stop`, `restart`, and `compose down` without `-v`. |

If the payload cannot be parsed, the hook answers `allow` so it never blocks the agent by mistake.

## Security

- `docker` is always started with `execFile` and an argument array, never through a shell, so tool inputs cannot inject commands.
- Container, image, network, volume, and service names are validated and can never start with `-`, so they cannot be read as flags such as `--privileged`.
- `docker_inspect_container` redacts the values of environment variables whose names contain `SECRET`, `TOKEN`, `PASS`, `KEY`, `PRIVATE`, `AUTH`, `CREDENTIAL`, `DSN`, `COOKIE`, `JWT`, `DATABASE_URL`, or `REDIS_URL`, and masks passwords embedded in URLs (`postgres://user:[REDACTED]@db`). Command arguments such as `--password=...` are redacted the same way.

## Development

```bash
npm run lint   # node --check on every module, JSON parse, em-dash check
npm test       # node:test suites for the client, server, tools, hook, and manifest
npm start      # run the MCP server on stdio
```

The tests mock `execFile`, so they run without Docker installed.

```text
plugin.json             manifest (Antigravity schema v1)
mcp_config.json         MCP server registration
hooks.json              PreToolUse hook registration
src/docker.mjs          Docker CLI runner, validation, parsers, redaction
src/tools.mjs           tool schemas and handlers
src/server.mjs          JSON-RPC 2.0 stdio server
hooks/docker-guard.mjs  docker safety hook
skills/                 workflow skills
rules/AGENTS.md         plugin rules
tests/                  node:test suites
```

## License

[MIT](LICENSE)
