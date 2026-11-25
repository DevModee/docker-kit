---
name: compose-debug
description: Troubleshoots multi-service Docker Compose stacks with the docker-kit MCP tools. Checks service state, health, exit codes, and published ports, reads service logs, and inspects networks to find port conflicts, unhealthy dependencies, and connectivity problems. Use when docker compose up fails, a service is down or unhealthy, services cannot reach each other, or a port is already in use.
---

# Compose debug

## Context

Always pass `cwd` with the absolute path of the folder that holds the Compose file (usually the workspace root). Pass `file` too when the project uses a non-default file such as `compose.dev.yml`.

## Steps

1. Read the Compose file in the workspace (`compose.yaml`, `compose.yml`, `docker-compose.yml`, or the file the user names). Note services, `depends_on` conditions, `healthcheck`, `ports`, `networks`, and `env_file` entries.
2. Call `docker_compose_ps` with `cwd` (and `file`). For each service note `state`, `health`, `exit_code`, and `ports`.
   - If it returns no containers, the stack is not running or `cwd`/`file` point to the wrong project.
3. Call `docker_compose_logs` with `cwd` and `service` for each failing or unhealthy service. Start with `tail: 150`; then read the logs of the services it depends on.
4. Match the symptoms:
   - "port is already allocated" or "address already in use": another container or host process uses the port. Call `docker_list_containers` and look for the same published port.
   - A service exits right after start: read its logs, then use the `container-triage` steps with `docker_inspect_container`.
   - `depends_on` with `condition: service_healthy` never satisfied: the dependency health check fails. Read its health output with `docker_inspect_container`.
   - Connection refused or unknown host between services: services must use the service name and the container port, not `localhost` or the published port. Call `docker_list_networks` and check both services share a network; `docker_inspect_container` shows each container's networks and aliases.
   - Missing environment variables: compare the variable names the app expects with `environment` and `env_file`. Never print their values.
   - Volume permission errors: compare the container `user` with the mount source owner.
   - "container name ... is already in use": a leftover container with the same `container_name`, often from another checkout. Find it with `docker_list_containers` and `name`.
   - "pull access denied" or "manifest unknown": wrong image name or tag, or a private registry without `docker login`.
   - A build step fails during `docker compose up --build`: switch to the `dockerfile-audit` skill for the failing Dockerfile.
   - A service works but sees stale code: the image was not rebuilt, or a bind mount is shadowed by a named volume.
5. Report to the user:
   - Failing services with their state, health, and exit code.
   - Root cause in one or two sentences.
   - The log lines that prove it.
   - The exact change to the Compose file or app configuration.
6. Only after the user agrees, edit the files and call `docker_compose_up` with `cwd` (state-changing, confirm first). Add `build: true` when a Dockerfile or build context changed, and `services` to restart only the affected ones.
7. Verify with `docker_compose_ps` and `docker_compose_logs`.

## Notes

- Do not run `docker compose down -v` to "reset" a stack. It deletes database volumes; the safety hook will ask for confirmation and you must explain that first.
- The obsolete top-level `version` key only causes a warning; it is never the root cause.
- The Compose project name defaults to the folder name. Two folders with the same name share container and volume names.
