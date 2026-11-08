import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.ok(process.env.SDK_UNDER_TEST, 'Explicit SDK_UNDER_TEST required');
const sdk = path.resolve(process.env.SDK_UNDER_TEST);
const dir = path.join(process.env.PI_CODING_AGENT_DIR, 'themes');
fs.mkdirSync(dir, { recursive: true });
const base = JSON.parse(fs.readFileSync(path.join(sdk, 'dist/modes/interactive/theme/dark.json'), 'utf8'));
const file = path.join(dir, 'sdk-check.json');
const document = (accent) => JSON.stringify({ ...base, name: 'sdk-check', colors: { ...base.colors, accent } });
let reads = 0;
const read = fs.readFileSync;
fs.readFileSync = function (target, ...args) {
  if (String(target) === file) reads++;
  return read.call(this, target, ...args);
};
syncBuiltinESMExports();
const bundleResearch = process.argv[2] === 'bundle-real';
// The normal case imports only public root APIs. The extra case exercises the same APIs inside
// the CLI chunk as SDK-internal research, never as a consumer dependency.
const entry = bundleResearch ? process.env.SDK_THEME_CHUNK : 'dist/index.js';
const { initTheme, getSelectListTheme } = await import(pathToFileURL(path.join(sdk, entry)));
const color = () => getSelectListTheme().selectedText('palette');
const results = [];
async function waitForChange(previous, label) {
  const start = performance.now();
  while (color() === previous && performance.now() - start < 3000) await delay(10);
  assert.notEqual(color(), previous, label);
  results.push({ label, latencyMs: Math.round(performance.now() - start) });
}
try {
  fs.writeFileSync(file, document('#113355'));
  initTheme('sdk-check', true);
  const first = color();
  await delay(650);
  const initialReads = reads;
  await delay(650);
  assert.equal(reads, initialReads, 'unchanged polling must not read/parse');
  // Every explicit init still loads through the original path, even at the same public name.
  initTheme('sdk-check', true);
  assert.equal(color(), first);
  assert.equal(reads, initialReads + 1);
  fs.writeFileSync(file, document('#cc3311'));
  await waitForChange(first, 'in-place write');
  let previous = color();
  fs.writeFileSync(file + '.tmp', document('#1199cc'));
  fs.renameSync(file + '.tmp', file);
  await waitForChange(previous, 'atomic rename');
  previous = color();
  fs.writeFileSync(file, '{invalid JSON');
  await delay(650);
  assert.equal(color(), previous, 'bad JSON preserves last valid palette');
  const invalidReads = reads;
  await delay(650);
  assert.equal(reads, invalidReads, 'unchanged bad JSON is not repeatedly parsed');
  fs.writeFileSync(file, document('#aa22dd'));
  await waitForChange(previous, 'bad JSON recovery');
  previous = color();
  fs.unlinkSync(file);
  await delay(650);
  assert.equal(color(), previous, 'deletion preserves last valid palette');
  initTheme('sdk-check', true);
  assert.equal(color(), previous, 'same target stays valid while file is absent');
  fs.writeFileSync(file, document('#55dd11'));
  await waitForChange(previous, 'delete + recreate');
  previous = color();
  // A user-theme symlink keeps its lexical path; stat polling follows the replaced target.
  const target = path.join(dir, 'palette-target.json');
  fs.writeFileSync(target, document('#3311bb'));
  fs.unlinkSync(file);
  fs.symlinkSync(target, file);
  await waitForChange(previous, 'symlink replacement');
  previous = color();
  fs.writeFileSync(target + '.tmp', document('#bb9911'));
  fs.renameSync(target + '.tmp', target);
  await waitForChange(previous, 'symlink target atomic rename');
  initTheme('dark', true);
  const dark = color();
  fs.writeFileSync(file, document('#ffffff'));
  await delay(650);
  assert.equal(color(), dark, 'switch to built-in cancels watching');
  console.log(JSON.stringify({ status: 'PASS', api: bundleResearch ? 'CLI bundle internal research: initTheme/getSelectListTheme' : 'public root initTheme/getSelectListTheme', reads, results }, null, 2));
} finally {
  initTheme('dark', true);
  fs.readFileSync = read;
  syncBuiltinESMExports();
}
