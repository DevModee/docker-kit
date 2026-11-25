// MCP tool definitions and handlers for docker-kit.
// Each tool is { name, description, inputSchema, handler(args) -> string }.

import {
  DockerError,
  WRITE_TIMEOUT_MS,
  mergeLogStreams,
  redactAssignment,
  redactEnvList,
  stripAnsi,
  truncateText,
  validateComposeFile,
  validateCwd,
  validateName,
  validateReference,
  validateSince,
} from './docker.mjs';

const FORMAT_JSON = ['--format', '{{json .}}'];
const BUILD_TIMEOUT_MS = 600000;
const COMPOSE_OUTPUT_MAX_CHARS = 8000;
const HEALTH_OUTPUT_MAX_CHARS = 500;
const HEALTH_CHECKS_SHOWN = 3;
const STATE_CHANGING = 'State-changing: confirm with the user first.';
const CONTAINER_STATES = ['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'];

// ---------------------------------------------------------------------------
// Argument normalization and validation (subset of JSON Schema used below).
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalize(schema, value) {
  if (value === undefined || value === null) {
    return schema.default !== undefined ? structuredClone(schema.default) : undefined;
  }
  if (schema.type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }
  if (schema.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  if (schema.type === 'array' && typeof value === 'string' && schema.items?.type === 'string') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  if (schema.type === 'object' && schema.properties && isPlainObject(value)) {
    const out = { ...value };
    for (const [key, sub] of Object.entries(schema.properties)) {
      const next = normalize(sub, value[key]);
      if (next === undefined) delete out[key];
      else out[key] = next;
    }
    return out;
  }
  return value;
}

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => isPlainObject(v),
};

function validate(schema, value, path) {
  const check = TYPE_CHECKS[schema.type];
  if (check && !check(value)) return `${path} must be of type ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (schema.type === 'string' && schema.minLength && value.trim().length < schema.minLength) {
    return `${path} must not be empty`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
  }
  if (Array.isArray(value) && schema.items) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${path} must have at most ${schema.maxItems} items`;
    }
    for (let i = 0; i < value.length; i += 1) {
      const err = validate(schema.items, value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  if (isPlainObject(value) && schema.properties) {
    const prefix = path === 'arguments' ? '' : `${path}.`;
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null) return `Missing required argument: ${prefix}${key}`;
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (value[key] === undefined) continue;
      const err = validate(sub, value[key], `${prefix}${key}`);
      if (err) return err;
    }
  }
  return null;
}

export function prepareArgs(schema, args) {
  const value = normalize(schema, args ?? {});
  const error = validate(schema, value, 'arguments');
  return { args: value, error };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const json = (value) => JSON.stringify(value, null, 2);

export function parseLabels(labels) {
  const out = {};
  if (isPlainObject(labels)) return { ...labels };
  for (const pair of String(labels || '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return null;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const percent = (text) => {
  const value = Number.parseFloat(String(text ?? '').replace('%', ''));
  return Number.isFinite(value) ? value : null;
};

function formatPortMap(ports) {
  const out = [];
  for (const [containerPort, bindings] of Object.entries(ports || {})) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
      out.push({ container_port: containerPort, published: null });
      continue;
    }
    for (const b of bindings) {
      out.push({ container_port: containerPort, published: `${b.HostIp || '0.0.0.0'}:${b.HostPort}` });
    }
  }
  return out;
}

function formatPublishers(publishers) {
  if (!Array.isArray(publishers)) return [];
  return publishers
    .filter((p) => p && p.PublishedPort)
    .map((p) => `${p.URL || '0.0.0.0'}:${p.PublishedPort}->${p.TargetPort}/${p.Protocol || 'tcp'}`);
}

function composeContext(args) {
  const cwd = validateCwd(args.cwd);
  const base = ['compose'];
  if (args.file !== undefined) base.push('--file', validateComposeFile(args.file, cwd));
  return { cwd, base };
}

function summarizeHealth(health) {
  if (!health) return null;
  const log = Array.isArray(health.Log) ? health.Log.slice(-HEALTH_CHECKS_SHOWN) : [];
  return {
    status: health.Status,
    failing_streak: health.FailingStreak,
    last_checks: log.map((entry) => ({
      at: entry.End || entry.Start,
      exit_code: entry.ExitCode,
      output: truncateText(String(entry.Output || '').trim(), HEALTH_OUTPUT_MAX_CHARS),
    })),
  };
}

export function summarizeContainer(data, { includeEnv = true } = {}) {
  const config = data.Config || {};
  const state = data.State || {};
  const host = data.HostConfig || {};
  const net = data.NetworkSettings || {};
  const labels = config.Labels || {};
  const command = [data.Path, ...(Array.isArray(data.Args) ? data.Args : [])].filter(Boolean).map(redactAssignment);

  const summary = {
    id: String(data.Id || '').slice(0, 12),
    name: String(data.Name || '').replace(/^\//, ''),
    image: config.Image,
    created: data.Created,
    command,
    working_dir: config.WorkingDir || null,
    user: config.User || null,
    state: {
      status: state.Status,
      running: state.Running,
      paused: state.Paused,
      restarting: state.Restarting,
      oom_killed: state.OOMKilled,
      dead: state.Dead,
      exit_code: state.ExitCode,
      error: state.Error || null,
      started_at: state.StartedAt,
      finished_at: state.FinishedAt,
      health: summarizeHealth(state.Health),
    },
    restart_count: data.RestartCount ?? 0,
    restart_policy: host.RestartPolicy ? host.RestartPolicy.Name || 'no' : null,
    limits: {
      memory: formatBytes(host.Memory) || 'unlimited',
      cpus: host.NanoCpus ? host.NanoCpus / 1e9 : null,
      pids: host.PidsLimit > 0 ? host.PidsLimit : null,
    },
    ports: formatPortMap(net.Ports),
    networks: Object.fromEntries(
      Object.entries(net.Networks || {}).map(([name, n]) => [
        name,
        { ip: n.IPAddress || null, gateway: n.Gateway || null, aliases: n.Aliases || [] },
      ]),
    ),
    mounts: (data.Mounts || []).map((m) => ({
      type: m.Type,
      name: m.Name || null,
      source: m.Source,
      destination: m.Destination,
      read_write: m.RW,
    })),
    compose: labels['com.docker.compose.project']
      ? {
          project: labels['com.docker.compose.project'],
          service: labels['com.docker.compose.service'] || null,
          working_dir: labels['com.docker.compose.project.working_dir'] || null,
        }
      : null,
  };
  if (includeEnv) summary.env = redactEnvList(config.Env);
  return summary;
}

// ---------------------------------------------------------------------------
// Schemas.
// ---------------------------------------------------------------------------

function schema(properties, required = []) {
  return { type: 'object', properties, required };
}

const CONTAINER = { type: 'string', minLength: 1, description: 'Container name or ID.' };
const CWD = {
  type: 'string',
  minLength: 1,
  description: 'Absolute path of the workspace that holds the Compose file. Always pass it explicitly.',
};
const FILE = { type: 'string', description: 'Compose file path, relative to cwd or absolute. Omit to use the default compose.yaml lookup.' };
const tailSchema = (description) => ({ type: 'integer', minimum: 1, maximum: 1000, default: 150, description });
const stopTimeout = {
  type: 'integer',
  minimum: 0,
  maximum: 600,
  description: 'Seconds to wait for a graceful stop before the container is killed (Docker default: 10).',
};

// ---------------------------------------------------------------------------
// Tools.
// ---------------------------------------------------------------------------

export function createTools(client) {
  const tools = [
    {
      name: 'docker_info',
      description: 'Show Docker client and server versions, OS and architecture, and container and image counts.',
      inputSchema: schema({}),
      async handler() {
        const [version, info] = await Promise.all([
          client.runJson(['version', ...FORMAT_JSON]),
          client.runJson(['info', ...FORMAT_JSON]),
        ]);
        if (Array.isArray(info.ServerErrors) && info.ServerErrors.length) {
          throw new DockerError(`Docker server error: ${info.ServerErrors.join('; ')}`);
        }
        const c = version.Client || {};
        const s = version.Server || {};
        return json({
          client: { version: c.Version, api_version: c.ApiVersion, os: c.Os, arch: c.Arch, context: c.Context },
          server: { version: s.Version, api_version: s.ApiVersion, os: s.Os, arch: s.Arch, kernel: s.KernelVersion },
          host: {
            name: info.Name,
            operating_system: info.OperatingSystem,
            cpus: info.NCPU,
            memory: formatBytes(info.MemTotal),
          },
          containers: {
            total: info.Containers,
            running: info.ContainersRunning,
            paused: info.ContainersPaused,
            stopped: info.ContainersStopped,
          },
          images: info.Images,
          storage_driver: info.Driver,
          root_dir: info.DockerRootDir,
          warnings: info.Warnings || [],
        });
      },
    },

    {
      name: 'docker_list_containers',
      description: 'List containers with ID, name, image, state, status, ports, and Compose project. Includes stopped containers by default.',
      inputSchema: schema({
        all: { type: 'boolean', default: true, description: 'Include stopped containers (default true).' },
        status: { type: 'string', enum: CONTAINER_STATES, description: 'Only containers in this state.' },
        name: { type: 'string', description: 'Only containers whose name contains this text.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Maximum containers to return (1-100, default 50).' },
      }),
      async handler(args) {
        const cmd = ['ps'];
        if (args.all) cmd.push('--all');
        if (args.status) cmd.push('--filter', `status=${args.status}`);
        if (args.name !== undefined) cmd.push('--filter', `name=${validateName(args.name, 'name')}`);
        cmd.push('--no-trunc', ...FORMAT_JSON);
        const rows = await client.runJsonLines(cmd);
        const containers = rows.slice(0, args.limit).map((r) => {
          const labels = parseLabels(r.Labels);
          return {
            id: String(r.ID || '').slice(0, 12),
            name: r.Names,
            image: r.Image,
            state: r.State,
            status: r.Status,
            ports: r.Ports || '',
            created: r.CreatedAt,
            compose_project: labels['com.docker.compose.project'] || null,
            compose_service: labels['com.docker.compose.service'] || null,
          };
        });
        return json({ total: rows.length, returned: containers.length, containers });
      },
    },

    {
      name: 'docker_inspect_container',
      description:
        'Inspect one container: state, exit code, OOMKilled, restart count, health checks, limits, ports, networks, mounts, ' +
        'and environment variables with secret-like values redacted.',
      inputSchema: schema(
        {
          container: CONTAINER,
          include_env: { type: 'boolean', default: true, description: 'Include environment variables (secret values are always redacted).' },
        },
        ['container'],
      ),
      async handler(args) {
        const container = validateName(args.container, 'container');
        const data = await client.runJson(['inspect', '--type', 'container', container]);
        const first = Array.isArray(data) ? data[0] : data;
        if (!first) throw new DockerError(`No such container: ${container}`);
        return client.truncate(json(summarizeContainer(first, { includeEnv: args.include_env })));
      },
    },

    {
      name: 'docker_container_logs',
      description: 'Fetch recent logs of a container, with stdout and stderr merged in time order. Long output keeps the newest lines.',
      inputSchema: schema(
        {
          container: CONTAINER,
          tail: tailSchema('Number of lines from the end (1-1000, default 150).'),
          since: { type: 'string', description: 'Only logs after this time: a timestamp (2024-01-02T15:04:05Z) or a duration (10m, 2h).' },
          timestamps: { type: 'boolean', default: false, description: 'Prefix each line with its timestamp.' },
        },
        ['container'],
      ),
      async handler(args) {
        const container = validateName(args.container, 'container');
        const cmd = ['logs', '--tail', String(args.tail), '--timestamps'];
        if (args.since !== undefined) cmd.push('--since', validateSince(args.since));
        cmd.push(container);
        const { stdout, stderr } = await client.runDocker(cmd);
        const text = mergeLogStreams(stdout, stderr, { keepTimestamps: args.timestamps });
        const scope = `last ${args.tail} lines${args.since ? `, since ${args.since}` : ''}`;
        return client.truncate(`Logs for ${container} (${scope}):\n${text || '(no log output)'}`, 'tail');
      },
    },

    {
      name: 'docker_container_stats',
      description: 'Show a one-time snapshot of CPU, memory, network I/O, block I/O, and PIDs for running containers, sorted by memory use.',
      inputSchema: schema({
        containers: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 50,
          description: 'Container names or IDs. Omit for all running containers.',
        },
      }),
      async handler(args) {
        const names = (args.containers || []).map((c) => validateName(c, 'container'));
        const rows = await client.runJsonLines(['stats', '--no-stream', ...FORMAT_JSON, ...names]);
        const stats = rows
          .map((r) => ({
            id: String(r.ID || r.Container || '').slice(0, 12),
            name: r.Name,
            cpu_percent: percent(r.CPUPerc),
            memory_usage: r.MemUsage,
            memory_percent: percent(r.MemPerc),
            net_io: r.NetIO,
            block_io: r.BlockIO,
            pids: Number.parseInt(r.PIDs, 10) || 0,
          }))
          .sort((a, b) => (b.memory_percent ?? 0) - (a.memory_percent ?? 0));
        return json({ count: stats.length, stats });
      },
    },

    {
      name: 'docker_list_images',
      description: 'List local images with repository, tag, ID, size, and age.',
      inputSchema: schema({
        reference: { type: 'string', description: 'Filter by reference, wildcards allowed (for example "node:*" or "ghcr.io/acme/*").' },
        dangling_only: { type: 'boolean', default: false, description: 'Only untagged (dangling) images.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Maximum images to return (1-500, default 100).' },
      }),
      async handler(args) {
        const cmd = ['images'];
        if (args.reference !== undefined) cmd.push('--filter', `reference=${validateReference(args.reference)}`);
        if (args.dangling_only) cmd.push('--filter', 'dangling=true');
        cmd.push(...FORMAT_JSON);
        const rows = await client.runJsonLines(cmd);
        const images = rows.slice(0, args.limit).map((r) => ({
          id: r.ID,
          repository: r.Repository,
          tag: r.Tag,
          size: r.Size,
          created: r.CreatedSince,
        }));
        return json({ total: rows.length, returned: images.length, images });
      },
    },

    {
      name: 'docker_list_networks',
      description: 'List Docker networks with ID, name, driver, and scope.',
      inputSchema: schema({
        name: { type: 'string', description: 'Only networks whose name contains this text.' },
      }),
      async handler(args) {
        const cmd = ['network', 'ls'];
        if (args.name !== undefined) cmd.push('--filter', `name=${validateName(args.name, 'name')}`);
        cmd.push(...FORMAT_JSON);
        const rows = await client.runJsonLines(cmd);
        const networks = rows.map((r) => ({
          id: r.ID,
          name: r.Name,
          driver: r.Driver,
          scope: r.Scope,
          internal: String(r.Internal) === 'true',
        }));
        return json({ count: networks.length, networks });
      },
    },

    {
      name: 'docker_list_volumes',
      description: 'List Docker volumes with name, driver, mountpoint, and owning Compose project.',
      inputSchema: schema({
        dangling_only: { type: 'boolean', default: false, description: 'Only volumes not used by any container.' },
      }),
      async handler(args) {
        const cmd = ['volume', 'ls'];
        if (args.dangling_only) cmd.push('--filter', 'dangling=true');
        cmd.push(...FORMAT_JSON);
        const rows = await client.runJsonLines(cmd);
        const volumes = rows.map((r) => ({
          name: r.Name,
          driver: r.Driver,
          mountpoint: r.Mountpoint || null,
          scope: r.Scope,
          compose_project: parseLabels(r.Labels)['com.docker.compose.project'] || null,
        }));
        return json({ count: volumes.length, volumes });
      },
    },

    {
      name: 'docker_disk_usage',
      description: 'Show disk space used by images, containers, local volumes, and build cache, and how much is reclaimable.',
      inputSchema: schema({}),
      async handler() {
        const rows = await client.runJsonLines(['system', 'df', ...FORMAT_JSON]);
        return json({
          usage: rows.map((r) => ({
            type: r.Type,
            total: Number(r.TotalCount),
            active: Number(r.Active),
            size: r.Size,
            reclaimable: r.Reclaimable,
          })),
        });
      },
    },

    {
      name: 'docker_compose_ps',
      description: 'List the services of a Compose stack with state, health, exit code, and published ports.',
      inputSchema: schema({ cwd: CWD, file: FILE }, ['cwd']),
      async handler(args) {
        const { cwd, base } = composeContext(args);
        const rows = await client.runJsonLines([...base, 'ps', '--all', '--format', 'json'], { cwd });
        const services = rows.map((r) => ({
          service: r.Service,
          container: r.Name,
          state: r.State,
          health: r.Health || null,
          exit_code: r.ExitCode ?? null,
          status: r.Status,
          ports: formatPublishers(r.Publishers),
        }));
        const result = { cwd, count: services.length, services };
        if (!services.length) result.note = 'No containers found for this Compose project. Check cwd and file, or start it with docker_compose_up.';
        return json(result);
      },
    },

    {
      name: 'docker_compose_logs',
      description: 'Fetch recent logs for one or all services of a Compose stack. Long output keeps the newest lines.',
      inputSchema: schema(
        {
          cwd: CWD,
          service: { type: 'string', description: 'Service name. Omit for all services.' },
          file: FILE,
          tail: tailSchema('Number of lines per service from the end (1-1000, default 150).'),
        },
        ['cwd'],
      ),
      async handler(args) {
        const { cwd, base } = composeContext(args);
        const cmd = [...base, 'logs', '--no-color', '--tail', String(args.tail)];
        if (args.service !== undefined) cmd.push(validateName(args.service, 'service'));
        const { stdout, stderr } = await client.runDocker(cmd, { cwd });
        const warnings = stripAnsi(stderr).trim();
        const body = stripAnsi(stdout).trimEnd() || '(no log output)';
        const header = `Compose logs for ${args.service || 'all services'} in ${cwd}:`;
        return client.truncate(`${header}\n${body}${warnings ? `\n\nstderr:\n${warnings}` : ''}`, 'tail');
      },
    },

    {
      name: 'docker_restart_container',
      description: `${STATE_CHANGING} Restart a container.`,
      inputSchema: schema({ container: CONTAINER, timeout: stopTimeout }, ['container']),
      async handler(args) {
        const container = validateName(args.container, 'container');
        const cmd = ['restart'];
        if (args.timeout !== undefined) cmd.push('-t', String(args.timeout));
        cmd.push(container);
        await client.runDocker(cmd, { timeoutMs: Math.max(WRITE_TIMEOUT_MS, ((args.timeout ?? 10) + 30) * 1000) });
        return `Restarted container ${container}.`;
      },
    },

    {
      name: 'docker_stop_container',
      description: `${STATE_CHANGING} Stop a running container (it is not removed).`,
      inputSchema: schema({ container: CONTAINER, timeout: stopTimeout }, ['container']),
      async handler(args) {
        const container = validateName(args.container, 'container');
        const cmd = ['stop'];
        if (args.timeout !== undefined) cmd.push('-t', String(args.timeout));
        cmd.push(container);
        await client.runDocker(cmd, { timeoutMs: Math.max(WRITE_TIMEOUT_MS, ((args.timeout ?? 10) + 30) * 1000) });
        return `Stopped container ${container}.`;
      },
    },

    {
      name: 'docker_compose_up',
      description:
        `${STATE_CHANGING} Start a Compose stack in the background (docker compose up -d), optionally rebuilding images. ` +
        'Times out after 60 s, or 10 min with build.',
      inputSchema: schema(
        {
          cwd: CWD,
          file: FILE,
          services: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Services to start. Omit for all.' },
          build: { type: 'boolean', default: false, description: 'Build images before starting (--build).' },
        },
        ['cwd'],
      ),
      async handler(args) {
        const { cwd, base } = composeContext(args);
        const services = (args.services || []).map((s) => validateName(s, 'service'));
        const cmd = [...base, 'up', '--detach'];
        if (args.build) cmd.push('--build');
        cmd.push(...services);
        const { stdout, stderr } = await client.runDocker(cmd, {
          cwd,
          timeoutMs: args.build ? BUILD_TIMEOUT_MS : WRITE_TIMEOUT_MS,
        });
        const output = stripAnsi(`${stderr}\n${stdout}`).trim();
        const target = services.length ? services.join(', ') : 'all services';
        return [
          `Started ${target} in ${cwd}. Check status with docker_compose_ps.`,
          output ? truncateText(output, COMPOSE_OUTPUT_MAX_CHARS, { keep: 'tail' }) : '',
        ]
          .filter(Boolean)
          .join('\n\n');
      },
    },
  ];

  return tools;
}

// Runs a tool and converts the outcome to an MCP tools/call result.
export async function runTool(tool, rawArgs) {
  const { args, error } = prepareArgs(tool.inputSchema, rawArgs);
  if (error) return { content: [{ type: 'text', text: `Invalid arguments: ${error}` }], isError: true };
  try {
    const text = await tool.handler(args);
    return { content: [{ type: 'text', text: String(text) }] };
  } catch (err) {
    const message = err instanceof DockerError ? err.message : `Unexpected error: ${err?.message || String(err)}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}
