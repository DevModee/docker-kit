---
name: image-cleanup
description: Plans a safe Docker disk cleanup with the docker-kit MCP tools. Measures disk usage, lists dangling images and unused volumes, separates safe deletions from risky ones, and presents an explicit cleanup plan before any prune or rm command runs. Use when Docker uses too much disk, the disk is full, builds fail for lack of space, or the user asks to clean up images, containers, volumes, or build cache.
---

# Image cleanup

## Context

docker-kit tools are read-only here: they measure and list. Deletion runs through `docker` commands in the terminal, which the docker-kit safety hook checks. Pass `cwd` with the absolute workspace path if you check Compose projects with `docker_compose_ps`.

## Steps

1. Call `docker_disk_usage`. Note size and reclaimable space for Images, Containers, Local Volumes, and Build Cache.
2. Call `docker_list_images` with `dangling_only: true`. Dangling (untagged) images are safe to remove.
3. Call `docker_list_containers` with `status: "exited"` to find stopped containers. Note which belong to a Compose project (`compose_project`).
4. Call `docker_list_volumes` with `dangling_only: true`. For each volume note `compose_project` and the name. Volumes can hold databases and uploads: treat every volume as data until the user says otherwise.
5. Build the plan, from safest to riskiest:
   - Build cache: `docker builder prune` (safe; slower next build).
   - Dangling images: `docker image prune` (safe).
   - Stopped containers: `docker container prune`, or `docker rm <names>` for specific ones.
   - Unused tagged images: `docker image prune -a` removes every image not used by a container. Ask first; images will be pulled or rebuilt again.
   - Volumes: only `docker volume rm <name>` for volumes the user names explicitly. List each one with its Compose project.
   - Before `image prune -a`, check stopped Compose projects with `docker_compose_ps` and `cwd`: their images look unused and would be deleted.
6. Present the plan as a table and wait for the user to choose:

   | Command | Deletes | Space | Risk |
   |---------|---------|-------|------|
   | `docker builder prune` | Build cache | from step 1 | Low |
   | `docker image prune` | Dangling images | from step 1 | Low |
   | `docker image prune -a` | All unused images | from step 1 | Medium |
   | `docker volume rm <name>` | That volume and its data | unknown | High |

7. Run only the commands the user approved, one at a time. When the safety hook asks for confirmation, explain what will be deleted.
8. Call `docker_disk_usage` again and report the space recovered.

## Never

- `docker system prune -a --volumes` and `docker volume prune -f`: the hook blocks them because they delete every unused image and volume at once.
- `docker compose down -v` as a cleanup shortcut: it deletes the stack's volumes.
- Deleting volumes that belong to a Compose project the user did not mention.
