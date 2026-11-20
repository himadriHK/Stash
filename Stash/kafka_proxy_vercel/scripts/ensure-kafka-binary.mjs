#!/usr/bin/env node
/**
 * npm 11+ blocks dependency lifecycle scripts unless they are allowlisted, which
 * leaves @confluentinc/kafka-javascript without its prebuilt librdkafka binary.
 * Importing the package then throws at runtime, so make sure the binary exists
 * during install (locally and on the Vercel build machine).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const PACKAGE = '@confluentinc/kafka-javascript';
const TAG = '[stash-kafka-proxy]';

function packageDirectory() {
  try {
    return path.dirname(require.resolve(`${PACKAGE}/package.json`));
  } catch {
    return null;
  }
}

function binaryPath(directory) {
  return path.join(directory, 'build', 'Release', 'confluent-kafka-javascript.node');
}

function nodePreGypPath() {
  for (const specifier of [
    '@mapbox/node-pre-gyp/bin/node-pre-gyp',
    '@mapbox/node-pre-gyp/bin/node-pre-gyp.js',
  ]) {
    try {
      return require.resolve(specifier);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const directory = packageDirectory();
if (!directory) {
  console.log(`${TAG} ${PACKAGE} is not installed; skipping the binary check.`);
  process.exit(0);
}

if (existsSync(binaryPath(directory))) {
  console.log(`${TAG} librdkafka binding is present.`);
  process.exit(0);
}

console.log(`${TAG} prebuilt librdkafka binding is missing; downloading it...`);

const preGyp = nodePreGypPath();
const result = preGyp
  ? spawnSync(process.execPath, [preGyp, 'install', '--fallback-to-build'], {
      cwd: directory,
      stdio: 'inherit',
    })
  : spawnSync('npm', ['rebuild', PACKAGE], { cwd: process.cwd(), stdio: 'inherit' });

if (result.error || result.status !== 0 || !existsSync(binaryPath(directory))) {
  console.error(
    `${TAG} could not install the native binding.\n` +
      `Run \`npm rebuild ${PACKAGE}\`, or approve its install script with\n` +
      `\`npm install-scripts approve ${PACKAGE}\` and reinstall.`,
  );
  process.exit(1);
}

console.log(`${TAG} librdkafka binding installed.`);
