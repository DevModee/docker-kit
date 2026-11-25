import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DockerError,
  READ_TIMEOUT_MS,
  commandLabel,
  createDockerClient,
  mergeLogStreams,
  parseJsonLines,
  redactArgs,
  redactAssignment,
  redactEnvList,
  stripAnsi,
  truncateText,
  validateComposeFile,
  validateCwd,
  validateName,
  validateReference,
  validateSince,
} from '../src/docker.mjs';

// execFile-compatible mock: records calls and answers through the callback.
function mockExec(respond) {
  const calls = [];
  const execImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const { err = null, stdout = '', stderr = '' } = respond(args, options) || {};
    setImmediate(() => callback(err, stdout, stderr));
  };
  return { calls, execImpl };
}

function execError(props) {
  return Object.assign(new Error(props.message || 'Command failed'), props);
}

describe('input validation', () => {
  test('rejects values that start with "-" (flag injection)', () => {
    for (const value of ['--privileged', '-v', '--rm']) {
      assert.throws(() => validateName(value, 'container'), (err) => err instanceof DockerError && /must not start with "-"/.test(err.message));
      assert.throws(() => validateReference(value), DockerError);
      assert.throws(() => validateSince(value), DockerError);
    }
  });

  test('accepts container names, IDs, and image references', () => {
    for (const value of ['web', 'my_app-db.1', 'a1b2c3d4e5f6', 'ghcr.io/acme/api:1.2', 'node@sha256:abc']) {
      assert.equal(validateName(value), value);
    }
    assert.equal(validateReference('node:*'), 'node:*');
  });

  test('rejects empty values, spaces, and shell metacharacters', () => {
    for (const value of ['', '   ', 'web; rm -rf /', 'a b', '$(id)', 'x|y', 'a\nb']) {
      assert.throws(() => validateName(value), DockerError);
    }
    assert.throws(() => validateName(42), DockerError);
    assert.throws(() => validateName('a'.repeat(256)), /too long/);
  });

  test('accepts timestamps and durations for since', () => {
    assert.equal(validateSince('10m'), '10m');
    assert.equal(validateSince('2024-01-02T15:04:05Z'), '2024-01-02T15:04:05Z');
    assert.throws(() => validateSince('yesterday'), DockerError);
  });

  test('cwd must be an existing absolute directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docker-kit-'));
    try {
      assert.equal(validateCwd(dir), dir);
      assert.throws(() => validateCwd('relative/path'), /absolute/);
      assert.throws(() => validateCwd(join(dir, 'missing')), /does not exist/);
      assert.throws(() => validateCwd(''), DockerError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compose file resolves against cwd and must exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docker-kit-'));
    try {
      writeFileSync(join(dir, 'compose.dev.yml'), 'services: {}\n');
      assert.equal(validateComposeFile('compose.dev.yml', dir), join(dir, 'compose.dev.yml'));
      assert.throws(() => validateComposeFile('missing.yml', dir), /not found/);
      assert.throws(() => validateComposeFile('-f', dir), /must not start with "-"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('secret redaction', () => {
  test('redacts values of secret-like environment variables', () => {
    const env = [
      'PATH=/usr/local/bin:/usr/bin',
      'NODE_ENV=production',
      'POSTGRES_PASSWORD=hunter2',
      'API_KEY=abc123',
      'GITHUB_TOKEN=ghp_x',
      'DATABASE_URL=postgres://app:pw@db:5432/app',
      'REDIS_URL=redis://cache:6379',
      'SENTRY_DSN=https://k@sentry.io/1',
      'JWT_SECRET=s',
      'SESSION_COOKIE_NAME=sid',
      'AWS_PRIVATE_THING=x',
      'OAUTH_CLIENT=y',
      'MY_CREDENTIALS=z',
    ];
    const out = redactEnvList(env);
    assert.equal(out[0], 'PATH=/usr/local/bin:/usr/bin');
    assert.equal(out[1], 'NODE_ENV=production');
    for (const entry of out.slice(2)) assert.match(entry, /^[A-Z_]+=\[REDACTED\]$/, entry);
    assert.ok(!out.join('\n').includes('hunter2'));
  });

  test('masks passwords embedded in URLs even under harmless names', () => {
    assert.equal(redactAssignment('MONGO_URI=mongodb://root:example@mongo:27017'), 'MONGO_URI=mongodb://root:[REDACTED]@mongo:27017');
    assert.equal(redactAssignment('--password=topsecret'), '--password=[REDACTED]');
    assert.equal(redactAssignment('server.js'), 'server.js');
    assert.deepEqual(redactEnvList(null), []);
  });

  test('redacts the value that follows a secret-like flag', () => {
    assert.deepEqual(redactArgs(['redis-server', '--requirepass', 'hunter2', '--port', '6379']), [
      'redis-server',
      '--requirepass',
      '[REDACTED]',
      '--port',
      '6379',
    ]);
    assert.deepEqual(redactArgs(['app', '-p', 'x', '--token', '--verbose']), ['app', '-p', 'x', '--token', '--verbose']);
    assert.deepEqual(redactArgs(['app', '--db-password=hunter2']), ['app', '--db-password=[REDACTED]']);
    assert.deepEqual(redactArgs(null), []);
  });
});

describe('parseJsonLines', () => {
  test('parses NDJSON from --format "{{json .}}"', () => {
    const out = parseJsonLines('{"ID":"a","Names":"web"}\r\n{"ID":"b","Names":"db"}\n\n');
    assert.deepEqual(out, [{ ID: 'a', Names: 'web' }, { ID: 'b', Names: 'db' }]);
  });

  test('parses the JSON array printed by older docker compose ps', () => {
    const out = parseJsonLines('[{"Service":"web"},{"Service":"db"}]\n');
    assert.deepEqual(out.map((s) => s.Service), ['web', 'db']);
  });

  test('returns an empty list for empty output and throws on garbage', () => {
    assert.deepEqual(parseJsonLines(''), []);
    assert.deepEqual(parseJsonLines('  \n'), []);
    assert.throws(() => parseJsonLines('{"a":1}\nWARNING: something'), (err) => err.code === 'PARSE_ERROR');
  });
});

describe('text helpers', () => {
  test('truncateText keeps the head or the tail with a notice', () => {
    assert.equal(truncateText('short', 10), 'short');
    const head = truncateText('abcdefghij', 4);
    assert.ok(head.startsWith('abcd\n[truncated: showing first 4 of 10 characters]'));
    const tail = truncateText('abcdefghij', 4, { keep: 'tail' });
    assert.ok(tail.endsWith('ghij'));
    assert.match(tail, /showing last 4 of 10/);
  });

  test('stripAnsi removes color codes', () => {
    assert.equal(stripAnsi('\x1b[32mok\x1b[0m'), 'ok');
  });

  test('mergeLogStreams interleaves stdout and stderr by timestamp', () => {
    const stdout = '2024-05-01T10:00:00.100000000Z start\n2024-05-01T10:00:02.000000000Z ready\n';
    const stderr = '2024-05-01T10:00:01.5Z warn: slow disk\n';
    assert.equal(mergeLogStreams(stdout, stderr), 'start\nwarn: slow disk\nready');
    assert.equal(
      mergeLogStreams(stdout, stderr, { keepTimestamps: true }).split('\n')[1],
      '2024-05-01T10:00:01.5Z warn: slow disk',
    );
    assert.equal(mergeLogStreams('', ''), '');
  });

  test('commandLabel names the docker subcommand', () => {
    assert.equal(commandLabel(['ps', '--all', '--format', '{{json .}}']), 'docker ps');
    assert.equal(commandLabel(['compose', '--file', '/w/compose.yml', 'ps']), 'docker compose ps');
    assert.equal(commandLabel(['system', 'df']), 'docker system df');
  });
});

describe('createDockerClient', () => {
  test('calls docker through execFile without a shell', async () => {
    const { calls, execImpl } = mockExec(() => ({ stdout: '{"ID":"a"}\n' }));
    const client = createDockerClient({ execImpl, env: { PATH: '/bin' } });
    const rows = await client.runJsonLines(['ps', '--format', '{{json .}}'], { cwd: '/work' });
    assert.deepEqual(rows, [{ ID: 'a' }]);
    assert.equal(calls[0].file, 'docker');
    assert.deepEqual(calls[0].args, ['ps', '--format', '{{json .}}']);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.shell, undefined);
    assert.equal(calls[0].options.timeout, READ_TIMEOUT_MS);
    assert.equal(calls[0].options.cwd, '/work');
    assert.ok(calls[0].options.maxBuffer > 0);
    assert.equal(calls[0].options.env.DOCKER_CLI_HINTS, 'false');
  });

  test('honors a per-call timeout', async () => {
    const { calls, execImpl } = mockExec(() => ({ stdout: 'web\n' }));
    const client = createDockerClient({ execImpl });
    const { stdout } = await client.runDocker(['restart', 'web'], { timeoutMs: 60000 });
    assert.equal(stdout, 'web\n');
    assert.equal(calls[0].options.timeout, 60000);
  });

  test('reports a missing docker CLI', async () => {
    const { execImpl } = mockExec(() => ({ err: execError({ code: 'ENOENT' }) }));
    const client = createDockerClient({ execImpl });
    await assert.rejects(client.runDocker(['ps']), (err) => err.code === 'DOCKER_NOT_FOUND' && /not found in PATH/.test(err.message));
  });

  test('reports a stopped daemon on Linux and Windows', async () => {
    const messages = [
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.',
    ];
    for (const stderr of messages) {
      const { execImpl } = mockExec(() => ({ err: execError({ code: 1 }), stderr }));
      const client = createDockerClient({ execImpl });
      await assert.rejects(client.runDocker(['ps']), (err) => err.code === 'DAEMON_DOWN' && /daemon is not running/.test(err.message));
    }
  });

  test('reports timeouts', async () => {
    const { execImpl } = mockExec(() => ({ err: execError({ killed: true, signal: 'SIGTERM', code: null }) }));
    const client = createDockerClient({ execImpl });
    await assert.rejects(
      client.runDocker(['compose', 'up', '--detach'], { timeoutMs: 60000 }),
      (err) => err.code === 'TIMEOUT' && /docker compose up timed out after 60 s/.test(err.message),
    );
  });

  test('reports non-zero exits with trimmed stderr', async () => {
    const { execImpl } = mockExec(() => ({
      err: execError({ code: 1 }),
      stderr: '\x1b[31mError response from daemon: No such container: ghost\x1b[0m\n\n',
    }));
    const client = createDockerClient({ execImpl });
    await assert.rejects(client.runDocker(['inspect', 'ghost']), (err) => {
      assert.equal(err.code, 'COMMAND_FAILED');
      assert.equal(err.message, 'docker inspect failed (exit 1): Error response from daemon: No such container: ghost');
      return true;
    });
  });

  test('reports oversized output and invalid JSON', async () => {
    const big = mockExec(() => ({ err: execError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }));
    await assert.rejects(createDockerClient({ execImpl: big.execImpl }).runDocker(['logs', 'web']), (err) => err.code === 'OUTPUT_TOO_LARGE');

    const bad = mockExec(() => ({ stdout: 'not json' }));
    await assert.rejects(createDockerClient({ execImpl: bad.execImpl }).runJson(['info']), (err) => err.code === 'PARSE_ERROR');
  });

  test('rejects non-string arguments before spawning', async () => {
    const { calls, execImpl } = mockExec(() => ({}));
    await assert.rejects(createDockerClient({ execImpl }).runDocker(['ps', 1]), DockerError);
    assert.equal(calls.length, 0);
  });

  test('truncate uses the configured limit', () => {
    const client = createDockerClient({ maxTextChars: 5 });
    assert.match(client.truncate('0123456789', 'tail'), /56789$/);
  });
});
