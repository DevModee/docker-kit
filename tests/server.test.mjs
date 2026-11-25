import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDockerClient } from '../src/docker.mjs';
import { createTools, formatBytes, parseLabels, prepareArgs } from '../src/tools.mjs';
import { handleRpcMessage, SERVER_INFO } from '../src/server.mjs';

const SERVER_PATH = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

const EXPECTED_TOOLS = [
  'docker_info',
  'docker_list_containers',
  'docker_inspect_container',
  'docker_container_logs',
  'docker_container_stats',
  'docker_list_images',
  'docker_list_networks',
  'docker_list_volumes',
  'docker_disk_usage',
  'docker_compose_ps',
  'docker_compose_logs',
  'docker_restart_container',
  'docker_stop_container',
  'docker_compose_up',
];
const STATE_CHANGING_TOOLS = new Set(['docker_restart_container', 'docker_stop_container', 'docker_compose_up']);

const ndjson = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

// respond(args, options) returns { stdout, stderr, err } for each docker call.
function setup(respond = () => ({}), clientOptions = {}) {
  const calls = [];
  const execImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const { err = null, stdout = '', stderr = '' } = respond(args, options) || {};
    setImmediate(() => callback(err, stdout, stderr));
  };
  const client = createDockerClient({ execImpl, ...clientOptions });
  return { calls, tools: createTools(client) };
}

const rpc = (msg, tools) => handleRpcMessage(msg, { tools });

async function callTool(tools, name, args = {}) {
  const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, tools);
  assert.equal(res.id, 7);
  assert.ok(res.result, `expected a result, got ${JSON.stringify(res)}`);
  return { text: res.result.content[0].text, isError: res.result.isError === true };
}

let workspace;
before(() => {
  workspace = mkdtempSync(join(tmpdir(), 'docker-kit-ws-'));
  writeFileSync(join(workspace, 'compose.dev.yml'), 'services:\n  web:\n    image: nginx\n');
});
after(() => rmSync(workspace, { recursive: true, force: true }));

describe('JSON-RPC protocol', () => {
  const { tools } = setup();

  test('initialize negotiates the protocol version', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, tools);
    assert.equal(res.result.protocolVersion, '2025-03-26');
    assert.deepEqual(res.result.serverInfo, SERVER_INFO);
    assert.deepEqual(res.result.capabilities, { tools: {} });

    const fallback = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, tools);
    assert.equal(fallback.result.protocolVersion, '2024-11-05');
  });

  test('notifications get no response and ping returns an empty result', async () => {
    assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools), null);
    assert.deepEqual(await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' }, tools), { jsonrpc: '2.0', id: 3, result: {} });
  });

  test('returns standard error codes', async () => {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'nope' }, tools)).error.code, -32601);
    assert.equal((await rpc(42, tools)).error.code, -32600);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 5 }, tools)).error.code, -32600);
    assert.equal((await rpc([], tools)).error.code, -32600);
    const unknown = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'docker_rm' } }, tools);
    assert.equal(unknown.error.code, -32602);
    const noName = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} }, tools);
    assert.equal(noName.error.code, -32602);
  });

  test('handles batches and drops notification responses', async () => {
    const res = await rpc(
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ],
      tools,
    );
    assert.deepEqual(res.map((r) => r.id), [1, 2]);
  });

  test('tools/list exposes the 14 tools and marks state-changing ones', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, tools);
    const listed = res.result.tools;
    assert.deepEqual(listed.map((t) => t.name), EXPECTED_TOOLS);
    for (const tool of listed) {
      assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name']);
      assert.equal(tool.inputSchema.type, 'object');
      const marked = tool.description.startsWith('State-changing: confirm with the user first.');
      assert.equal(marked, STATE_CHANGING_TOOLS.has(tool.name), tool.name);
    }
  });
});

describe('argument handling', () => {
  test('prepareArgs applies defaults and coerces simple strings', () => {
    const tool = setup().tools.find((t) => t.name === 'docker_container_logs');
    const { args, error } = prepareArgs(tool.inputSchema, { container: 'web', tail: '20', timestamps: 'true' });
    assert.equal(error, null);
    assert.deepEqual(args, { container: 'web', tail: 20, timestamps: true });
  });

  test('rejects missing, out-of-range, and wrongly typed arguments', async () => {
    const { calls, tools } = setup();
    assert.match((await callTool(tools, 'docker_inspect_container')).text, /Missing required argument: container/);
    assert.match((await callTool(tools, 'docker_container_logs', { container: 'web', tail: 5000 })).text, /tail must be <= 1000/);
    assert.match((await callTool(tools, 'docker_list_containers', { status: 'zombie' })).text, /status must be one of/);
    assert.match((await callTool(tools, 'docker_inspect_container', { container: '  ' })).text, /must not be empty/);
    assert.equal(calls.length, 0);
  });

  test('rejects flag injection before calling docker', async () => {
    const { calls, tools } = setup();
    for (const [name, args] of [
      ['docker_inspect_container', { container: '--privileged' }],
      ['docker_container_logs', { container: 'web', since: '--until=1h' }],
      ['docker_container_stats', { containers: ['web', '-a'] }],
      ['docker_stop_container', { container: '-t' }],
      ['docker_list_images', { reference: '--all' }],
      ['docker_compose_logs', { cwd: workspace, service: '--follow' }],
      ['docker_compose_up', { cwd: workspace, services: ['--force-recreate'] }],
    ]) {
      const { text, isError } = await callTool(tools, name, args);
      assert.ok(isError, name);
      assert.match(text, /must not start with "-"/, name);
    }
    assert.equal(calls.length, 0);
  });

  test('helpers parse labels and format sizes', () => {
    assert.deepEqual(parseLabels('a=1,com.docker.compose.project=shop'), { a: '1', 'com.docker.compose.project': 'shop' });
    assert.deepEqual(parseLabels({ x: 'y' }), { x: 'y' });
    assert.equal(formatBytes(2147483648), '2.0 GiB');
    assert.equal(formatBytes(0), null);
  });
});

describe('read-only tools', () => {
  test('docker_info combines version and info', async () => {
    const { calls, tools } = setup((args) => {
      if (args[0] === 'version') {
        return { stdout: JSON.stringify({ Client: { Version: '27.1.1', Os: 'windows' }, Server: { Version: '27.1.1', Os: 'linux', Arch: 'amd64' } }) };
      }
      return {
        stdout: JSON.stringify({ Containers: 5, ContainersRunning: 2, ContainersPaused: 0, ContainersStopped: 3, Images: 12, NCPU: 8, MemTotal: 8589934592, Driver: 'overlay2' }),
      };
    });
    const { text, isError } = await callTool(tools, 'docker_info');
    assert.equal(isError, false);
    const data = JSON.parse(text);
    assert.equal(data.server.version, '27.1.1');
    assert.equal(data.containers.running, 2);
    assert.equal(data.images, 12);
    assert.equal(data.host.memory, '8.0 GiB');
    assert.deepEqual(calls.map((c) => c.args), [['version', '--format', '{{json .}}'], ['info', '--format', '{{json .}}']]);
  });

  test('docker_list_containers builds filters and limits results', async () => {
    const rows = [
      { ID: 'aaaaaaaaaaaaaaaa', Names: 'shop-web-1', Image: 'nginx', State: 'running', Status: 'Up 2 hours', Ports: '0.0.0.0:8080->80/tcp', Labels: 'com.docker.compose.project=shop,com.docker.compose.service=web' },
      { ID: 'bbbbbbbbbbbbbbbb', Names: 'old', Image: 'redis', State: 'exited', Status: 'Exited (1) 3 days ago', Ports: '', Labels: '' },
    ];
    const { calls, tools } = setup(() => ({ stdout: ndjson(rows) }));
    const data = JSON.parse((await callTool(tools, 'docker_list_containers', { name: 'shop', status: 'running', limit: 1 })).text);
    assert.deepEqual(calls[0].args, ['ps', '--all', '--filter', 'status=running', '--filter', 'name=shop', '--no-trunc', '--format', '{{json .}}']);
    assert.equal(data.total, 2);
    assert.equal(data.returned, 1);
    assert.deepEqual(data.containers[0], {
      id: 'aaaaaaaaaaaa',
      name: 'shop-web-1',
      image: 'nginx',
      state: 'running',
      status: 'Up 2 hours',
      ports: '0.0.0.0:8080->80/tcp',
      compose_project: 'shop',
      compose_service: 'web',
    });

    await callTool(tools, 'docker_list_containers', { all: false });
    assert.deepEqual(calls[1].args, ['ps', '--no-trunc', '--format', '{{json .}}']);
  });

  test('docker_inspect_container summarizes state and redacts secrets', async () => {
    const inspect = [{
      Id: '0123456789abcdef',
      Name: '/api',
      Created: '2024-05-01T10:00:00Z',
      Path: 'node',
      Args: ['server.js', '--db-password=hunter2'],
      RestartCount: 4,
      State: {
        Status: 'restarting', Running: true, Restarting: true, OOMKilled: true, ExitCode: 137,
        Health: { Status: 'unhealthy', FailingStreak: 3, Log: [{ End: '2024-05-01T10:01:00Z', ExitCode: 1, Output: 'curl: (7) refused' }] },
      },
      Config: {
        Image: 'acme/api:1.4',
        Env: ['NODE_ENV=production', 'POSTGRES_PASSWORD=hunter2', 'DATABASE_URL=postgres://a:b@db/app', 'MONGO_URI=mongodb://root:pw@m:27017'],
        Labels: { 'com.docker.compose.project': 'shop', 'com.docker.compose.service': 'api' },
      },
      HostConfig: { RestartPolicy: { Name: 'always' }, Memory: 268435456, NanoCpus: 500000000 },
      NetworkSettings: {
        Ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }], '9229/tcp': null },
        Networks: { shop_default: { IPAddress: '172.18.0.3', Gateway: '172.18.0.1', Aliases: ['api'] } },
      },
      Mounts: [{ Type: 'volume', Name: 'shop_data', Source: '/var/lib/docker/volumes/shop_data/_data', Destination: '/data', RW: true }],
    }];
    const { calls, tools } = setup(() => ({ stdout: JSON.stringify(inspect) }));
    const { text } = await callTool(tools, 'docker_inspect_container', { container: 'api' });
    assert.deepEqual(calls[0].args, ['inspect', '--type', 'container', 'api']);
    assert.ok(!text.includes('hunter2'), 'secret leaked');
    assert.ok(!text.includes(':pw@'), 'URL password leaked');
    const data = JSON.parse(text);
    assert.equal(data.name, 'api');
    assert.equal(data.state.oom_killed, true);
    assert.equal(data.state.exit_code, 137);
    assert.equal(data.state.health.status, 'unhealthy');
    assert.equal(data.restart_count, 4);
    assert.equal(data.restart_policy, 'always');
    assert.equal(data.limits.memory, '256.0 MiB');
    assert.equal(data.limits.cpus, 0.5);
    assert.deepEqual(data.ports, [{ container_port: '3000/tcp', published: '0.0.0.0:3000' }, { container_port: '9229/tcp', published: null }]);
    assert.equal(data.networks.shop_default.ip, '172.18.0.3');
    assert.equal(data.mounts[0].name, 'shop_data');
    assert.deepEqual(data.compose, { project: 'shop', service: 'api', working_dir: null });
    assert.deepEqual(data.command, ['node', 'server.js', '--db-password=[REDACTED]']);
    assert.deepEqual(data.env, ['NODE_ENV=production', 'POSTGRES_PASSWORD=[REDACTED]', 'DATABASE_URL=[REDACTED]', 'MONGO_URI=mongodb://root:[REDACTED]@m:27017']);

    const noEnv = JSON.parse((await callTool(tools, 'docker_inspect_container', { container: 'api', include_env: false })).text);
    assert.equal(noEnv.env, undefined);
  });

  test('docker_inspect_container reports a missing container', async () => {
    const { tools } = setup(() => ({ err: Object.assign(new Error('x'), { code: 1 }), stderr: 'Error: No such container: ghost' }));
    const { text, isError } = await callTool(tools, 'docker_inspect_container', { container: 'ghost' });
    assert.ok(isError);
    assert.equal(text, 'docker inspect failed (exit 1): Error: No such container: ghost');
  });

  test('docker_container_logs merges streams and keeps the newest lines', async () => {
    const stdout = '2024-05-01T10:00:00.000000000Z boot\n2024-05-01T10:00:02.000000000Z listening on 3000\n';
    const stderr = '2024-05-01T10:00:01.000000000Z warn: missing config\n';
    const { calls, tools } = setup(() => ({ stdout, stderr }));
    const { text } = await callTool(tools, 'docker_container_logs', { container: 'api', tail: 50, since: '10m' });
    assert.deepEqual(calls[0].args, ['logs', '--tail', '50', '--timestamps', '--since', '10m', 'api']);
    assert.equal(text, 'Logs for api (last 50 lines, since 10m):\nboot\nwarn: missing config\nlistening on 3000');

    const stamped = (await callTool(tools, 'docker_container_logs', { container: 'api', timestamps: true })).text;
    assert.match(stamped, /2024-05-01T10:00:01\.000000000Z warn: missing config/);

    const small = setup(() => ({ stdout: `${'x'.repeat(200)}\nlast line\n` }), { maxTextChars: 50 });
    const truncated = (await callTool(small.tools, 'docker_container_logs', { container: 'api' })).text;
    assert.match(truncated, /^\[truncated: showing last 50 of \d+ characters\]/);
    assert.ok(truncated.endsWith('last line'));
  });

  test('docker_container_stats sorts by memory use', async () => {
    const rows = [
      { ID: 'a1', Name: 'web', CPUPerc: '0.50%', MemUsage: '20MiB / 1GiB', MemPerc: '1.95%', NetIO: '1kB / 2kB', BlockIO: '0B / 0B', PIDs: '3' },
      { ID: 'b2', Name: 'db', CPUPerc: '12.10%', MemUsage: '700MiB / 1GiB', MemPerc: '68.36%', NetIO: '5MB / 1MB', BlockIO: '1GB / 2GB', PIDs: '40' },
    ];
    const { calls, tools } = setup(() => ({ stdout: ndjson(rows) }));
    const data = JSON.parse((await callTool(tools, 'docker_container_stats', { containers: ['web', 'db'] })).text);
    assert.deepEqual(calls[0].args, ['stats', '--no-stream', '--format', '{{json .}}', 'web', 'db']);
    assert.deepEqual(data.stats.map((s) => s.name), ['db', 'web']);
    assert.equal(data.stats[0].memory_percent, 68.36);
    assert.equal(data.stats[0].pids, 40);
  });

  test('docker_list_images applies reference and dangling filters', async () => {
    const rows = [{ ID: 'sha1', Repository: 'node', Tag: '20-alpine', Size: '180MB', CreatedSince: '2 weeks ago' }];
    const { calls, tools } = setup(() => ({ stdout: ndjson(rows) }));
    const data = JSON.parse((await callTool(tools, 'docker_list_images', { reference: 'node:*', dangling_only: true })).text);
    assert.deepEqual(calls[0].args, ['images', '--filter', 'reference=node:*', '--filter', 'dangling=true', '--format', '{{json .}}']);
    assert.deepEqual(data.images[0], { id: 'sha1', repository: 'node', tag: '20-alpine', size: '180MB', created: '2 weeks ago' });
  });

  test('docker_list_networks and docker_list_volumes', async () => {
    const { calls, tools } = setup((args) => {
      if (args[0] === 'network') return { stdout: ndjson([{ ID: 'n1', Name: 'shop_default', Driver: 'bridge', Scope: 'local', Internal: 'false' }]) };
      return { stdout: ndjson([{ Name: 'shop_data', Driver: 'local', Mountpoint: '/var/lib/docker/volumes/shop_data/_data', Scope: 'local', Labels: 'com.docker.compose.project=shop' }]) };
    });
    const networks = JSON.parse((await callTool(tools, 'docker_list_networks', { name: 'shop' })).text);
    assert.deepEqual(calls[0].args, ['network', 'ls', '--filter', 'name=shop', '--format', '{{json .}}']);
    assert.deepEqual(networks.networks[0], { id: 'n1', name: 'shop_default', driver: 'bridge', scope: 'local', internal: false });

    const volumes = JSON.parse((await callTool(tools, 'docker_list_volumes', { dangling_only: true })).text);
    assert.deepEqual(calls[1].args, ['volume', 'ls', '--filter', 'dangling=true', '--format', '{{json .}}']);
    assert.equal(volumes.volumes[0].compose_project, 'shop');
  });

  test('docker_disk_usage reports reclaimable space', async () => {
    const rows = [
      { Type: 'Images', TotalCount: '12', Active: '4', Size: '3.2GB', Reclaimable: '2.1GB (65%)' },
      { Type: 'Build Cache', TotalCount: '40', Active: '0', Size: '1.1GB', Reclaimable: '1.1GB' },
    ];
    const { calls, tools } = setup(() => ({ stdout: ndjson(rows) }));
    const data = JSON.parse((await callTool(tools, 'docker_disk_usage')).text);
    assert.deepEqual(calls[0].args, ['system', 'df', '--format', '{{json .}}']);
    assert.deepEqual(data.usage[0], { type: 'Images', total: 12, active: 4, size: '3.2GB', reclaimable: '2.1GB (65%)' });
  });
});

describe('Compose tools', () => {
  test('docker_compose_ps parses array output and published ports', async () => {
    const rows = [
      { Name: 'shop-web-1', Service: 'web', State: 'running', Health: 'healthy', ExitCode: 0, Status: 'Up 5 minutes', Publishers: [{ URL: '0.0.0.0', TargetPort: 80, PublishedPort: 8080, Protocol: 'tcp' }, { URL: '', TargetPort: 443, PublishedPort: 0, Protocol: 'tcp' }] },
      { Name: 'shop-db-1', Service: 'db', State: 'exited', Health: '', ExitCode: 1, Status: 'Exited (1)', Publishers: null },
    ];
    const { calls, tools } = setup(() => ({ stdout: JSON.stringify(rows) }));
    const data = JSON.parse((await callTool(tools, 'docker_compose_ps', { cwd: workspace, file: 'compose.dev.yml' })).text);
    assert.deepEqual(calls[0].args, ['compose', '--file', join(workspace, 'compose.dev.yml'), 'ps', '--all', '--format', 'json']);
    assert.equal(calls[0].options.cwd, workspace);
    assert.deepEqual(data.services[0].ports, ['0.0.0.0:8080->80/tcp']);
    assert.equal(data.services[1].exit_code, 1);
    assert.equal(data.services[1].health, null);
  });

  test('docker_compose_ps explains an empty project and validates cwd', async () => {
    const { calls, tools } = setup(() => ({ stdout: '' }));
    const data = JSON.parse((await callTool(tools, 'docker_compose_ps', { cwd: workspace })).text);
    assert.equal(data.count, 0);
    assert.match(data.note, /No containers found/);

    assert.match((await callTool(tools, 'docker_compose_ps', { cwd: 'relative' })).text, /absolute path/);
    assert.match((await callTool(tools, 'docker_compose_ps', { cwd: workspace, file: 'nope.yml' })).text, /Compose file not found/);
    assert.match((await callTool(tools, 'docker_compose_ps')).text, /Missing required argument: cwd/);
    assert.equal(calls.length, 1);
  });

  test('docker_compose_logs fetches one service', async () => {
    const { calls, tools } = setup(() => ({ stdout: 'web-1  | GET / 200\n', stderr: 'WARN[0000] the attribute `version` is obsolete\n' }));
    const { text } = await callTool(tools, 'docker_compose_logs', { cwd: workspace, service: 'web', tail: 20 });
    assert.deepEqual(calls[0].args, ['compose', 'logs', '--no-color', '--tail', '20', 'web']);
    assert.match(text, /^Compose logs for web in /);
    assert.match(text, /web-1 {2}\| GET \/ 200/);
    assert.match(text, /stderr:\nWARN/);
  });
});

describe('state-changing tools', () => {
  test('docker_restart_container and docker_stop_container pass the stop timeout', async () => {
    const { calls, tools } = setup((args) => ({ stdout: `${args[args.length - 1]}\n` }));
    assert.equal((await callTool(tools, 'docker_restart_container', { container: 'api', timeout: 90 })).text, 'Restarted container api.');
    assert.deepEqual(calls[0].args, ['restart', '-t', '90', 'api']);
    assert.equal(calls[0].options.timeout, 120000);

    assert.equal((await callTool(tools, 'docker_stop_container', { container: 'api' })).text, 'Stopped container api.');
    assert.deepEqual(calls[1].args, ['stop', 'api']);
    assert.equal(calls[1].options.timeout, 60000);
  });

  test('docker_compose_up starts services detached and extends the timeout for builds', async () => {
    const { calls, tools } = setup(() => ({ stderr: '\x1b[32m Container shop-web-1  Started\x1b[0m\n' }));
    const { text } = await callTool(tools, 'docker_compose_up', { cwd: workspace, services: ['web', 'db'] });
    assert.deepEqual(calls[0].args, ['compose', 'up', '--detach', 'web', 'db']);
    assert.equal(calls[0].options.timeout, 60000);
    assert.equal(calls[0].options.cwd, workspace);
    assert.match(text, /^Started web, db in /);
    assert.match(text, /Container shop-web-1 {2}Started/);
    assert.ok(!text.includes('\x1b'));

    await callTool(tools, 'docker_compose_up', { cwd: workspace, file: 'compose.dev.yml', build: true });
    assert.deepEqual(calls[1].args, ['compose', '--file', join(workspace, 'compose.dev.yml'), 'up', '--detach', '--build']);
    assert.equal(calls[1].options.timeout, 600000);
  });
});

describe('error reporting', () => {
  test('a stopped daemon is reported as a tool error', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 1 });
    const { tools } = setup(() => ({ err, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }));
    const { text, isError } = await callTool(tools, 'docker_list_containers');
    assert.ok(isError);
    assert.match(text, /Docker daemon is not running/);
  });

  test('unexpected exceptions are wrapped', async () => {
    const { tools } = setup(() => {
      throw new TypeError('boom');
    });
    const { text, isError } = await callTool(tools, 'docker_disk_usage');
    assert.ok(isError);
    assert.match(text, /boom/);
  });
});

describe('stdio server process', () => {
  test('speaks JSON-RPC over stdin and stdout', async () => {
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    try {
      const responses = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`)), 10000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          const lines = stdout.split('\n').filter(Boolean);
          if (lines.length >= 4) {
            clearTimeout(timer);
            resolve(lines.map((line) => JSON.parse(line)));
          }
        });
        child.on('error', reject);

        const send = (msg) => child.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\r\n`);
        send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'docker_inspect_container', arguments: {} } });
        send('{not json');
      });

      const byId = new Map(responses.map((r) => [r.id, r]));
      assert.equal(byId.get(1).result.serverInfo.name, 'docker-kit');
      assert.equal(byId.get(2).result.tools.length, EXPECTED_TOOLS.length);
      assert.equal(byId.get(3).result.isError, true);
      assert.match(byId.get(3).result.content[0].text, /Missing required argument: container/);
      assert.equal(byId.get(null).error.code, -32700);
    } finally {
      child.kill();
    }
  });
});
