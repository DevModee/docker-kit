---
name: container-triage
description: Diagnoses crashing, restarting, unhealthy, or OOMKilled containers with the docker-kit MCP tools. Reads container state, exit codes, health checks, logs, and resource usage, explains the root cause, and proposes a fix before restarting anything. Use when a container exits, keeps restarting, is unhealthy, runs out of memory, or the user asks why a container is not working.
---

# Container triage

## Context

docker-kit tools talk to the local Docker daemon. Container tools take a name or ID. If the container belongs to a Compose stack, the inspect output shows the project and its working directory; pass that path as `cwd` to `docker_compose_ps`, `docker_compose_logs`, and `docker_compose_up`.

## Steps

1. Find the container.
   - Call `docker_list_containers` (it includes stopped containers by default). Use `name` to narrow it down, or `status: "exited"` / `status: "restarting"` to find failing ones.
   - If several match, ask the user which one, or triage the one with the most recent failure.
2. Call `docker_inspect_container` with `container`. Read:
   - `state.status`, `state.exit_code`, `state.oom_killed`, `state.error`, `restart_count`, and `restart_policy`.
   - `state.health` and the output of the last checks.
   - `limits.memory`, `ports`, `mounts`, and `env` (secret values arrive already redacted).
3. Call `docker_container_logs` with `container` and `tail: 200`. If the error is older, add `since` (for example `"30m"`) or raise `tail` up to 1000. Use `timestamps: true` when you need to match log lines to `state.finished_at`.
4. For running containers, call `docker_container_stats` with `containers: ["<name>"]` to check CPU, memory against its limit, and PIDs.
5. Classify the failure using the exit code and logs:
   - Exit 137 with `oom_killed: true`: out of memory. Compare usage with `limits.memory`.
   - Exit 137 without OOM, or 143: killed by a signal (stop timeout, host, or orchestrator).
   - Exit 1 or 2 with a stack trace: application error. Find the file and line in the workspace.
   - Exit 126 or 127: command not executable or not found. Check the image `CMD`/`ENTRYPOINT` and the `command` field.
   - Unhealthy: the health check fails. Read its output; often a wrong port, path, or missing tool such as `curl` in the image.
   - Restart loop: a dependency is down (database, cache) or configuration is missing. Look for connection refused errors and missing variables.
6. Report to the user:
   - Container, image, state, exit code, and restart count.
   - Root cause in one or two sentences, with the few log lines that prove it.
   - The proposed fix: code, configuration, memory limit, health check, or dependency order.
7. Only after the user agrees, apply the fix in the workspace. Restart with `docker_restart_container` (state-changing, confirm first) or, for Compose services, with `docker_compose_up` and the right `cwd`.
8. Verify: call `docker_inspect_container` and `docker_container_logs` again and confirm the container stays up.

## Notes

- Never print values from `.env` files or container environments. Refer to variables by name.
- Restarting a crash loop without a fix rarely helps. Say so if the user asks for it.
- Do not remove containers or volumes as part of triage.
