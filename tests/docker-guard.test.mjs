import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateCommand, decide, REASONS } from '../hooks/docker-guard.mjs';

const HOOK_PATH = fileURLToPath(new URL('../hooks/docker-guard.mjs', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

function expectDecision(commands, decision, reason) {
  for (const command of commands) {
    const result = evaluateCommand(command);
    assert.equal(result.decision, decision, `${command} -> ${JSON.stringify(result)}`);
    if (reason) assert.equal(result.reason, reason, command);
    if (decision === 'allow') assert.equal(result.reason, undefined, command);
  }
}

const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');

describe('evaluateCommand: deny', () => {
  test('system prune with --all and --volumes', () => {
    expectDecision(
      [
        'docker system prune -af --volumes',
        'docker system prune --all --volumes',
        'docker system prune -a --volumes -f',
        'docker system prune --volumes --all --force --filter until=24h',
        'docker system prune --all=true --volumes',
        'docker --context prod system prune -af --volumes',
        'docker -H tcp://10.0.0.5:2376 system prune -fa --volumes',
      ],
      'deny',
      REASONS.systemPruneAllVolumes,
    );
  });

  test('forced volume prune', () => {
    expectDecision(
      ['docker volume prune -f', 'docker volume prune --force', 'docker volume prune -af', 'docker volume prune --all --force'],
      'deny',
      REASONS.volumePruneForce,
    );
  });

  test('forced volume rm', () => {
    expectDecision(
      ['docker volume rm -f pgdata', 'docker volume rm --force pgdata cache', 'docker volume remove -f pgdata'],
      'deny',
      REASONS.volumeRmForce,
    );
  });
});

describe('evaluateCommand: force_ask', () => {
  test('other forms of system prune', () => {
    expectDecision(
      ['docker system prune', 'docker system prune -f', 'docker system prune -a', 'docker system prune --volumes', 'docker system prune --all=false --volumes'],
      'force_ask',
      REASONS.systemPrune,
    );
  });

  test('volume rm and volume prune without force', () => {
    expectDecision(['docker volume rm pgdata', 'docker volume remove pgdata'], 'force_ask', REASONS.volumeRm);
    expectDecision(['docker volume prune', 'docker volume prune -a', 'docker volume prune --filter label=tmp'], 'force_ask', REASONS.volumePrune);
  });

  test('compose down with volumes', () => {
    expectDecision(
      [
        'docker compose down -v',
        'docker compose down --volumes',
        'docker compose down --remove-orphans -v',
        'docker compose -f compose.prod.yml -p shop down -v',
        'docker compose --file=compose.yml down --rmi all --volumes',
        'docker compose down -t 5 -v',
        'docker-compose down -v',
        'docker compose down --volumes=true',
      ],
      'force_ask',
      REASONS.composeDownVolumes,
    );
  });

  test('forced container and image removal', () => {
    expectDecision(['docker rm -f web', 'docker rm --force web db', 'docker rm -fv web', 'docker container rm -f web', 'docker container remove --force web'], 'force_ask', REASONS.rmForce);
    expectDecision(['docker rmi -f node:20', 'docker rmi --force abc123', 'docker image rm -f node:20', 'docker image remove --force node'], 'force_ask', REASONS.rmiForce);
  });

  test('image prune --all and container prune --force', () => {
    expectDecision(['docker image prune -a', 'docker image prune --all', 'docker image prune -af'], 'force_ask', REASONS.imagePruneAll);
    expectDecision(['docker container prune -f', 'docker container prune --force'], 'force_ask', REASONS.containerPruneForce);
  });
});

describe('evaluateCommand: allow', () => {
  test('read-only inspection', () => {
    expectDecision(
      [
        'docker ps -a',
        'docker logs --tail 100 web',
        'docker inspect web',
        'docker stats --no-stream',
        'docker images',
        'docker info',
        'docker version',
        'docker system df',
        'docker compose ps',
        'docker compose logs -f web',
        'docker compose config',
        'docker volume ls',
        'docker volume inspect pgdata',
      ],
      'allow',
    );
  });

  test('normal lifecycle commands', () => {
    expectDecision(
      [
        'docker build -t app .',
        'docker run --rm -it -v data:/data alpine sh',
        'docker compose up -d --build',
        'docker stop web',
        'docker restart web',
        'docker compose down',
        'docker compose down --remove-orphans',
        'docker compose down --volumes=false',
        'docker compose -f compose.yml down',
        'docker rm web',
        'docker rmi node:18',
        'docker image prune',
        'docker image prune -f',
        'docker container prune',
        'docker compose rm -v web',
      ],
      'allow',
    );
  });

  test('non-docker commands and text that only mentions docker', () => {
    expectDecision(
      [
        'git status',
        'npm test',
        'echo "docker system prune -af --volumes"',
        'grep -r "docker volume rm -f" docs',
        'node scripts/docker-volume-rm-f.mjs',
        '',
        '   ',
      ],
      'allow',
    );
  });
});

describe('tokenizer and command chaining', () => {
  test('the strictest decision across chained commands wins', () => {
    expectDecision(['docker ps && docker system prune -af --volumes', 'docker ps; docker volume rm -f data', 'docker images | xargs docker volume rm -f'], 'deny');
    expectDecision(['docker compose down -v && docker compose up -d', 'docker rm -f web || true'], 'force_ask');
    assert.equal(evaluateCommand('docker compose down -v; docker volume prune -f').reason, REASONS.volumePruneForce);
  });

  test('handles newlines, subshells, and backticks', () => {
    expectDecision(['docker ps\ndocker volume rm -f data', '(cd app && docker volume prune --force)', 'echo $(docker volume rm -f data)', 'echo `docker volume rm -f data`'], 'deny');
  });

  test('handles quoted arguments', () => {
    expectDecision(['docker rm -f "my web"', "docker rm --force 'web'"], 'force_ask', REASONS.rmForce);
    expectDecision(['docker run alpine echo "docker volume rm -f x"'], 'allow');
  });

  test('recognizes docker.exe, full paths, and wrappers', () => {
    expectDecision(
      [
        'docker.exe volume rm -f data',
        'DOCKER.EXE volume rm -f data',
        '"C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe" volume rm -f data',
        '& "C:\\Program Files\\Docker\\docker.exe" system prune -af --volumes',
        '/usr/bin/docker volume prune -f',
        'sudo docker volume prune -f',
        'sudo -u root docker volume prune -f',
        'sudo -E docker system prune -af --volumes',
        'DOCKER_HOST=ssh://prod docker volume rm -f data',
        'env DOCKER_CONTEXT=prod docker volume rm -f data',
        'timeout 30 docker volume prune -f',
        'nice -n 10 docker volume prune -f',
        'wsl -d Ubuntu docker volume rm -f data',
      ],
      'deny',
    );
  });

  test('inspects nested shells up to three levels', () => {
    expectDecision(
      [
        'bash -c "docker system prune -af --volumes"',
        "sh -c 'docker ps && docker volume rm -f data'",
        'bash -lc "docker volume prune -f"',
        'cmd /c docker volume rm -f data',
        'cmd.exe /C "docker volume rm -f data"',
        'powershell -Command "docker volume prune -f"',
        'pwsh -NoProfile -c "docker volume rm --force data"',
        'powershell docker volume rm -f data',
        'powershell -NoProfile -ExecutionPolicy Bypass docker volume rm -f data',
        'bash -e -c "docker volume prune -f"',
        `powershell -EncodedCommand ${encodePowerShell('docker system prune -af --volumes')}`,
        'bash -c "sh -c \\"docker volume rm -f data\\""',
      ],
      'deny',
    );
    expectDecision(['bash -c "docker compose down -v"', 'cmd /c "docker compose -p shop down --volumes"'], 'force_ask', REASONS.composeDownVolumes);
    expectDecision(['bash -c "docker ps"', 'powershell -File cleanup.ps1', 'bash script.sh'], 'allow');
  });
});

describe('decide', () => {
  test('reads CommandLine from the PreToolUse payload', () => {
    const payload = { toolCall: { name: 'run_command', args: { CommandLine: 'docker volume rm -f data' } } };
    assert.deepEqual(decide(payload), { decision: 'deny', reason: REASONS.volumeRmForce });
  });

  test('falls back to args.command and allows missing or invalid commands', () => {
    assert.equal(decide({ toolCall: { args: { command: 'docker rm -f web' } } }).decision, 'force_ask');
    assert.deepEqual(decide({}), { decision: 'allow' });
    assert.deepEqual(decide(null), { decision: 'allow' });
    assert.deepEqual(decide({ toolCall: { args: { CommandLine: 42 } } }), { decision: 'allow' });
  });
});

function runHook(stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], { cwd: PLUGIN_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function preToolUse(commandLine) {
  return JSON.stringify({
    conversationId: 'conv-1',
    workspacePaths: [PLUGIN_ROOT],
    cwd: PLUGIN_ROOT,
    hookEventName: 'PreToolUse',
    stepIdx: 4,
    toolCall: { id: 'toolu_01', name: 'run_command', args: { CommandLine: commandLine, Cwd: PLUGIN_ROOT } },
  });
}

describe('hook CLI contract', () => {
  const cases = [
    ['denies system prune -af --volumes', preToolUse('docker system prune -af --volumes'), { decision: 'deny', reason: REASONS.systemPruneAllVolumes }],
    ['asks before compose down -v', preToolUse('docker compose down -v'), { decision: 'force_ask', reason: REASONS.composeDownVolumes }],
    ['allows read-only commands', preToolUse('docker ps -a'), { decision: 'allow' }],
    ['fails open on malformed JSON', '{not json', { decision: 'allow' }],
    ['fails open on empty stdin', '', { decision: 'allow' }],
    ['accepts a UTF-8 BOM', String.fromCharCode(0xfeff) + preToolUse('docker rm -f web'), { decision: 'force_ask', reason: REASONS.rmForce }],
  ];

  for (const [label, stdin, expected] of cases) {
    test(label, { timeout: 10000 }, async () => {
      const { code, stdout, stderr } = await runHook(stdin);
      assert.equal(code, 0);
      assert.equal(stderr, '');
      assert.ok(stdout.endsWith('\n'));
      assert.equal(stdout.trim().split('\n').length, 1, 'stdout must be a single line');
      assert.deepEqual(JSON.parse(stdout), expected);
    });
  }
});
