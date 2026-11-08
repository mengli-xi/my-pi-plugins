#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const bytes = new Map();
function read(file) {
  const stat = fs.statSync(file);
  const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (bytes.has(file)) {
    assert.equal(bytes.get(file).version, version, `Artifact changed during check: ${file}`);
    return bytes.get(file).content;
  }
  const content = fs.readFileSync(file);
  bytes.set(file, { version, content });
  return content;
}
const text = (file) => read(file).toString('utf8');
const hash = (file) => createHash('sha256').update(read(file)).digest('hex');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--sdk', '--output'].includes(process.argv[i]), `Unknown option ${process.argv[i]}`);
  options[process.argv[i].slice(2)] = path.resolve(process.argv[i + 1]);
}
assert.ok(options.sdk && options.output, 'Required: --sdk <built package> --output <new test directory>');
assert.ok(!fs.existsSync(options.output), 'Choose a new test output directory');
fs.mkdirSync(options.output, { recursive: true });
const chunks = path.join(options.sdk, 'dist/bundle/chunks');
const themeChunks = fs.readdirSync(chunks).filter((name) => name.endsWith('.js') && text(path.join(chunks, name)).includes('function startThemeWatcher('));
assert.equal(themeChunks.length, 1, 'Exactly one compiled theme owner in CLI graph');
const themeChunk = path.join('dist/bundle/chunks', themeChunks[0]);
// Follow actual launcher createRequire plus static/dynamic import edges; no fixed chunk names.
const reachable = new Set();
function visit(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  const content = text(file);
  for (const match of content.matchAll(/["'](\.\.?\/[^"']+\.js)["']/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (fs.existsSync(target)) visit(target);
  }
}
visit(path.join(options.sdk, 'dist/bundle/cli.js'));
assert.ok(reachable.has(path.join(options.sdk, themeChunk)), 'Real CLI reaches the patched theme owner');
const nativeFiles = [...reachable].filter((file) => /themeWatchCapability:THEME_WATCH_CAPABILITY/.test(text(file)));
assert.ok(nativeFiles.length > 0, 'Real CLI reaches actual NativeUI construction with its own capability');
const types = text(path.join(options.sdk, 'dist/core/extensions/types.d.ts'));
assert.match(types, /readonly themeWatchCapability\?: "pi\.theme-watch\.file-version\.v1"/);
// Official TypeScript maps embed exactly the source compiled into each changed module.
for (const module of ['index', 'core/extensions/types', 'modes/interactive/interactive-mode', 'modes/interactive/theme/theme']) {
  const map = JSON.parse(text(path.join(options.sdk, `dist/${module}.js.map`)));
  assert.ok(map.sourcesContent.includes(text(path.join(options.sdk, `src/${module}.ts`))), `Source/output mismatch: ${module}`);
}
const workspace = path.resolve(options.sdk, '../..');
const buildRoot = path.dirname(workspace);
const receipt = JSON.parse(text(path.join(buildRoot, 'host-patch-build.json')));
const manifest = JSON.parse(text(path.join(here, 'manifest.json')));
assert.equal(receipt.patchSha256, hash(path.join(here, 'source.patch')), 'Build belongs to current source patch');
assert.equal(receipt.builderSha256, hash(path.join(here, 'build.mjs')), 'Build belongs to current builder');
assert.equal(receipt.archiveSha256, manifest.upstream.archiveSha256);
assert.equal(receipt.commit, manifest.upstream.commit);
for (const [file, expected] of Object.entries(receipt.files)) assert.equal(hash(path.join(buildRoot, file)), expected, file);
for (const [name, dir] of [['pi-coding-agent', 'coding-agent'], ['pi-ai', 'ai'], ['pi-tui', 'tui']]) {
  const target = fs.realpathSync(path.join(workspace, 'node_modules/@earendil-works', name));
  assert.equal(target, fs.realpathSync(path.join(workspace, 'packages', dir)), `Mixed peer graph: ${name}`);
  assert.equal(JSON.parse(text(path.join(target, 'package.json'))).version, '1.5.0');
}
const results = ['build-receipt', 'source-maps', 'workspace-peer-graph'];
function environment(dir) {
  for (const name of ['home', 'agent', 'config', 'cache', 'state', 'tmp']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  return {
    PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
    HOME: path.join(dir, 'home'), PI_CODING_AGENT_DIR: path.join(dir, 'agent'),
    XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_STATE_HOME: path.join(dir, 'state'),
    TMPDIR: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TEMP: path.join(dir, 'tmp'),
    PI_OFFLINE: '1', SDK_UNDER_TEST: options.sdk, SDK_THEME_CHUNK: themeChunk,
  };
}
function run(label, command, args, env) {
  const result = spawnSync(command, args, { env, cwd: options.output, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(options.output, `${label}.log`), (result.stdout || '') + (result.stderr || ''));
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${label}: see ${label}.log (signal ${result.signal})`);
  results.push(label);
}
for (const variant of ['public', 'bundle-real', 'unbundled', 'bundle']) {
  const dir = path.join(options.output, variant);
  const test = ['public', 'bundle-real'].includes(variant) ? 'public-check.mjs' : 'internal-check.mjs';
  run(variant, process.execPath, [path.join(here, 'tests', test), variant], environment(dir));
}
const smoke = path.join(options.output, 'smoke');
const env = environment(smoke);
run('root-smoke', process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import { pathToFileURL } from 'node:url';
  const api = await import(pathToFileURL(process.env.SDK_UNDER_TEST + '/dist/index.js'));
  assert.equal(api.THEME_WATCH_CAPABILITY, 'pi.theme-watch.file-version.v1');
  assert.equal(typeof api.createAgentSession, 'function');
  console.log('PASS fresh canonical SDK root capability');
`], env);
run('syntax', process.execPath, ['--check', path.join(options.sdk, 'dist/modes/interactive/theme/theme.js')], env);
run('bundle-syntax', process.execPath, ['--check', path.join(options.sdk, themeChunk)], env);
run('native-smoke', 'python3', [path.join(here, 'tests/native-smoke.py'), options.sdk, smoke], env);
fs.writeFileSync(path.join(options.output, 'result.json'), JSON.stringify({ status: 'PASS', cases: results, themeChunk, cliReachableNativeFiles: nativeFiles.map((file) => path.relative(options.sdk, file)) }, null, 2) + '\n');
console.log(`PASS ${results.join(', ')}`);
