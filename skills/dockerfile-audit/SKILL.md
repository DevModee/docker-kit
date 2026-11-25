---
name: dockerfile-audit
description: Audits a workspace Dockerfile and .dockerignore for layer caching order, multi-stage builds, non-root users, pinned base images, secrets in layers, and image size, and compares the result with the built images reported by docker-kit. Use when the user asks to review, optimize, slim down, or harden a Dockerfile, or when builds are slow or images are large.
---

# Dockerfile audit

## Context

Work on the files in the current workspace. Pass `cwd` with the absolute workspace path to `docker_compose_up` when you rebuild. The audit itself is read-only: propose changes and apply them only when the user agrees.

## Steps

1. Find the files: `Dockerfile`, `*.Dockerfile`, `Dockerfile.*`, `.dockerignore`, and the `build` sections of the Compose file, which may point to another `context` or `dockerfile`.
2. Read the Dockerfile and check each area below. Cite the line for every finding.
3. Base image:
   - Pinned tag (`node:20.12-alpine`), not `latest` or a bare name. A digest pin (`@sha256:...`) is best for reproducible builds.
   - Smallest base that works: `-slim`, `-alpine`, or distroless for the runtime stage.
4. Layer caching order:
   - Copy dependency manifests first (`package.json` and lockfile, `requirements.txt`, `go.mod`, `Cargo.toml`), install, then `COPY` the rest of the source.
   - Use lockfile installs (`npm ci`, `pip install --no-cache-dir -r`, `go mod download`).
   - Combine `apt-get update` and `apt-get install` in one `RUN` and clean the package lists in the same layer.
5. Multi-stage builds: compilers, dev dependencies, and build tools stay in a builder stage; the final stage copies only the build output.
6. Security:
   - A non-root `USER` in the final stage.
   - No secrets in `ENV`, `ARG`, or copied files. Suggest BuildKit `--mount=type=secret` instead. Report the variable name only, never its value.
   - No `ADD` with remote URLs when `COPY` or a checksum-verified download works.
   - A `HEALTHCHECK` (or a Compose `healthcheck`) for long-running services.
7. `.dockerignore`: it should exclude `.git`, `node_modules`, build output, local env files (`.env*`), logs, and test artifacts. A missing `.dockerignore` sends the whole folder as build context.
8. Measure: call `docker_list_images` with `reference` set to the image name (for example `"myapp*"`) to see current sizes, and `docker_disk_usage` to see build cache size. Use these numbers in the report instead of guessing savings.
9. Report findings grouped by severity:
   - High: secrets in layers, running as root, unpinned `latest` base.
   - Medium: cache-busting order, single-stage build with dev tooling, missing `.dockerignore`.
   - Low: missing health check, minor size wins.
   For each finding give the line, the problem, and a corrected snippet.
10. If the user agrees, apply the changes. They can rebuild with `docker_compose_up` and `build: true` (state-changing, confirm first) and compare the new size with `docker_list_images`.

## Notes

- Keep behavior identical: same exposed ports, entrypoint, and working directory unless the user wants a change.
- Do not claim size savings that were not measured.
