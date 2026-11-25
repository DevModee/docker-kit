#!/usr/bin/env node
// PreToolUse hook: blocks or asks before destructive docker commands.
// stdin: Antigravity PreToolUse payload (camelCase JSON).
// stdout: one line of JSON { decision, reason? }. Always exits 0 and fails open to "allow".

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh']);
const SEPARATORS = new Set([';', '|', '&', '\n', '\r', '(', ')', '{', '}', '`']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 3;

// Command prefixes that run the next word as a program, with their options that take a value.
const WRAPPERS = new Map([
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--host', '--prompt'])],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '--unset', '--chdir'])],
  ['command', new Set()],
  ['exec', new Set(['-a'])],
  ['nohup', new Set()],
  ['time', new Set(['-o', '-f', '--output', '--format'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['xargs', new Set(['-I', '-n', '-L', '-P', '-s', '-E', '-a', '-d', '--max-args', '--max-procs', '--arg-file', '--delimiter'])],
  ['wsl', new Set(['-d', '-u', '--distribution', '--user', '--cd'])],
]);

const DOCKER_GLOBAL_OPTS_WITH_VALUE = new Set([
  '-c', '--context', '-H', '--host', '-l', '--log-level', '--config', '--tlscacert', '--tlscert', '--tlskey',
]);
const COMPOSE_GLOBAL_OPTS_WITH_VALUE = new Set([
  '-f', '--file', '-p', '--project-name', '--project-directory', '--env-file', '--profile', '--ansi', '--progress', '--parallel',
]);
const COMPOSE_DOWN_OPTS_WITH_VALUE = new Set(['-t', '--timeout', '--rmi']);
const PRUNE_OPTS_WITH_VALUE = new Set(['--filter']);
const POWERSHELL_OPTS_WITH_VALUE = new Set([
  '-executionpolicy', '-ep', '-windowstyle', '-w', '-outputformat', '-of', '-inputformat', '-if',
  '-configurationname', '-workingdirectory', '-wd', '-version', '-v', '-psconsolefile',
]);

const SEVERITY = { allow: 0, ask: 1, force_ask: 2, deny: 3 };

export const REASONS = {
  systemPruneAllVolumes:
    'Blocked docker system prune with --all and --volumes: it deletes every unused image and volume irreversibly.',
  volumePruneForce: 'Blocked forced docker volume prune: it deletes unused volumes and their data without a prompt.',
  volumeRmForce: 'Blocked forced docker volume rm: it deletes volume data without a prompt.',
  systemPrune: 'Confirm docker system prune: it removes stopped containers, unused networks, and unused images.',
  volumeRm: 'Confirm docker volume rm: the data stored in the volume is deleted permanently.',
  volumePrune: 'Confirm docker volume prune: unused volumes and their data are deleted permanently.',
  composeDownVolumes: 'Confirm docker compose down with volumes: the volumes of the stack, databases included, are deleted.',
  rmForce: 'Confirm docker rm --force: running containers are killed and removed.',
  rmiForce: 'Confirm docker rmi --force: images are removed even when they are tagged or used by containers.',
  imagePruneAll: 'Confirm docker image prune --all: every image not used by a container is deleted.',
  containerPruneForce: 'Confirm docker container prune --force: all stopped containers are removed without a prompt.',
};

const ALLOW = Object.freeze({ decision: 'allow' });
const verdict = (decision, reason) => ({ decision, reason });

function stricter(a, b) {
  return SEVERITY[b.decision] > SEVERITY[a.decision] ? b : a;
}

// ---------------------------------------------------------------------------
// Tokenizer: splits a command line into segments of tokens, honoring quotes.
// ---------------------------------------------------------------------------

function tokenize(commandLine) {
  const segments = [];
  let tokens = [];
  let current = '';
  let inToken = false;
  let quoted = false;
  let quote = null;

  const endToken = () => {
    if (inToken) tokens.push({ value: current, quoted });
    current = '';
    inToken = false;
    quoted = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  const text = String(commandLine);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) current += text[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      quoted = true;
    } else if (SEPARATORS.has(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      current += ch;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}

function basename(token) {
  return token.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

// ---------------------------------------------------------------------------
// Flag parsing.
// ---------------------------------------------------------------------------

// Collects long flags (with their values) and short letters, skipping option values.
function parseFlags(args, optsWithValue = new Set()) {
  const long = new Map();
  const short = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (eq >= 0) long.set(name, arg.slice(eq + 1));
      else if (optsWithValue.has(name)) long.set(name, args[++i] ?? '');
      else long.set(name, true);
    } else if (arg.startsWith('-') && arg.length > 1) {
      const letters = arg.slice(1);
      for (const ch of letters) short.add(ch);
      if (optsWithValue.has(`-${letters[letters.length - 1]}`)) i += 1;
    }
  }
  return {
    has(longName, letter) {
      if (long.has(longName)) {
        const value = long.get(longName);
        return value === true || String(value).toLowerCase() !== 'false';
      }
      return letter ? short.has(letter) : false;
    },
  };
}

// Skips leading global options and returns the index of the first subcommand word.
function skipOptions(args, optsWithValue) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const arg = args[i];
    i += !arg.includes('=') && optsWithValue.has(arg) ? 2 : 1;
  }
  return i;
}

// ---------------------------------------------------------------------------
// docker subcommand analysis.
// ---------------------------------------------------------------------------

function analyzeSystemPrune(args) {
  const flags = parseFlags(args, PRUNE_OPTS_WITH_VALUE);
  if (flags.has('--all', 'a') && flags.has('--volumes')) return verdict('deny', REASONS.systemPruneAllVolumes);
  return verdict('force_ask', REASONS.systemPrune);
}

function analyzeVolume(sub, args) {
  if (sub === 'rm' || sub === 'remove') {
    const flags = parseFlags(args);
    return flags.has('--force', 'f') ? verdict('deny', REASONS.volumeRmForce) : verdict('force_ask', REASONS.volumeRm);
  }
  if (sub === 'prune') {
    const flags = parseFlags(args, PRUNE_OPTS_WITH_VALUE);
    return flags.has('--force', 'f') ? verdict('deny', REASONS.volumePruneForce) : verdict('force_ask', REASONS.volumePrune);
  }
  return ALLOW;
}

function analyzeContainerRm(args) {
  return parseFlags(args).has('--force', 'f') ? verdict('force_ask', REASONS.rmForce) : ALLOW;
}

function analyzeImageRm(args) {
  return parseFlags(args).has('--force', 'f') ? verdict('force_ask', REASONS.rmiForce) : ALLOW;
}

function analyzeCompose(args) {
  const start = skipOptions(args, COMPOSE_GLOBAL_OPTS_WITH_VALUE);
  if (args[start] !== 'down') return ALLOW;
  const flags = parseFlags(args.slice(start + 1), COMPOSE_DOWN_OPTS_WITH_VALUE);
  return flags.has('--volumes', 'v') ? verdict('force_ask', REASONS.composeDownVolumes) : ALLOW;
}

function analyzeDocker(args) {
  const start = skipOptions(args, DOCKER_GLOBAL_OPTS_WITH_VALUE);
  const command = args[start];
  const sub = args[start + 1];
  const rest = args.slice(start + 2);

  switch (command) {
    case 'rm':
      return analyzeContainerRm(args.slice(start + 1));
    case 'rmi':
      return analyzeImageRm(args.slice(start + 1));
    case 'compose':
      return analyzeCompose(args.slice(start + 1));
    case 'system':
      return sub === 'prune' ? analyzeSystemPrune(rest) : ALLOW;
    case 'volume':
      return analyzeVolume(sub, rest);
    case 'container':
      if (sub === 'rm' || sub === 'remove') return analyzeContainerRm(rest);
      if (sub === 'prune' && parseFlags(rest, PRUNE_OPTS_WITH_VALUE).has('--force', 'f')) {
        return verdict('force_ask', REASONS.containerPruneForce);
      }
      return ALLOW;
    case 'image':
      if (sub === 'rm' || sub === 'remove') return analyzeImageRm(rest);
      if (sub === 'prune' && parseFlags(rest, PRUNE_OPTS_WITH_VALUE).has('--all', 'a')) {
        return verdict('force_ask', REASONS.imagePruneAll);
      }
      return ALLOW;
    default:
      return ALLOW;
  }
}

// ---------------------------------------------------------------------------
// Segment analysis, wrappers, and nested shells.
// ---------------------------------------------------------------------------

function findProgram(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const value = tokens[i].value;
    if (ENV_ASSIGNMENT.test(value) || value === '$') {
      i += 1;
      continue;
    }
    const name = basename(value);
    const wrapperOpts = WRAPPERS.get(name);
    if (!wrapperOpts) return i;
    i += 1;
    while (i < tokens.length && tokens[i].value.startsWith('-')) {
      const opt = tokens[i].value;
      i += !opt.includes('=') && wrapperOpts.has(opt) ? 2 : 1;
    }
    if (name === 'timeout' && i < tokens.length) i += 1;
  }
  return -1;
}

function decodePowerShellCommand(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

// Extracts the inline scripts passed to a shell (bash -c, cmd /c, powershell -Command).
function shellScripts(program, values) {
  const scripts = [];
  if (program === 'cmd') {
    const idx = values.findIndex((v) => /^\/[ck]$/i.test(v));
    if (idx >= 0) scripts.push(values.slice(idx + 1).join(' '));
  } else if (program === 'powershell' || program === 'pwsh') {
    // Only the options before the first positional word belong to PowerShell itself.
    let i = 0;
    while (i < values.length && values[i].startsWith('-')) {
      const opt = values[i].toLowerCase();
      if (/^-(c|command)$/.test(opt)) return [values.slice(i + 1).join(' ')];
      if (/^-(e|ec|enc|encodedcommand)$/.test(opt)) return values[i + 1] ? [decodePowerShellCommand(values[i + 1])] : [];
      if (/^-(f|file)$/.test(opt)) return [];
      i += POWERSHELL_OPTS_WITH_VALUE.has(opt) ? 2 : 1;
    }
    // `powershell [options] docker ...`: the remaining words are the command.
    scripts.push(values.slice(i).join(' '));
  } else {
    for (let i = 0; i < values.length && values[i].startsWith('-'); i += 1) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(values[i])) {
        if (values[i + 1] !== undefined) scripts.push(values[i + 1]);
        break;
      }
    }
  }
  return scripts;
}

function analyzeSegment(tokens, depth) {
  const start = findProgram(tokens);
  if (start < 0) return ALLOW;

  const program = basename(tokens[start].value);
  const args = tokens.slice(start + 1);
  const values = args.map((t) => t.value);

  if (program === 'docker') return analyzeDocker(values);
  if (program === 'docker-compose') return analyzeCompose(values);

  // Nested shells such as `bash -c "docker volume rm -f data"`.
  if (SHELLS.has(program) && depth < MAX_DEPTH) {
    const scripts = shellScripts(program, values);
    for (const token of args) {
      if (token.quoted && /docker/i.test(token.value)) scripts.push(token.value);
    }
    let result = ALLOW;
    for (const script of scripts) result = stricter(result, evaluate(script, depth + 1));
    return result;
  }
  return ALLOW;
}

function evaluate(commandLine, depth) {
  let result = ALLOW;
  for (const tokens of tokenize(commandLine)) {
    result = stricter(result, analyzeSegment(tokens, depth));
    if (result.decision === 'deny') break;
  }
  return result;
}

// Returns { decision: "allow" | "force_ask" | "deny", reason? } for a command line.
export function evaluateCommand(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return { ...ALLOW };
  const result = evaluate(commandLine, 0);
  return result.reason ? { decision: result.decision, reason: result.reason } : { decision: result.decision };
}

// ---------------------------------------------------------------------------
// Hook entry point.
// ---------------------------------------------------------------------------

export function decide(payload) {
  const args = payload?.toolCall?.args || {};
  const commandLine = args.CommandLine ?? args.command ?? '';
  return evaluateCommand(typeof commandLine === 'string' ? commandLine : '');
}

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let output = { decision: 'allow' };
  try {
    // String.prototype.trim also strips a leading UTF-8 BOM (U+FEFF) added by some shells.
    const raw = (await readStdin()).trim();
    if (raw) output = decide(JSON.parse(raw));
  } catch {
    output = { decision: 'allow' };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}

if (isMainModule()) {
  main();
}
