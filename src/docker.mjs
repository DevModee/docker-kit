// Docker CLI client, input validation, and output parsers for docker-kit.
// Zero runtime dependencies: every call goes through execFile("docker", args) without a shell.

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_MAX_TEXT_CHARS = 40000;
export const READ_TIMEOUT_MS = 15000;
export const WRITE_TIMEOUT_MS = 60000;

const MAX_BUFFER = 32 * 1024 * 1024;
const STDERR_MAX_CHARS = 2000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-/:@+]*$/;
const REFERENCE_RE = /^[A-Za-z0-9*][A-Za-z0-9_.\-/:@+*]*$/;
const SINCE_RE = /^[0-9][0-9A-Za-z:.+-]*$/;
const SUBCOMMAND_GROUPS = new Set(['compose', 'container', 'image', 'network', 'system', 'volume']);
const DAEMON_DOWN_RE =
  /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|open \/\/\.\/pipe\/docker|dial unix [^:]*docker\.sock/i;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const SECRET_KEY_RE =
  /secret|token|pass|key|private|auth|credential|dsn|cookie|jwt|api_key|database_url|redis_url/i;
const REDACTED = '[REDACTED]';

export class DockerError extends Error {
  constructor(message, code = 'DOCKER_ERROR') {
    super(message);
    this.name = 'DockerError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input validation. Values never start with "-", so they cannot be read as flags.
// ---------------------------------------------------------------------------

function checkString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new DockerError(`${label} must be a non-empty string.`, 'INVALID_INPUT');
  if (value.startsWith('-')) throw new DockerError(`${label} must not start with "-".`, 'INVALID_INPUT');
  if (value.length > 255) throw new DockerError(`${label} is too long (max 255 characters).`, 'INVALID_INPUT');
}

// Container, network, volume, and service names or IDs, and image references.
export function validateName(value, label = 'name') {
  checkString(value, label);
  if (!NAME_RE.test(value)) {
    throw new DockerError(
      `Invalid ${label} "${value}". Use letters, digits, and "_", ".", "-", "/", ":", "@", "+".`,
      'INVALID_INPUT',
    );
  }
  return value;
}

// Image reference filter, which may contain "*" wildcards (for example "node:*").
export function validateReference(value, label = 'reference') {
  checkString(value, label);
  if (!REFERENCE_RE.test(value)) throw new DockerError(`Invalid ${label} "${value}".`, 'INVALID_INPUT');
  return value;
}

// `--since` accepts a timestamp (2024-01-02T15:04:05Z) or a relative duration (10m, 2h).
export function validateSince(value) {
  checkString(value, 'since');
  if (!SINCE_RE.test(value)) {
    throw new DockerError('since must be a timestamp such as 2024-01-02T15:04:05Z or a duration such as 10m.', 'INVALID_INPUT');
  }
  return value;
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

// Working directory for Compose commands: an absolute path to an existing directory.
export function validateCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) {
    throw new DockerError('cwd must be the absolute path of the workspace that holds the Compose file.', 'INVALID_INPUT');
  }
  if (!isAbsolute(cwd)) throw new DockerError(`cwd must be an absolute path, got "${cwd}".`, 'INVALID_INPUT');
  const dir = resolve(cwd);
  if (!statOrNull(dir)?.isDirectory()) throw new DockerError(`cwd does not exist or is not a directory: ${dir}`, 'INVALID_INPUT');
  return dir;
}

// Compose file path, relative to cwd or absolute. Returns the resolved absolute path.
export function validateComposeFile(file, cwd) {
  checkString(file, 'file');
  if (file.includes('\0')) throw new DockerError('file contains an invalid character.', 'INVALID_INPUT');
  const path = resolve(cwd, file);
  if (!statOrNull(path)?.isFile()) throw new DockerError(`Compose file not found: ${path}`, 'INVALID_INPUT');
  return path;
}

// ---------------------------------------------------------------------------
// Secret redaction.
// ---------------------------------------------------------------------------

// Masks the password in URLs such as postgres://user:pass@host/db.
export function redactUrlCredentials(value) {
  return String(value).replace(/(\/\/[^/@:\s]+):[^/@\s]+@/g, `$1:${REDACTED}@`);
}

// "NAME=value" or "--name=value": the value is hidden when the name looks secret.
export function redactAssignment(entry) {
  const text = String(entry);
  const eq = text.indexOf('=');
  if (eq <= 0) return redactUrlCredentials(text);
  const key = text.slice(0, eq);
  if (SECRET_KEY_RE.test(key)) return `${key}=${REDACTED}`;
  return `${key}=${redactUrlCredentials(text.slice(eq + 1))}`;
}

export function redactEnvList(envArray) {
  if (!Array.isArray(envArray)) return [];
  return envArray.map(redactAssignment);
}

// ---------------------------------------------------------------------------
// Output parsing.
// ---------------------------------------------------------------------------

// Parses `--format '{{json .}}'` (one object per line) and `--format json`
// (a JSON array on older Compose releases, NDJSON on newer ones).
export function parseJsonLines(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : [data];
    } catch {
      // Not a single array: fall through to line-by-line parsing.
    }
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new DockerError(`Unexpected docker output (not JSON): ${trimmed.slice(0, 200)}`, 'PARSE_ERROR');
    }
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
  }
  return out;
}

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

export function truncateText(text, maxChars = DEFAULT_MAX_TEXT_CHARS, { keep = 'head' } = {}) {
  const value = String(text ?? '');
  if (!(maxChars > 0) || value.length <= maxChars) return value;
  if (keep === 'tail') {
    return `[truncated: showing last ${maxChars} of ${value.length} characters]\n${value.slice(-maxChars)}`;
  }
  return `${value.slice(0, maxChars)}\n[truncated: showing first ${maxChars} of ${value.length} characters]`;
}

// Sort key for a `docker logs --timestamps` line: RFC 3339 with the fraction padded to 9 digits.
function timestampKey(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})\s/.exec(line);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(ms)) return null;
  return `${String(ms).padStart(15, '0')}${(match[2] || '').padEnd(9, '0')}`;
}

function splitLogLines(text, stream) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  let lastKey = '';
  return lines.map((line, index) => {
    const key = timestampKey(line) ?? lastKey;
    lastKey = key;
    return { line, key, stream, index };
  });
}

// Interleaves the stdout and stderr of `docker logs --timestamps` in time order.
// Timestamps are removed again unless keepTimestamps is set.
export function mergeLogStreams(stdout, stderr, { keepTimestamps = false } = {}) {
  const entries = [...splitLogLines(stdout, 0), ...splitLogLines(stderr, 1)];
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.stream - b.stream || a.index - b.index));
  return entries
    .map(({ line }) => (keepTimestamps ? line : line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s/, '')))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

export function commandLabel(args) {
  const words = args.filter((a) => /^[a-z][a-z-]*$/.test(a));
  if (!words.length) return 'docker';
  const group = SUBCOMMAND_GROUPS.has(words[0]) && words[1] ? ` ${words[1]}` : '';
  return `docker ${words[0]}${group}`;
}

export function toDockerError(err, args, timeoutMs) {
  const label = commandLabel(args);
  if (err?.code === 'ENOENT') {
    return new DockerError(
      'Docker CLI not found in PATH. Install Docker Desktop or Docker Engine and make sure the `docker` command is available.',
      'DOCKER_NOT_FOUND',
    );
  }
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new DockerError(`${label} produced more output than the plugin can read. Narrow the request.`, 'OUTPUT_TOO_LARGE');
  }
  const stderr = stripAnsi(err?.stderr || '').trim();
  const stdout = stripAnsi(err?.stdout || '').trim();
  if (DAEMON_DOWN_RE.test(stderr) || DAEMON_DOWN_RE.test(stdout)) {
    return new DockerError(
      'Docker daemon is not running. Start Docker Desktop (or the docker service) and try again.',
      'DAEMON_DOWN',
    );
  }
  if (err?.killed || err?.signal) {
    return new DockerError(
      `${label} timed out after ${Math.round(timeoutMs / 1000)} s. The operation may still be in progress on the daemon.`,
      'TIMEOUT',
    );
  }
  const detail = stderr || stdout || err?.message || 'no error output';
  const exit = typeof err?.code === 'number' ? ` (exit ${err.code})` : '';
  return new DockerError(`${label} failed${exit}: ${truncateText(detail, STDERR_MAX_CHARS, { keep: 'tail' })}`, 'COMMAND_FAILED');
}

export function createDockerClient({
  execImpl = execFile,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  timeoutMs = READ_TIMEOUT_MS,
  env = process.env,
} = {}) {
  function runDocker(args, { cwd, timeoutMs: callTimeout = timeoutMs } = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return Promise.reject(new DockerError('docker arguments must be an array of strings.', 'INVALID_INPUT'));
    }
    const options = {
      cwd,
      timeout: callTimeout,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...env, DOCKER_CLI_HINTS: 'false' },
    };
    return new Promise((resolvePromise, reject) => {
      try {
        execImpl('docker', args, options, (err, stdout, stderr) => {
          if (err) {
            if (err.stdout === undefined) err.stdout = stdout;
            if (err.stderr === undefined) err.stderr = stderr;
            reject(toDockerError(err, args, callTimeout));
          } else {
            resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
          }
        });
      } catch (err) {
        reject(toDockerError(err, args, callTimeout));
      }
    });
  }

  async function runJson(args, options) {
    const { stdout } = await runDocker(args, options);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new DockerError(`Unexpected output from ${commandLabel(args)} (not JSON).`, 'PARSE_ERROR');
    }
  }

  async function runJsonLines(args, options) {
    const { stdout } = await runDocker(args, options);
    return parseJsonLines(stdout);
  }

  return {
    maxTextChars,
    runDocker,
    runJson,
    runJsonLines,
    truncate: (text, keep = 'head') => truncateText(text, maxTextChars, { keep }),
  };
}

let defaultClient = null;

export function getDefaultClient() {
  if (!defaultClient) defaultClient = createDockerClient();
  return defaultClient;
}
