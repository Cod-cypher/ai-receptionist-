#!/usr/bin/env node
/**
 * One command for a full development stack: `npm run dev`.
 *
 *   docker (postgres + redis)  ->  schema and seed if the database is empty
 *   cloudflared quick tunnel   ->  PUBLIC_BASE_URL written to .env
 *   the API on :3000           ->  started with that URL already in its env
 *   npm run twilio:connect     ->  the Twilio number pointed at this tunnel
 *   the dashboard on :4200
 *
 * The ordering exists because a free tunnel URL changes on every restart, and
 * the number's webhooks, PUBLIC_BASE_URL and Twilio's request signature all
 * have to agree exactly. Doing it by hand across three terminals is how a test
 * call ends in "403 Invalid Twilio signature": the API gets started before the
 * new URL is in .env, so it validates signatures against the old one. Here the
 * API is spawned *after* the tunnel is up, with PUBLIC_BASE_URL in its
 * environment, so the two cannot disagree.
 *
 * Ctrl+C stops everything it started, including the tunnel.
 *
 * Flags: --no-tunnel  --no-dashboard  --no-twilio  --no-docker
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(ROOT, '.env');
const WINDOWS = process.platform === 'win32';

const args = process.argv.slice(2);
const off = (name) => args.includes(`--no-${name}`);
const WANT_TUNNEL = !off('tunnel');
const WANT_DASHBOARD = !off('dashboard');
const WANT_TWILIO = !off('twilio');
const WANT_DOCKER = !off('docker');
// Launching Docker Desktop is opt-in: on a machine where it is unstable, a dev
// command that starts it is a dev command that can take the machine down.
const WANT_DOCKER_LAUNCH = args.includes('--start-docker');

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const PAINT = { dev: 36, api: 32, web: 35, tunnel: 33, docker: 34, twilio: 31 };
const paint = (tag, text) => (COLOR ? `\u001b[${PAINT[tag] ?? 37}m${text}\u001b[0m` : text);
const WIDTH = 6;

function log(tag, line) {
  process.stdout.write(`${paint(tag, tag.padEnd(WIDTH))} ${line}\n`);
}

function step(line) {
  log('dev', COLOR ? `\u001b[1m${line}\u001b[0m` : line);
}

/**
 * Prefixes a child's output line by line, so three programs stay readable.
 * `show` filters what is printed; `onLine` still sees every line.
 */
function pipeTagged(child, tag, onLine, show = () => true) {
  const pending = { out: '', err: '' };
  const attach = (stream, key) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (pending[key] + chunk).split(/\r?\n/);
      pending[key] = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() && show(line)) log(tag, line);
        onLine?.(line);
      }
    });
  };
  attach(child.stdout, 'out');
  attach(child.stderr, 'err');
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

const children = new Set();

/**
 * npm is a shell script on Windows, and since Node 20.12 spawning a .cmd
 * without a shell throws EINVAL. The shell wrapper means `child.pid` is the
 * shell's, which is why shutdown kills the whole process tree rather than one
 * pid.
 */
function spawnChild(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    shell: WINDOWS && command === 'npm',
    detached: !WINDOWS,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    env: { ...process.env, FORCE_COLOR: COLOR ? '1' : '0', ...options.env },
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  try {
    if (WINDOWS) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

/** Runs a command to completion, tagging its output. Resolves with the code. */
function run(tag, command, commandArgs, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawnChild(command, commandArgs, options);
    pipeTagged(child, tag);
    child.on('error', (error) => {
      log(tag, `could not start ${command}: ${error.message}`);
      resolvePromise(null);
    });
    child.on('close', (code) => resolvePromise(code));
  });
}

/** Same, but captures stdout instead of printing it (for small probes). */
function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    shell: WINDOWS && command === 'npm',
    encoding: 'utf8',
  });
  return { code: result.status, stdout: (result.stdout ?? '').trim() };
}

let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  step('stopping');
  for (const child of [...children].reverse()) killTree(child);
  // Give taskkill / SIGTERM a moment to land before the event loop is gone.
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  const values = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return values;
}

/** Rewrites one key in .env, leaving every comment and other value alone. */
function writeEnvValue(key, value) {
  const original = readFileSync(ENV_FILE, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm');
  const updated = pattern.test(original)
    ? original.replace(pattern, `${key}=${value}`)
    : `${original.replace(/\s*$/, '')}${newline}${key}=${value}${newline}`;
  if (updated !== original) writeFileSync(ENV_FILE, updated);
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Free on IPv4 and on IPv6. Another project's Vite server listens on [::1]
 * only, which a check of 0.0.0.0 alone does not see; the API then started
 * beside it, and anything asking for "localhost" reached Vite instead. Twilio
 * was answered with Vite's "Blocked request" page and told the caller that an
 * application error had occurred.
 */
async function portFree(port) {
  const free = (host) =>
    new Promise((resolvePromise) => {
      const server = createServer();
      // A machine with no IPv6 cannot have anything listening on it.
      server.once('error', (error) => resolvePromise(error?.code === 'EADDRNOTAVAIL' || error?.code === 'EAFNOSUPPORT'));
      server.once('listening', () => server.close(() => resolvePromise(true)));
      server.listen({ port, host, ipv6Only: host === '::1' });
    });
  return (await free('0.0.0.0')) && (await free('::1'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Names whatever holds a port. "Port 3000 is in use" is a dead end when the
 * culprit is another project's dev server two desktops away.
 */
function portOwner(port) {
  const netstat = capture(WINDOWS ? 'netstat' : 'lsof', WINDOWS ? ['-ano'] : ['-i', `:${port}`, '-sTCP:LISTEN']);
  if (!WINDOWS) return netstat.stdout.split('\n')[1]?.trim() || 'another program';

  const pid = netstat.stdout
    .split(/\r?\n/)
    .find((line) => new RegExp(`:${port}\\s`).test(line) && /LISTENING/.test(line))
    ?.trim()
    .split(/\s+/)
    .pop();
  if (!pid) return 'another program';

  // The command line says which project it belongs to; the image name is
  // "node.exe" for every one of them.
  const wmic = capture('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
  ]);
  const command = wmic.stdout.replace(/\s+/g, ' ').trim();
  return command ? `pid ${pid}: ${command.slice(0, 120)}` : `pid ${pid}`;
}

/** Polls /health until the API answers with its database up. */
async function waitForHealth(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    if (shuttingDown) return 'stopping';
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.json();
      if (body?.database === 'up') return null;
      lastError = `database ${body?.database ?? 'unknown'}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000);
  }
  return lastError;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function ensureEnvFile() {
  if (existsSync(ENV_FILE)) return;
  copyFileSync(resolve(ROOT, '.env.example'), ENV_FILE);
  step('.env created from .env.example');
}

/**
 * The API resolves @towai/shared through the workspace link to its *compiled*
 * output, so a missing dist is `Cannot find module '@towai/shared'`.
 */
async function ensureSharedBuilt() {
  if (existsSync(resolve(ROOT, 'packages/shared/dist/index.js'))) return;
  step('building @towai/shared (first run)');
  await run('dev', 'npm', ['run', 'build', '-w', '@towai/shared']);
}

const DOCKER_DESKTOP = {
  win32: ['C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'],
  darwin: ['/Applications/Docker.app'],
};

/**
 * The daemon, not just the CLI. Checking it here is far cheaper than letting
 * the API start and spend three minutes failing its health check.
 *
 * Starting Docker Desktop is left to you unless --start-docker is passed. It
 * is the heaviest thing on the machine and the one most likely to misbehave,
 * and a crash while `npm run dev` brought it up is indistinguishable from a
 * crash this project caused.
 */
async function ensureDockerRunning() {
  if (capture('docker', ['info', '-f', '{{.ServerVersion}}']).code === 0) return true;

  const app = (DOCKER_DESKTOP[process.platform] ?? []).find((path) => existsSync(path));
  if (!WANT_DOCKER_LAUNCH || !app) {
    log('docker', 'the Docker daemon is not reachable - start Docker Desktop, then run this again');
    log('docker', 'or pass --start-docker to have this script launch and wait for it');
    return false;
  }

  step('starting Docker Desktop (this takes a moment on a cold boot)');
  // Spawned directly rather than through `cmd /c start`, whose quoting of the
  // space in "Program Files" Node's argument escaping breaks.
  const launcher =
    process.platform === 'darwin'
      ? spawn('open', ['-a', app], { detached: true, stdio: 'ignore' })
      : spawn(app, [], { detached: true, stdio: 'ignore' });
  launcher.on('error', (error) => log('docker', `could not launch Docker Desktop: ${error.message}`));
  launcher.unref();

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    await sleep(3_000);
    if (capture('docker', ['info', '-f', '{{.ServerVersion}}']).code === 0) {
      log('docker', 'the daemon is up');
      return true;
    }
  }
  log('docker', 'Docker Desktop did not come up within three minutes');
  return false;
}

async function ensureServices() {
  if (!WANT_DOCKER) return;
  if (!(await ensureDockerRunning())) {
    log('docker', 'carrying on; the API will say so if it cannot reach the database');
    return;
  }

  step('starting postgres and redis');
  const code = await run('docker', 'docker', ['compose', 'up', '-d', 'postgres', 'redis']);
  if (code !== 0) {
    log('docker', 'could not start the containers');
    log('docker', 'carrying on; the API will say so if it cannot reach the database');
    return;
  }

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const ready = capture('docker', [
      'compose', 'exec', '-T', 'postgres',
      'pg_isready', '-U', 'postgres', '-d', 'towai', '-q',
    ]);
    if (ready.code === 0) break;
    await sleep(1_000);
  }

  // A fresh volume has no schema. Both scripts are safe to re-run, but they
  // cost ~20s, so only run them when the tables are genuinely missing.
  const tables = capture('docker', [
    'compose', 'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'towai', '-tAc',
    "select to_regclass('public.businesses') is not null",
  ]);
  if (tables.code === 0 && tables.stdout !== 't') {
    step('empty database - running migrations and seed');
    await run('dev', 'npm', ['run', 'migrate']);
    await run('dev', 'npm', ['run', 'seed']);
  }
}

/**
 * Starts a cloudflared quick tunnel and resolves with the https URL it prints.
 * Resolves null when cloudflared is not installed or never prints one; the
 * caller then falls back to local-only development.
 */
function startTunnel(port) {
  return new Promise((resolvePromise) => {
    // 127.0.0.1, not localhost: on Windows "localhost" is tried as [::1]
    // first, which is where other projects' dev servers tend to listen.
    const child = spawnChild('cloudflared', [
      'tunnel',
      '--url',
      `http://127.0.0.1:${port}`,
      '--no-autoupdate',
    ]);

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    // cloudflared prints the URL inside a box on stderr, not stdout, among
    // ~40 lines of INF banner; only its warnings and errors are worth showing.
    pipeTagged(
      child,
      'tunnel',
      (line) => {
        // Not api.trycloudflare.com: cloudflared logs its own control-plane
        // endpoint ("Requesting new quick Tunnel on ...") several lines before
        // the tunnel it assigns you, and taking that one puts an address in
        // .env that answers Twilio with somebody else's 404.
        const match = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(line);
        if (match) settle(match[0]);
      },
      (line) => /\b(WRN|ERR|FTL)\b/.test(line),
    );

    child.on('error', (error) => {
      log('tunnel', `cloudflared could not start: ${error.message}`);
      log('tunnel', 'install it with: winget install --id Cloudflare.cloudflared');
      settle(null);
    });
    child.on('exit', () => settle(null));

    const timer = setTimeout(() => {
      log('tunnel', 'no URL after 60s - carrying on without a tunnel');
      settle(null);
    }, 60_000);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureEnvFile();
  const env = readEnv();
  const port = Number(process.env.PORT ?? env.PORT ?? 3000);

  if (!(await portFree(port))) {
    log('dev', `port ${port} is already in use by ${portOwner(port)}`);
    log('dev', 'stop it, or set PORT in .env to something free');
    process.exit(1);
  }

  await ensureSharedBuilt();

  // The tunnel takes a few seconds to come up; let it while Docker starts.
  const tunnelPromise = WANT_TUNNEL ? startTunnel(port) : Promise.resolve(null);

  await ensureServices();
  if (shuttingDown) return;

  let publicUrl = await tunnelPromise;
  if (shuttingDown) return;

  if (publicUrl) {
    writeEnvValue('PUBLIC_BASE_URL', publicUrl);
    step(`tunnel ${publicUrl} -> .env`);
  } else {
    const existing = env.PUBLIC_BASE_URL ?? '';
    const usable = /^https:\/\//.test(existing) && !/localhost|127\.0\.0\.1/.test(existing);
    if (WANT_TUNNEL && usable) {
      publicUrl = existing;
      step(`no new tunnel - keeping PUBLIC_BASE_URL ${publicUrl}`);
    } else {
      publicUrl = `http://localhost:${port}`;
      step('local only - no public URL, so Twilio cannot reach this machine');
    }
  }

  const local = `http://127.0.0.1:${port}`;
  const pipeline = process.env.VOICE_PIPELINE ?? env.VOICE_PIPELINE ?? 'gather';

  step(`starting the API (VOICE_PIPELINE=${pipeline})`);
  const api = spawnChild('npm', ['run', 'start:dev', '-w', '@towai/api'], {
    env: { PUBLIC_BASE_URL: publicUrl },
  });
  pipeTagged(api, 'api');
  api.on('exit', (code) => {
    if (shuttingDown) return;
    log('api', `exited (${code}) - stopping everything else`);
    shutdown(code ?? 1);
  });

  // nest start --watch compiles first; a cold tsc run can take a while.
  const failure = await waitForHealth(local, 180_000);
  if (shuttingDown) return;
  if (failure) {
    log('dev', `the API never became healthy (${failure}) - leaving it running so the log above stays readable`);
  } else {
    step('API is up and its database is reachable');
  }

  // Twilio, once the tunnel demonstrably reaches the running API.
  const twilioReady =
    WANT_TWILIO &&
    publicUrl.startsWith('https://') &&
    Boolean((process.env.TWILIO_ACCOUNT_SID ?? env.TWILIO_ACCOUNT_SID ?? '').trim()) &&
    Boolean((process.env.TWILIO_AUTH_TOKEN ?? env.TWILIO_AUTH_TOKEN ?? '').trim());

  if (twilioReady && !failure) {
    const reachable = await waitForHealth(publicUrl, 45_000);
    if (reachable) {
      log('twilio', `the tunnel does not reach the API yet (${reachable}) - skipping twilio:connect`);
      log('twilio', 'run `npm run twilio:connect` by hand once it does');
    } else {
      step('pointing the Twilio number at this tunnel');
      // Anything this script did not consume (--number, --business, --dry-run)
      // is meant for connect-number.ts.
      const passThrough = args.filter((arg) => !/^--no-(tunnel|dashboard|twilio|docker)$/.test(arg));
      const code = await run('twilio', 'npm', ['run', 'twilio:connect', '--', ...passThrough], {
        env: { PUBLIC_BASE_URL: publicUrl },
      });
      if (code !== 0) log('twilio', 'twilio:connect failed - the rest of the stack is still running');
    }
  } else if (WANT_TWILIO && !failure) {
    log('twilio', 'skipped: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set, or no public URL');
  }
  if (shuttingDown) return;

  if (WANT_DASHBOARD) {
    if (await portFree(4200)) {
      step('starting the dashboard');
      pipeTagged(spawnChild('npm', ['run', 'dev:dashboard']), 'web');
    } else {
      log('web', 'port 4200 is in use - skipping the dashboard');
    }
  }

  const lines = [
    '',
    `  API         ${local}`,
    `  Swagger     ${local}/api/docs`,
    publicUrl.startsWith('https://') ? `  Public      ${publicUrl}` : null,
    WANT_DASHBOARD ? '  Dashboard   http://localhost:4200' : null,
    '',
    '  Sign in     owner@libertytowing.test / demo-password-1234',
    '  No phone?   npm run simulate:call   (in another terminal)',
    '',
    '  Ctrl+C stops the API, the dashboard and the tunnel.',
    '',
  ].filter((line) => line !== null);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  log('dev', error instanceof Error ? (error.stack ?? error.message) : String(error));
  shutdown(1);
});
