import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listPrompts, loadBindings, promptsForModel, saveBindings } from "../bindings.ts";
import { buildReport, loadModelPrompt } from "../report.ts";

test("unchanged prompt and binding versions reuse reads and JSON parsing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts/brief.md"), "short");
  const raw = JSON.stringify({ brief: ["model-a"] });
  writeFileSync(join(dir, "bindings.json"), raw);
  writeFileSync(join(dir, "model-a.md"), "calibration");
  const read = fs.readFileSync;
  const parse = JSON.parse;
  let reads = 0;
  let parses = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (String(args[0]).startsWith(dir)) reads++;
    return Reflect.apply(read, fs, args);
  });
  t.mock.method(JSON, "parse", (...args: Parameters<typeof parse>) => {
    if (args[0] === raw) parses++;
    return Reflect.apply(parse, JSON, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let i = 0; i < 3; i++) {
    assert.equal(loadModelPrompt(dir, "model-a"), "calibration");
    assert.deepEqual([...promptsForModel(dir, "model-a")], [["prompt:brief", "short"]]);
  }
  assert.equal(reads, 3);
  assert.equal(parses, 1);
  loadBindings(dir).brief!.push("poison");
  assert.deepEqual(loadBindings(dir).brief, ["model-a"]);
  writeFileSync(join(dir, "replacement"), "changed");
  renameSync(join(dir, "replacement"), join(dir, "model-a.md"));
  assert.equal(loadModelPrompt(dir, "model-a"), "changed");
  rmSync(join(dir, "model-a.md"));
  assert.equal(loadModelPrompt(dir, "model-a"), undefined);
});

test("invalid bindings warn once per version and cannot be overwritten", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "bindings.json");
  const raw = '{"private-marker": bad}';
  writeFileSync(path, raw);
  const messages: string[] = [];
  t.mock.method(console, "error", (message: unknown) => messages.push(String(message)));
  for (let i = 0; i < 3; i++) assert.equal(Object.keys(loadBindings(dir)).length, 0);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0]!, /private-marker/);
  assert.throws(() => saveBindings(dir, { brief: ["m"] }), /bindings\.json/);
  assert.equal(readFileSync(path, "utf8"), raw);
  writeFileSync(path, JSON.stringify({ brief: ["m"] }));
  assert.deepEqual(loadBindings(dir).brief, ["m"]);
});

test("canonical no-op saves preserve bytes and special prompt keys round-trip", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-special-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "bindings.json");
  const raw = '{"constructor":["m"],"__proto__":["m"]}';
  writeFileSync(path, raw);
  const bindings = loadBindings(dir);
  assert.deepEqual(Object.keys(bindings).sort(), ["__proto__", "constructor"]);
  assert.equal(Object.getPrototypeOf(bindings), null);
  saveBindings(dir, bindings);
  assert.equal(readFileSync(path, "utf8"), raw);
  rmSync(path);
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts/constructor.md"), "body");
  assert.deepEqual(listPrompts(dir)[0]?.models, []);
});

test("unreadable prompt errors are cached, distinguished from missing files and recover", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-unreadable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "model-a.md");
  mkdirSync(path);
  const messages: string[] = [];
  t.mock.method(console, "error", (message: unknown) => messages.push(String(message)));
  assert.equal(loadModelPrompt(dir, "model-a"), undefined);
  assert.equal(loadModelPrompt(dir, "model-a"), undefined);
  assert.equal(messages.length, 1);
  assert.match(buildReport(dir, "model-a", undefined), /model-a\.md.*EISDIR/);
  rmSync(path, { recursive: true });
  writeFileSync(path, "repaired");
  assert.equal(loadModelPrompt(dir, "model-a"), "repaired");
});

test("prompt links stay live but binding-file links are not replaced", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-links-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "shared.md"), "first");
  symlinkSync("shared.md", join(dir, "model-a.md"));
  assert.equal(loadModelPrompt(dir, "model-a"), "first");
  writeFileSync(join(dir, "shared.md"), "second");
  assert.equal(loadModelPrompt(dir, "model-a"), "second");
  writeFileSync(join(dir, "shared.json"), '{"brief":["m"]}');
  symlinkSync("shared.json", join(dir, "bindings.json"));
  assert.throws(() => saveBindings(dir, { brief: ["new"] }), /symlink/);
  assert.equal(readlinkSync(join(dir, "bindings.json")), "shared.json");
  assert.equal(readFileSync(join(dir, "shared.json"), "utf8"), '{"brief":["m"]}');
});

test("a concurrent edit during temporary-file creation survives a refused save", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-write-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "bindings.json");
  writeFileSync(path, '{"brief":["old"]}');
  const external = '{"another":["external"]}';
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    Reflect.apply(write, fs, args);
    if (String(args[0]).endsWith(".tmp")) write(path, external);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => saveBindings(dir, { brief: ["new"] }), /changed.*reopen/);
  assert.equal(readFileSync(path, "utf8"), external);
  assert.deepEqual(readdirSync(dir), ["bindings.json"]);
});

test("partial invalid entries remain readable but read-only, and blank prompts remain listed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-partial-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts/blank.md"), "  ");
  const path = join(dir, "bindings.json");
  const raw = '{"brief":["m"],"wrong":42}';
  writeFileSync(path, raw);
  assert.deepEqual(loadBindings(dir).brief, ["m"]);
  assert.throws(() => saveBindings(dir, { brief: ["new"] }), /invalid entries/);
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.equal(listPrompts(dir)[0]?.chars, 0);
});

test("failed atomic replacement preserves original bytes and removes temporary files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "bindings.json");
  const raw = '{"brief":["old"]}';
  writeFileSync(path, raw);
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("fixture rename failure"), { code: "EIO" }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => saveBindings(dir, { brief: ["new"] }), /EIO|rename failure/);
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.deepEqual(readdirSync(dir), ["bindings.json"]);
});
