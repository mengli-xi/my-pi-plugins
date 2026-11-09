#!/usr/bin/env node
// Three tab-separated rows. CC owns every semantic slot and its interactions.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const reset = '\x1b[0m';
const color = (code, text) => `\x1b[${code}m${text}${reset}`;
const gray = text => color(90, text);
const groups = parts => parts.filter(Boolean).join(gray(' │ '));
const dots = parts => parts.join(gray('·'));
const slot = name => `[[pi:slot:${name}]]`;
const integer = value => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
const has = (value, name) => value != null && Object.hasOwn(value, name);
const width = text => [...text.replace(/\x1b\[[0-9;]*m/g, '')].length;
const abbreviate = value => value >= 1e6 ? `${Number((value / 1e6).toFixed(1))}M`
  : value >= 1e3 ? `${Number((value / 1e3).toFixed(1))}k` : String(value);
function duration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
    : minutes ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}
function emptySummary() {
  return { turns: 0, compacts: 0, input: 0, output: 0, read: 0, write: 0,
    latestInput: 0, latestRead: 0, latestWrite: 0 };
}
function version(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
function validSummary(summary) {
  return summary && Object.keys(emptySummary()).every(key =>
    typeof summary[key] === 'number' && Number.isFinite(summary[key]) && summary[key] >= 0)
    && Object.keys(summary).length === Object.keys(emptySummary()).length;
}
function scanSession(source) {
  const summary = emptySummary();
  for (const line of source.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    const message = entry.message;
    if (entry.type === 'message' && message?.role === 'user') summary.turns++;
    if (entry.type === 'compaction') {
      summary.compacts++;
      summary.latestInput = summary.latestRead = summary.latestWrite = 0;
    }
    const usage = entry.type === 'message' && ['assistant', 'toolResult'].includes(message?.role)
      ? message.usage : ['compaction', 'branch_summary'].includes(entry.type) ? entry.usage : null;
    if (!usage) continue;
    summary.input += integer(usage.input);
    summary.output += integer(usage.output);
    summary.read += integer(usage.cacheRead);
    summary.write += integer(usage.cacheWrite);
    if (entry.type === 'message' && message.role === 'assistant'
      && !['aborted', 'error'].includes(message.stopReason)) {
      summary.latestInput = integer(usage.input);
      summary.latestRead = integer(usage.cacheRead);
      summary.latestWrite = integer(usage.cacheWrite);
    }
  }
  return summary;
}

// Legacy Pi session files supply counters absent from the CC command payload.
// Only pi.session_file is read (never transcript_path, settings, logs or a DB).
// A changed/unavailable/malformed source fails closed; cached data is numeric
// only, keyed by file identity/version, and never used after a version mismatch.
export function readSession(sessionFile, { cacheDir = process.env.PI_CLAUDE_STYLE_STATUSLINE_CACHE_DIR
  || join(tmpdir(), `pi-claude-style-statusline-${process.getuid?.() ?? 'user'}`), io = fs } = {}) {
  if (!sessionFile) return emptySummary();
  let sourceVersion;
  try {
    const stat = io.statSync(sessionFile);
    if (!stat.isFile()) return emptySummary();
    sourceVersion = version(stat);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return emptySummary();
    throw error;
  }
  const cacheFile = join(cacheDir, createHash('sha256').update(resolve(sessionFile)).digest('hex') + '.json');
  let cachedBytes;
  try {
    cachedBytes = io.readFileSync(cacheFile, 'utf8');
    const cached = JSON.parse(cachedBytes);
    if (cached.schema === 1 && cached.version === sourceVersion && validSummary(cached.summary)) {
      return cached.summary;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
  }
  let summary;
  try {
    summary = scanSession(io.readFileSync(sessionFile, 'utf8'));
    if (version(io.statSync(sessionFile)) !== sourceVersion) return summary;
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'EACCES'].includes(error.code)) return emptySummary();
    throw error;
  }
  const bytes = JSON.stringify({ schema: 1, version: sourceVersion, summary });
  if (bytes !== cachedBytes) {
    io.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const temporary = `${cacheFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      io.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
      io.renameSync(temporary, cacheFile);
    } finally {
      try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return summary;
}

export function renderStatusline(payload, options = {}) {
  const summary = readSession(payload.pi?.session_file, options);
  const context = payload.context_window ?? {};
  const current = context.current_usage;
  const total = (key, fallback) => integer(has(context, key) ? context[key] : summary[fallback]);
  // Present null, like zero, is authoritative: compaction must not revive old usage.
  const latest = (key, fallback) => integer(has(context, 'current_usage')
    && (current === null || has(current, key)) ? current?.[key] : summary[fallback]);
  const input = total('total_input_tokens', 'input');
  const output = total('total_output_tokens', 'output');
  const read = total('total_cache_read_tokens', 'read');
  const write = total('total_cache_write_tokens', 'write');
  const used = latest('input_tokens', 'latestInput') + latest('cache_read_input_tokens', 'latestRead')
    + latest('cache_creation_input_tokens', 'latestWrite');
  const windowSize = integer(context.context_window_size);
  const percent = context.used_percentage == null
    ? windowSize > 0 ? Math.round(used / windowSize * 100) : null
    : Math.round(Number(context.used_percentage));
  const started = integer(payload.pi?.session_started_at_ms);
  const refreshed = integer(payload.pi?.refreshed_at_ms);
  const age = started > 0 && refreshed >= started ? refreshed - started : integer(payload.cost?.total_duration_ms);
  const activity = [summary.turns ? color('38;5;31', `#${summary.turns}`) : '',
    summary.compacts ? color(33, `C×${summary.compacts}`) : ''];
  let right = groups([...activity, gray(duration(age))]);
  const cwd = payload.workspace?.current_dir || payload.cwd || process.cwd();
  const home = process.env.HOME;
  const displayPath = home && (cwd === home || cwd.startsWith(home + '/')) ? '~' + cwd.slice(home.length) : cwd;
  const shortPath = basename(displayPath) || displayPath;
  const model = String(payload.model?.id || payload.model?.display_name || 'no-model').replace(/^gpt-/, '');
  const provider = String(payload.model?.provider || '').replace(/^openai-codex$/, 'codex')
    .replace(/-gateway$/, '');
  const effort = payload.effort || payload.effort_level || '';
  const modelStatic = [model + (provider ? `(${provider})` : ''), effort].filter(Boolean).join(' ');
  const terminalWidth = integer(payload.terminal?.width);
  let budget = width(displayPath);
  if (terminalWidth) {
    const available = () => Math.max(0, terminalWidth - width(right) - 1 - width(modelStatic) - 2 - 3);
    budget = available();
    if (width(shortPath) > budget && activity.some(Boolean)) {
      right = gray(duration(age));
      budget = available();
    }
  }
  const pathSlot = budget <= 0 ? '' : width(displayPath) <= budget ? slot('path-full')
    : width(shortPath) <= budget ? slot('path-short') : slot(`path-short@${budget}`);
  const left = groups([pathSlot, ['model', 'effort', 'fast'].map(slot).join(' ')]);
  let occupancy = '';
  if (context.usage_source === 'pending') occupancy = gray('压缩后待更新');
  else if (windowSize > 0) {
    const prefix = context.usage_source === 'estimate' ? '~' : '';
    const ratio = `[${prefix}${abbreviate(used)}/${abbreviate(windowSize)}]`;
    occupancy = percent === null ? gray(ratio)
      : color(percent >= 85 ? 91 : percent >= 70 ? 93 : percent >= 50 ? 96 : 92, `${ratio} ${prefix}${percent}%`);
  }
  const accounting = groups([occupancy, dots([color(32, `↑${abbreviate(input)}`), color(36, `↓${abbreviate(output)}`)]),
    dots([color(32, `R:${abbreviate(read)}`), color(33, `W:${abbreviate(write)}`)])]);
  const todo = integer(payload.pi?.todo?.total) > 0 ? slot('todo') : '';
  return `${left}\t${right}\n${accounting}\t${slot('cache-quality')}\n${todo}\t\n`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(renderStatusline(JSON.parse(fs.readFileSync(0, 'utf8'))));
  } catch (error) {
    console.error(`statusline: ${error.stack || error}`);
    process.exitCode = 1;
  }
}
