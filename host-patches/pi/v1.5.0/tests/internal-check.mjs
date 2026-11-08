// SDK-internal unit research only. No consumer imports this file or any private SDK path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
assert.ok(process.env.SDK_UNDER_TEST, 'Explicit SDK_UNDER_TEST required');
const sdk = path.resolve(process.env.SDK_UNDER_TEST);
const variant = process.argv[2];
assert.ok(['unbundled', 'bundle'].includes(variant));
const dir = path.join(process.env.PI_CODING_AGENT_DIR, 'themes');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'sdk-check.json');
const second = path.join(dir, 'sdk-second.json');
const base = JSON.parse(fs.readFileSync(path.join(sdk, 'dist/modes/interactive/theme/dark.json'), 'utf8'));
const write = (target, name, accent) => fs.writeFileSync(target, JSON.stringify({ ...base, name, colors: { ...base.colors, accent } }));
write(file, 'sdk-check', '#113355');
write(second, 'sdk-second', '#995511');
const original = { watchFile: fs.watchFile, unwatchFile: fs.unwatchFile, readFileSync: fs.readFileSync, setTimeout, clearTimeout };
const watches = [], removals = [], timers = [];
let reads = 0;
fs.watchFile = (file, options, callback) => {
  assert.deepEqual(options, { interval: 200, persistent: false });
  watches.push({ file, callback });
};
fs.unwatchFile = (file, callback) => {
  assert.equal(typeof callback, 'function', 'must remove only this owner callback');
  removals.push({ file, callback });
};
fs.readFileSync = function (target, ...args) {
  if ([file, second].includes(String(target))) reads++;
  return original.readFileSync.call(this, target, ...args);
};
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms !== 100) return original.setTimeout(callback, ms, ...args);
  const timer = { callback, cancelled: false };
  timers.push(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (timers.includes(timer)) timer.cancelled = true;
  else original.clearTimeout(timer);
};
syncBuiltinESMExports();
const api = await import(pathToFileURL(path.join(sdk, variant === 'bundle' ? process.env.SDK_THEME_CHUNK : 'dist/modes/interactive/theme/theme.js')));
const { initTheme, setTheme, setThemeInstance, setRegisteredThemes, loadThemeFromPath, onThemeChange, stopThemeWatcher, getSelectListTheme } = api;
let notifications = 0;
onThemeChange(() => notifications++);
const color = () => getSelectListTheme().selectedText('palette');
const stat = () => fs.statSync(file);
const event = (owner = watches.at(-1)) => owner.callback({ ...stat(), mtimeMs: stat().mtimeMs + 1 }, stat());
try {
  setRegisteredThemes([loadThemeFromPath(file), loadThemeFromPath(second)]);
  initTheme('sdk-check', true);
  assert.equal(watches.length, 1);
  const owner = watches[0];
  const first = color();
  const beforeReads = reads;
  for (let i = 0; i < 100; i++) assert.equal(setTheme('sdk-check', true).success, true);
  assert.equal(watches.length, 1, 'same actual target must reuse watcher');
  assert.equal(removals.length, 0);
  assert.equal(reads, beforeReads, 'keep original registry cache path');
  assert.equal(notifications, 100, 'same name must still notify full UI invalidation');
  owner.callback(stat(), stat());
  assert.equal(timers.length, 0, 'unchanged metadata does not schedule a read');
  write(file, 'sdk-check', '#cc3311');
  event(owner);
  const pending = timers.at(-1);
  setTheme('sdk-check', true);
  assert.equal(pending.cancelled, false, 'same target must not cancel actual pending update');
  pending.callback();
  assert.notEqual(color(), first);
  assert.equal(reads, beforeReads + 1);
  assert.equal(notifications, 102);
  assert.equal(setTheme('sdk-check', true).success, true);
  assert.equal(color(), loadThemeFromPath(file).fg('accent', 'palette'), 'reload refreshes original registry cache');
  // Different snapshot with the same name must restore the cached named palette, never skip by name.
  const named = color();
  write(file, 'sdk-check', '#00ff00');
  setThemeInstance(loadThemeFromPath(file));
  assert.notEqual(color(), named);
  assert.equal(setTheme('sdk-check', true).success, true);
  assert.equal(color(), named);
  const staleOwner = watches.at(-1);
  event(staleOwner);
  const staleTimer = timers.at(-1);
  setTheme('sdk-second', true);
  assert.equal(staleTimer.cancelled, true);
  setTheme('sdk-check', true);
  const currentOwner = watches.at(-1);
  event(currentOwner);
  const currentTimer = timers.at(-1);
  const count = timers.length;
  const staleReads = reads;
  staleOwner.callback({ ...stat(), ino: stat().ino + 1 }, stat());
  staleTimer.callback(); // Simulate an already queued callback despite cancellation.
  assert.equal(timers.length, count, 'old owner callback cannot schedule after A/B/A switch');
  assert.equal(reads, staleReads, 'stale timer cannot read');
  stopThemeWatcher();
  assert.equal(currentTimer.cancelled, true, 'stale timer must not clear new owner timer');
  currentTimer.callback();
  currentOwner.callback({ ...stat(), size: stat().size + 1 }, stat());
  assert.equal(reads, staleReads, 'stop fences timer and callback');
  assert.equal(timers.length, count);
  assert.ok(removals.every((r) => watches.some((w) => r.file === w.file && r.callback === w.callback)));
  // Same public name under a different runtime agentDir is a different actual target.
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const alternateAgentDir = path.join(originalAgentDir, 'alternate');
  fs.mkdirSync(path.join(alternateAgentDir, 'themes'), { recursive: true });
  write(path.join(alternateAgentDir, 'themes/sdk-check.json'), 'sdk-check', '#aa5511');
  setTheme('sdk-check', true);
  const originalTargetOwner = watches.at(-1);
  const beforeTargetChange = watches.length;
  process.env.PI_CODING_AGENT_DIR = alternateAgentDir;
  setTheme('sdk-check', true);
  assert.equal(watches.length, beforeTargetChange + 1);
  assert.equal(watches.at(-1).file, path.join(alternateAgentDir, 'themes/sdk-check.json'));
  const beforeOldTargetEvent = timers.length;
  event(originalTargetOwner);
  assert.equal(timers.length, beforeOldTargetEvent, 'old actual target is fenced');
  process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  // Switching without enabling another watcher still cancels pending work.
  setTheme('sdk-check', true);
  event();
  const noWatchSwitch = timers.at(-1);
  setTheme('dark', false);
  assert.equal(noWatchSwitch.cancelled, true);
  const beforeMissing = watches.length;
  setTheme('sdk-second', true);
  assert.equal(setTheme('missing-sdk-check', true).success, false);
  assert.equal(watches.length, beforeMissing + 1);
  const beforeBuiltin = watches.length;
  setTheme('dark', true);
  setTheme('light', true);
  setTheme('system', true);
  assert.equal(watches.length, beforeBuiltin, 'built-ins are never watched');
  // An absent agent-dir user file must not start watching a registered package-only source.
  const packageFile = path.join(process.env.PI_CODING_AGENT_DIR, 'package-only.json');
  write(packageFile, 'sdk-package-only', '#5588aa');
  setRegisteredThemes([loadThemeFromPath(packageFile)]);
  setTheme('sdk-package-only', true);
  assert.equal(watches.length, beforeBuiltin, 'do not broaden supported source scope');
  // initTheme fallback must also retire the previous actual owner.
  setRegisteredThemes([loadThemeFromPath(file)]);
  initTheme('sdk-check', true);
  event();
  const invalidInitTimer = timers.at(-1);
  initTheme('missing-sdk-check', true);
  assert.equal(invalidInitTimer.cancelled, true);
  console.log(JSON.stringify({ status: 'PASS', variant, watches: watches.length, removals: removals.length, timers: timers.length, notifications, reads }, null, 2));
} finally {
  stopThemeWatcher();
  fs.watchFile = original.watchFile;
  fs.unwatchFile = original.unwatchFile;
  fs.readFileSync = original.readFileSync;
  globalThis.setTimeout = original.setTimeout;
  globalThis.clearTimeout = original.clearTimeout;
  syncBuiltinESMExports();
}
