import { spawn } from 'node:child_process';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

async function outputDirectory(path) {
  const target = resolve(path);
  let ancestor = target;
  while (true) {
    try {
      await stat(ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  let existing = await realpath(ancestor);
  while (true) {
    let inGit = false;
    try {
      const git = await stat(join(existing, '.git'));
      // A linked worktree has a .git file; a repository directory has HEAD.
      if (git.isFile()) inGit = true;
      else { await stat(join(existing, '.git', 'HEAD')); inGit = true; }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (inGit) throw new Error('Preview output must be outside every Git working tree.');
    if (dirname(existing) === existing) break;
    existing = dirname(existing);
  }
  await mkdir(target, { recursive: true });
  return realpath(target);
}

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--out' || args[2] !== '--marker' || !['true', 'false'].includes(args[3])) {
    throw new Error('Usage: pnpm preview:export --out /absolute/path/outside/git --marker true|false');
  }
  const marked = args[3] === 'true';
  if (marked && !process.env.LANE_MARKER?.trim()) {
    throw new Error('Marked preview requires LANE_MARKER in the environment.');
  }
  const output = await outputDirectory(args[1]);
  const port = await unusedPort();
  const env = { ...process.env, PORT: String(port), LANE_ID: 'lane-07' };
  // Do not inherit a Node preload that could load .env or alter the child process.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  if (!marked) delete env.LANE_MARKER;

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const exited = new Promise((resolve) => child.once('close', resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Preview server exited before becoming healthy.');
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { healthy = true; break; }
      } catch { /* Retry while the child starts. */ }
      await delay(100);
    }
    if (!healthy) throw new Error('Preview server did not become healthy.');
    const response = await fetch(`${base}/digest/2026-10-28`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Digest export returned HTTP ${response.status}.`);
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Digest did not return HTML.');
    const html = await response.text();
    if (/<script\b|<(?:link|img|iframe)\b|\b(?:src|srcset)\s*=|url\s*\(|@import\b/i.test(html)) {
      throw new Error('Digest export must be self-contained HTML without scripts or external assets.');
    }
    // Replace a prior file without following a preexisting index.html symlink.
    await rm(join(output, 'index.html'), { force: true });
    await writeFile(join(output, 'index.html'), html, { mode: 0o600, flag: 'wx' });
    console.log(`Preview saved to ${join(output, 'index.html')}`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
    if (!stopped) { child.kill('SIGKILL'); await exited; }
  }
}

main().catch((error) => {
  console.error(`Preview export failed: ${error.message}`);
  process.exitCode = 1;
});
