#!/usr/bin/env node
// All writes and dependency installation stay beneath the explicit output directory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--install-deps') options.install = true;
  else {
    assert.ok(['--archive', '--model-data', '--output'].includes(args[i]), `Unknown option: ${args[i]}`);
    options[args[i].slice(2)] = path.resolve(args[++i]);
  }
}
for (const key of ['archive', 'model-data', 'output']) assert.ok(options[key], `Required: --${key}`);
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(digest(options.archive), manifest.upstream.archiveSha256, 'Upstream archive hash');
assert.equal(digest(options['model-data']), manifest.modelData.sha256, 'Model data archive hash');
const patchHash = digest(path.join(here, 'source.patch'));
const builderHash = digest(fileURLToPath(import.meta.url));
const receipt = path.join(options.output, 'host-patch-build.json');
if (fs.existsSync(options.output)) {
  assert.ok(fs.existsSync(receipt), 'Output exists without completed receipt; choose a new output directory');
  const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(previous.patchSha256, patchHash, 'Existing output uses another patch; choose a new output');
  assert.equal(previous.builderSha256, builderHash, 'Existing output uses another builder; choose a new output');
  assert.equal(previous.archiveSha256, manifest.upstream.archiveSha256);
  assert.equal(previous.modelDataSha256, manifest.modelData.sha256);
  for (const [file, hash] of Object.entries(previous.files)) assert.equal(digest(path.join(options.output, file)), hash, file);
  console.log(`Already matches ${manifest.buildId}; no files rewritten`);
  process.exit(0);
}
assert.ok(options.install, 'Fresh build requires explicit --install-deps consent (npm ci --ignore-scripts, public registry)');
fs.mkdirSync(options.output, { recursive: true });
const isolation = path.join(options.output, 'isolation');
for (const dir of ['home', 'agent', 'config', 'cache', 'state', 'tmp']) fs.mkdirSync(path.join(isolation, dir), { recursive: true });
for (const file of ['user.npmrc', 'global.npmrc']) fs.writeFileSync(path.join(isolation, file), '');
const env = {
  PATH: process.env.PATH,
  HOME: path.join(isolation, 'home'),
  PI_CODING_AGENT_DIR: path.join(isolation, 'agent'),
  XDG_CONFIG_HOME: path.join(isolation, 'config'),
  XDG_CACHE_HOME: path.join(isolation, 'cache'),
  XDG_STATE_HOME: path.join(isolation, 'state'),
  TMPDIR: path.join(isolation, 'tmp'), TMP: path.join(isolation, 'tmp'), TEMP: path.join(isolation, 'tmp'),
  npm_config_userconfig: path.join(isolation, 'user.npmrc'),
  npm_config_globalconfig: path.join(isolation, 'global.npmrc'),
  npm_config_cache: path.join(isolation, 'cache/npm'),
  npm_config_registry: 'https://registry.npmjs.org',
  npm_config_audit: 'false', npm_config_fund: 'false',
  PI_OFFLINE: '1',
};
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed (signal ${result.signal})`);
}
const source = path.join(options.output, 'source');
fs.mkdirSync(source);
run('tar', ['-xzf', options.archive, '--strip-components=1', '-C', source], options.output);
for (const [file, hash] of Object.entries(manifest.upstream.files)) assert.equal(digest(path.join(source, file)), hash, file);
assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'packages/coding-agent/package.json'))).version, manifest.upstream.version);
run('patch', ['-p1', '--batch', '--forward', '--fuzz=0', '-i', path.join(here, 'source.patch')], source);
const model = path.join(options.output, 'model-data');
fs.mkdirSync(model);
run('tar', ['-xzf', options['model-data'], '-C', model], options.output);
assert.equal(JSON.parse(fs.readFileSync(path.join(model, 'package/package.json'))).version, manifest.upstream.version);
fs.cpSync(path.join(model, 'package/dist/providers/data'), path.join(source, 'packages/ai/src/providers/data'), { recursive: true });
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], source);
// Official workspace order, TypeScript declaration emit, assets and full esbuild CLI bundle.
run('npm', ['run', 'build:offline'], source);
const files = {};
function inventory(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') inventory(file);
    else if (entry.isFile()) files[path.relative(options.output, file)] = digest(file);
  }
}
// Include unchanged source too: reuse must reject source drift, not only dist drift.
inventory(source);
fs.writeFileSync(receipt, JSON.stringify({
  buildId: manifest.buildId, upstreamVersion: manifest.upstream.version,
  commit: manifest.upstream.commit, archiveSha256: manifest.upstream.archiveSha256,
  modelDataSha256: manifest.modelData.sha256, patchSha256: patchHash, builderSha256: builderHash,
  node: process.version, npm: spawnSync('npm', ['--version'], { env, encoding: 'utf8' }).stdout.trim(),
  sdk: 'source/packages/coding-agent', cli: 'source/packages/coding-agent/dist/bundle/cli.js',
  graph: 'Keep the complete source workspace/node_modules graph together; never replace coding-agent alone.',
  files,
}, null, 2) + '\n');
console.log(`Built ${manifest.buildId}; SDK: ${path.join(source, 'packages/coding-agent')}`);
