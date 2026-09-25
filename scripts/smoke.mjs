/**
 * Post-build smoke test: loads the built `dist/` as both ESM and CJS and
 * exercises the parts that need no database.
 *
 * This catches the class of failure a unit test run against `src/` cannot:
 * a broken `exports` map, a missing `.d.ts`, an ESM/CJS interop mistake, or
 * an accidental top-level `ioredis` import that would make the core package
 * unloadable without the optional peer dependency installed.
 *
 * Run with `npm run test:package`.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(description, condition) {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    console.error(`  FAIL ${description}`);
    failures++;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

section('build output');
for (const file of [
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/ioredis.js',
  'dist/ioredis.cjs',
  'dist/ioredis.d.ts',
]) {
  check(`${file} exists`, existsSync(join(root, file)));
}

section('ESM entry point');
const esm = await import(new URL('../dist/index.js', import.meta.url).href);
for (const name of [
  'dumpRedis',
  'restoreRedisDump',
  'analyzeRedisDump',
  'preflightRestore',
  'isRedisDump',
  'parseRedisCommands',
  'streamRedisCommands',
  'encodeCommand',
  'checkTargetCompatibility',
]) {
  check(`exports ${name}`, typeof esm[name] === 'function');
}

section('CJS entry point');
const cjs = require(join(root, 'dist/index.cjs'));
check('exports dumpRedis', typeof cjs.dumpRedis === 'function');
check('exports restoreRedisDump', typeof cjs.restoreRedisDump === 'function');
check('exports isRedisDump', typeof cjs.isRedisDump === 'function');

section('ioredis adapter entry point');
const adapterEsm = await import(new URL('../dist/ioredis.js', import.meta.url).href);
check('exports fromIoredis', typeof adapterEsm.fromIoredis === 'function');
check('exports duplicateIoredis', typeof adapterEsm.duplicateIoredis === 'function');
check('exports connectIoredis', typeof adapterEsm.connectIoredis === 'function');
const adapterCjs = require(join(root, 'dist/ioredis.cjs'));
check('CJS exports fromIoredis', typeof adapterCjs.fromIoredis === 'function');

section('behaviour without a server');
const command = ['SET', Buffer.from([0x00, 0x22, 0x0a, 0xff]), 'two words'];
for (const format of ['text', 'resp']) {
  const encoded = esm.encodeCommand(command, format);
  const [parsed] = esm.parseRedisCommands(encoded);
  check(
    `${format} encoding round-trips binary arguments`,
    parsed.argv.length === 3 && Buffer.compare(parsed.argv[1], command[1]) === 0,
  );
}
check(
  'text commands are one line',
  esm.encodeCommand(command, 'text').toString().split('\n').length === 2,
);
check('isRedisDump recognizes a redis-cli script', esm.isRedisDump('SET a 1\nHSET h f v\n'));
check('isRedisDump rejects a SQL dump', !esm.isRedisDump('CREATE TABLE t (a int);\n'));
check(
  'FLUSHALL is refused by default',
  esm.checkCommandAllowed(['FLUSHALL'], 'restore') !== undefined,
);

section('core loads without the optional ioredis peer dependency');
{
  // Resolution of `ioredis` is deliberately broken, then the core entry point
  // is loaded from scratch in a child process. This is the one check that
  // proves the optional peer dependency boundary holds in the *built*
  // artifact rather than only in `src/`.
  const { execFileSync } = await import('node:child_process');
  const probe = `
    const Module = require('module');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      if (request === 'ioredis' || request.startsWith('ioredis/')) {
        throw new Error('ioredis is not installed (simulated)');
      }
      return originalResolve.call(this, request, ...rest);
    };
    const api = require(${JSON.stringify(join(root, 'dist/index.cjs'))});
    if (typeof api.dumpRedis !== 'function' || typeof api.restoreRedisDump !== 'function') {
      throw new Error('core entry point is incomplete');
    }
    process.stdout.write('ok');
  `;
  let loaded = false;
  try {
    loaded = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).trim() === 'ok';
  } catch (error) {
    console.error(`  (child failed: ${String(error.message).slice(0, 200)})`);
  }
  check('dist/index.cjs loads with ioredis unresolvable', loaded);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log('All smoke checks passed.');
