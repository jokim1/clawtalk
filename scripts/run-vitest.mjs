import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestEntrypoint = join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');

function readExpectedNodeMajor() {
  const nvmrcPath = join(projectRoot, '.nvmrc');
  if (!existsSync(nvmrcPath)) {
    return null;
  }

  const raw = readFileSync(nvmrcPath, 'utf8').trim();
  const major = Number.parseInt(raw.replace(/^v/, ''), 10);
  return Number.isFinite(major) ? major : null;
}

function assertSupportedNodeVersion() {
  if (process.env.CLAWTALK_ALLOW_UNSUPPORTED_NODE === '1') {
    return;
  }

  const expectedMajor = readExpectedNodeMajor();
  const actualMajor = Number.parseInt(process.versions.node.split('.')[0], 10);

  if (expectedMajor !== null && actualMajor !== expectedMajor) {
    console.error(
      [
        `Vitest in this repo is only supported on Node ${expectedMajor}.x.`,
        `Detected Node ${process.versions.node}.`,
        `Switch to the version in .nvmrc before running tests, or set CLAWTALK_ALLOW_UNSUPPORTED_NODE=1 to override.`,
      ].join('\n'),
    );
    process.exit(1);
  }
}

function buildVitestArgs() {
  const userArgs = process.argv.slice(2);
  const hasUserPool = userArgs.some((arg) => arg === '--pool' || arg.startsWith('--pool='));
  const hasUserMaxWorkers = userArgs.some(
    (arg) => arg === '--maxWorkers' || arg.startsWith('--maxWorkers='),
  );
  const hasUserParallelism = userArgs.some(
    (arg) => arg === '--fileParallelism' || arg === '--no-file-parallelism',
  );

  const stableDefaults = [];
  if (!hasUserPool) {
    stableDefaults.push('--pool=forks');
  }
  if (!hasUserMaxWorkers) {
    stableDefaults.push('--maxWorkers=1');
  }
  if (!hasUserParallelism) {
    stableDefaults.push('--no-file-parallelism');
  }

  return [...stableDefaults, ...userArgs];
}

assertSupportedNodeVersion();

const result = spawnSync(process.execPath, [vitestEntrypoint, ...buildVitestArgs()], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
