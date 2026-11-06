import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createProjectResolver, resolveProject } from "../src/identity.ts";
import { readIndex, scanTopics, TopicWarnings, truncateIndex } from "../src/files.ts";

async function withCountingGit(run: (fixture: { root: string; git: (...args: string[]) => void; calls: () => Promise<number> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-cache-review-"));
  const previousPath = process.env.PATH;
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args: string[]) => { execFileSync(realGit, args, { env, stdio: "pipe" }); };
  const log = join(root, "calls"), bin = join(root, "bin");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    await mkdir(bin); await writeFile(log, "");
    await writeFile(join(bin, "git"), `#!/bin/sh\nprintf g >> ${quote(log)}\nexec ${quote(realGit)} "$@"\n`);
    await chmod(join(bin, "git"), 0o755);
    // Prime the test-only executable before measuring project discovery/cache behavior.
    execFileSync(join(bin, "git"), ["--version"], { stdio: "pipe", timeout: 30000 });
    await writeFile(log, "");
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    await run({ root, git, calls: async () => (await readFile(log, "utf8")).length });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

test("project identity: worktrees share, nested repos/clones/directories separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-identity-"));
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  try {
    const repo = join(root, "repo");
    git("init", repo);
    git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    const linked = join(root, "worktree");
    git("-C", repo, "worktree", "add", "-b", "fixture", linked);
    const nested = join(repo, "nested");
    git("init", nested);
    const clone = join(root, "clone");
    git("clone", repo, clone);
    const submodule = join(repo, "module");
    git("-C", repo, "-c", "protocol.file.allow=always", "submodule", "add", clone, "module");
    const pointer = join(root, "pointer");
    git("init", "--separate-git-dir", join(root, "pointer-admin"), pointer);
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    await mkdir(dirA); await mkdir(dirB);
    const alias = join(root, "alias");
    await symlink(repo, alias);
    const markerAlias = join(root, "marker-alias");
    await mkdir(markerAlias); await symlink(join(repo, ".git"), join(markerAlias, ".git"));
    const resolve = (path: string) => resolveProject(path, join(root, "agent"));
    const [main, worktree, child, independent, a, b, canonicalAlias, module, separate, symlinkMarker] = await Promise.all([repo, linked, nested, clone, dirA, dirB, alias, submodule, pointer, markerAlias].map(resolve));
    for (const item of [main, worktree, child, independent, a, b, canonicalAlias, module, separate, symlinkMarker]) assert.equal(item.available, true);
    assert.deepEqual(main, worktree);
    assert.deepEqual(main, canonicalAlias);
    assert.deepEqual(main, symlinkMarker);
    assert.equal(main.available && main.identity, `git:${await realpath(join(repo, ".git"))}`);
    const identities = [main, child, independent, a, b, module, separate].map((item) => item.available && item.identity);
    assert.equal(new Set(identities).size, 7);
    assert.equal(module.available && module.identity, `git:${await realpath(join(repo, ".git/modules/module"))}`);
    assert.equal(separate.available && separate.identity, `git:${await realpath(join(root, "pointer-admin"))}`);
    assert.ok(a.available && a.identity === `dir:${await realpath(dirA)}`);
    assert.match(main.available ? main.memoryDir : "", /pi-cc-memory\/projects\/[a-f0-9]{64}\/memory$/);
    const gone = await resolve(join(root, "missing"));
    assert.equal(gone.available, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identity cache skips Git only while cwd, nearest marker and common directory stay unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-cache-"));
  const previousPath = process.env.PATH;
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const git = (...args: string[]) => execFileSync(realGit, args, { stdio: "pipe" });
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const log = join(root, "calls"), bin = join(root, "bin"), agent = join(root, "agent");
  const calls = async () => (await readFile(log, "utf8")).length;
  try {
    await mkdir(bin); await writeFile(log, "");
    await writeFile(join(bin, "git"), `#!/bin/sh\nprintf g >> ${quote(log)}\nexec ${quote(realGit)} "$@"\n`);
    await chmod(join(bin, "git"), 0o755);
    // Prime the test-only executable before measuring project discovery/cache behavior.
    execFileSync(join(bin, "git"), ["--version"], { stdio: "pipe", timeout: 30000 });
    await writeFile(log, "");
    const outer = join(root, "outer"), inner = join(outer, "inner"), cwd = join(inner, "cwd"), other = join(root, "other");
    git("init", outer); git("init", other); await mkdir(cwd, { recursive: true });
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    const resolve = createProjectResolver();
    const initial = await resolve(cwd, agent);
    assert.ok(initial.available && initial.identity.startsWith("git:"), JSON.stringify(initial));
    assert.equal(await calls(), 2);
    assert.deepEqual(await resolve(cwd, agent), initial); assert.equal(await calls(), 2, "stable fingerprint does not start Git");
    const alias = join(root, "alias"); await symlink(cwd, alias);
    assert.deepEqual(await resolve(alias, agent), initial); assert.equal(await calls(), 2, "canonical cwd aliases share the cache");

    git("init", inner);
    const nested = await resolve(cwd, agent);
    assert.ok(nested.available && nested.identity !== initial.identity); assert.equal(await calls(), 4, "new inner marker re-runs discovery");
    await rm(join(inner, ".git"), { recursive: true });
    assert.deepEqual(await resolve(cwd, agent), initial); assert.equal(await calls(), 6, "deleted marker re-runs discovery");
    const changedCwd = await resolve(other, agent);
    assert.ok(changedCwd.available && changedCwd.identity !== initial.identity); assert.equal(await calls(), 8, "different cwd re-runs discovery");
    assert.deepEqual(await resolve(cwd, agent), initial); assert.equal(await calls(), 10, "cache retains only the last cwd");

    // Replacing a gitfile or rewriting it must not retain its previous target.
    await writeFile(join(inner, ".git"), `gitdir: ${join(other, ".git")}\n`);
    assert.deepEqual(await resolve(cwd, agent), changedCwd); assert.equal(await calls(), 12);
    await writeFile(join(inner, ".git"), `gitdir: ${join(outer, ".git")}\n`);
    assert.deepEqual(await resolve(cwd, agent), initial); assert.equal(await calls(), 14);
    await rm(join(inner, ".git")); await symlink(join(other, ".git"), join(inner, ".git"));
    assert.deepEqual(await resolve(cwd, agent), changedCwd); assert.equal(await calls(), 16);
    const savedCommon = join(other, "saved-git");
    await rename(join(other, ".git"), savedCommon); git("init", other);
    assert.deepEqual(await resolve(cwd, agent), changedCwd); assert.equal(await calls(), 18, "same common-dir path with a new inode re-runs discovery");
    await rm(join(other, ".git"), { recursive: true });
    assert.equal((await resolve(cwd, agent)).available, false);
    const failedCalls = await calls();
    assert.equal((await resolve(cwd, agent)).available, false); assert.ok(await calls() > failedCalls, "failed identities are never cached");
    await rename(savedCommon, join(other, ".git"));
    assert.deepEqual(await resolve(cwd, agent), changedCwd);
    await rm(join(other, ".git/HEAD"));
    assert.deepEqual(await resolve(cwd, agent), changedCwd, "HEAD damage does not change a cached project identity");
    assert.equal((await resolveProject(cwd, agent)).available, false, "full discovery still rejects damaged markers");
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("identity cache follows commondir symlinks and their current contents", async () => {
  await withCountingGit(async ({ root, git, calls }) => {
    const a = join(root, "a"), b = join(root, "b"), cwd = join(root, "checkout"), admin = join(root, "admin");
    git("init", a); git("init", b); await mkdir(cwd); await mkdir(admin);
    await writeFile(join(cwd, ".git"), `gitdir: ${admin}\n`);
    await writeFile(join(admin, "HEAD"), "ref: refs/heads/fixture\n");
    const pointer = join(root, "pointer");
    await writeFile(pointer, join(a, ".git") + "\n"); await symlink(pointer, join(admin, "commondir"));
    const resolve = createProjectResolver(), agent = join(root, "agent");
    const first = await resolve(cwd, agent);
    assert.ok(first.available && first.identity === `git:${await realpath(join(a, ".git"))}`);
    const warm = await calls(); assert.deepEqual(await resolve(cwd, agent), first); assert.equal(await calls(), warm);
    await writeFile(pointer, join(b, ".git") + "\n");
    const second = await resolve(cwd, agent);
    assert.deepEqual(second, await resolveProject(cwd, agent));
    assert.ok(second.available && second.identity === `git:${await realpath(join(b, ".git"))}`);
    assert.equal(await calls(), warm + 4, "changed pointer and fresh reference each run full discovery");
    const rewritten = await calls(); assert.deepEqual(await resolve(cwd, agent), second); assert.equal(await calls(), rewritten);
    await rm(pointer);
    assert.deepEqual(await resolve(cwd, agent), await resolveProject(cwd, agent), "unreadable pointer uses full discovery");
    assert.ok(await calls() > rewritten);
  });
});

test("unmarked paths are not cached when the cwd or a parent becomes a bare repository", async () => {
  await withCountingGit(async ({ root, git, calls }) => {
    for (const parent of [false, true]) {
      const repo = join(root, parent ? "parent-bare" : "cwd-bare"), cwd = parent ? join(repo, "child") : repo;
      await mkdir(cwd, { recursive: true });
      const resolve = createProjectResolver(), agent = join(root, "agent");
      const plain = await resolve(cwd, agent); assert.ok(plain.available && plain.identity.startsWith("dir:"));
      const initialCalls = await calls(); assert.deepEqual(await resolve(cwd, agent), plain);
      assert.ok(await calls() > initialCalls, "unmarked directory results are not cached");
      git("init", "--bare", repo);
      const bare = await resolve(cwd, agent);
      assert.deepEqual(bare, await resolveProject(cwd, agent));
      assert.ok(bare.available && bare.identity === `git:${await realpath(repo)}`);
      const bareCalls = await calls(); assert.deepEqual(await resolve(cwd, agent), bare);
      assert.ok(await calls() > bareCalls, "unmarked bare results are not cached either");
      await writeFile(join(repo, "HEAD"), "invalid head\n");
      assert.deepEqual(await resolve(cwd, agent), await resolveProject(cwd, agent));
    }
  });
});

test("main and linked checkouts retain cache hits after ordinary Git operations", async () => {
  await withCountingGit(async ({ root, git, calls }) => {
    const main = join(root, "main"), linked = join(root, "linked");
    git("init", main); await writeFile(join(main, "a"), "initial");
    git("-C", main, "add", "a"); git("-C", main, "commit", "-qm", "initial");
    git("-C", main, "worktree", "add", "-qb", "linked", linked);
    for (const [kind, cwd] of [["main", main], ["linked", linked]] as const) {
      const resolve = createProjectResolver(), agent = join(root, "agent");
      const project = await resolve(cwd, agent); assert.ok(project.available);
      const warmCalls = await calls();
      for (const operation of ["status", "add", "edit-add", "commit", "checkout"] as const) {
        for (let i = 0; i < 10; i++) {
          if (operation === "status") git("-C", cwd, "status", "--porcelain");
          if (operation === "edit-add" || operation === "commit") await writeFile(join(cwd, "a"), `${kind}-${operation}-${i}`);
          if (["add", "edit-add", "commit"].includes(operation)) git("-C", cwd, "add", "a");
          if (operation === "commit") git("-C", cwd, "commit", "-qm", `fixture ${i}`);
          if (operation === "checkout") git("-C", cwd, "checkout", "-qB", `fixture-${kind}-${i}`);
          assert.deepEqual(await resolve(cwd, agent), project);
          assert.equal(await calls(), warmCalls, `${kind}/${operation}/${i} must not start Git`);
        }
      }
    }
  });
});

test("a possible bare boundary inside an outer checkout disables its cached identity", async () => {
  await withCountingGit(async ({ root, git, calls }) => {
    const outer = join(root, "outer"); git("init", outer);
    for (const parent of [false, true]) {
      const bareDir = join(outer, parent ? "parent-bare" : "cwd-bare"), cwd = parent ? join(bareDir, "child") : bareDir;
      await mkdir(cwd, { recursive: true });
      const resolve = createProjectResolver(), agent = join(root, "agent");
      const before = await resolve(cwd, agent);
      assert.ok(before.available && before.identity === `git:${await realpath(join(outer, ".git"))}`);
      const warm = await calls(); assert.deepEqual(await resolve(cwd, agent), before); assert.equal(await calls(), warm);
      git("init", "--bare", bareDir);
      const bare = await resolve(cwd, agent);
      assert.deepEqual(bare, await resolveProject(cwd, agent));
      assert.ok(bare.available && bare.identity === `git:${await realpath(bareDir)}`);
      const fresh = await calls(); assert.deepEqual(await resolve(cwd, agent), bare);
      assert.ok(await calls() > fresh, "HEAD on the discovery path conservatively disables caching");
    }
  });
});

test("real Git discovery ignores repository/config environment overrides from another project", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-git-env-"));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", args, { env: cleanEnv, stdio: "pipe" });
  const a = join(root, "a"), b = join(root, "b"), subdir = join(b, "subdir");
  const overrides = [
    { GIT_DIR: join(a, ".git") },
    { GIT_COMMON_DIR: join(a, ".git") },
    { GIT_WORK_TREE: a },
    { GIT_CEILING_DIRECTORIES: b },
    { GIT_DIR: join(a, ".git"), GIT_COMMON_DIR: join(a, ".git"), GIT_WORK_TREE: a, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" },
  ];
  const keys = [...new Set(overrides.flatMap((override) => Object.keys(override)))];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const restore = () => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } };
  try {
    git("init", a); git("init", b); await mkdir(subdir);
    const expected = `git:${await realpath(join(b, ".git"))}`;
    for (const override of overrides) {
      Object.assign(process.env, override);
      const project = await resolveProject(subdir, join(root, "agent"));
      assert.ok(project.available, JSON.stringify(project));
      assert.equal(project.identity, expected, JSON.stringify(override));
      restore();
    }
  } finally { restore(); await rm(root, { recursive: true, force: true }); }
});

test("real Git rejects damaged standalone and nested markers instead of falling back or inheriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-git-damaged-"));
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe", encoding: "utf8" });
  try {
    const standalone = join(root, "standalone"), outer = join(root, "outer"), nested = join(outer, "nested");
    git("init", standalone); git("init", outer); git("init", nested);
    await rm(join(standalone, ".git/HEAD")); await rm(join(nested, ".git/HEAD"));
    // Git really skips the damaged nested boundary; the extension must reject its successful result.
    assert.equal(await realpath(git("-C", nested, "rev-parse", "--path-format=absolute", "--git-common-dir").trim()), await realpath(join(outer, ".git")));
    for (const cwd of [standalone, nested]) {
      const subdir = join(cwd, "subdir"); await mkdir(subdir);
      for (const path of [cwd, subdir]) {
        const project = await resolveProject(path, join(root, "agent"));
        assert.equal(project.available, false, JSON.stringify(project));
        assert.equal("memoryDir" in project, false);
        assert.match(project.warning ?? "", /暂不注入/);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Git failures fail closed; missing Git uses directory with warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-git-error-"));
  const previousPath = process.env.PATH;
  const resolve = createProjectResolver();
  try {
    const binary = join(root, "git");
    await writeFile(binary, "#!/bin/sh\necho 'fatal: permission denied' >&2\nexit 128\n");
    await chmod(binary, 0o755);
    process.env.PATH = root;
    const failed = await resolve(root, root);
    assert.equal(failed.available, false);
    assert.match(failed.warning ?? "", /暂不注入/);
    // Even a successful git command cannot turn a vanished common-dir into a directory project.
    await writeFile(binary, `#!/bin/sh\necho '${join(root, "vanished")}'\n`);
    assert.equal((await resolve(root, root)).available, false);
    await rm(binary);
    const missing = await resolve(root, root);
    assert.ok(missing.available && missing.identity.startsWith("dir:"));
    assert.match(missing.warning ?? "", /Git 不可用/);
    await writeFile(binary, "#!/bin/sh\necho 'fatal: permission denied' >&2\nexit 128\n"); await chmod(binary, 0o755);
    assert.equal((await resolve(root, root)).available, false, "missing Git is retried even when PATH stays the same");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("index keeps at most 200 lines, with and without trailing newline", () => {
  for (const suffix of ["", "\n"]) {
    const input = Array.from({ length: 201 }, (_, i) => `line-${i + 1}`).join("\n") + suffix;
    const result = truncateIndex(Buffer.from(input));
    assert.equal(result.totalLines, 201);
    assert.equal(result.shownLines, 200);
    assert.equal(result.content, input.slice(0, input.indexOf("line-201")));
    assert.equal(result.truncated, true);
    assert.equal(result.partialLine, false);
  }
  assert.equal(truncateIndex(Buffer.from("x\n".repeat(200))).truncated, false);
  assert.equal(truncateIndex(Buffer.alloc(0)).totalLines, 0);
});

test("index byte cap prefers complete lines and preserves UTF-8 on oversized first line", () => {
  const complete = "中".repeat(4000) + "\n";
  const result = truncateIndex(Buffer.from(complete + "😀".repeat(4000)));
  assert.equal(result.content, complete);
  assert.equal(result.partialLine, false);
  for (const input of ["a".repeat(25001), "中".repeat(9000), "a" + "😀".repeat(7000)]) {
    const view = truncateIndex(Buffer.from(input));
    assert.ok(view.shownBytes <= 25000);
    assert.equal(view.shownBytes, Buffer.byteLength(view.content));
    assert.equal(view.content.includes("�"), false);
    assert.equal(view.partialLine, true);
    assert.equal(view.truncated, true);
  }
  const exact = truncateIndex(Buffer.from("a".repeat(25000)));
  assert.equal(exact.truncated, false);
  assert.equal(exact.shownBytes, 25000);
});

test("index reads current disk, reports missing/unavailable and never modifies file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-index-"));
  const path = join(root, "MEMORY.md");
  try {
    assert.match((await readIndex(root)).section, /No index yet/);
    const input = Buffer.from("long\n".repeat(201));
    await writeFile(path, input);
    const view = await readIndex(root);
    assert.match(view.section, /201 lines/);
    assert.match(view.warning ?? "", /截断/);
    assert.deepEqual(await readFile(path), input);
    await writeFile(path, "CURRENT DISK");
    assert.match((await readIndex(root)).section, /CURRENT DISK/);
    await rm(path); await mkdir(path);
    assert.match((await readIndex(root)).section, /unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("12 KiB scan excludes index/nested/non-Markdown, deduplicates size and mtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-topics-"));
  try {
    await writeFile(join(root, "MEMORY.md"), Buffer.alloc(13000));
    await writeFile(join(root, "exact.md"), Buffer.alloc(12288));
    await writeFile(join(root, "large.md"), Buffer.alloc(12289));
    await writeFile(join(root, "ignored.txt"), Buffer.alloc(13000));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "ignored.md"), Buffer.alloc(13000));
    const warnings = new TopicWarnings();
    const oversizedTopics = async (dir: string) => (await scanTopics(dir)).oversized;
    assert.equal((await scanTopics(root)).count, 2, "exact.md and large.md are topics; the index, nested and non-Markdown files are not");
    const topics = await oversizedTopics(root);
    assert.deepEqual(topics.map((topic) => topic.name), ["large.md"]);
    assert.equal(warnings.fresh(topics).length, 1);
    assert.equal(warnings.fresh(await oversizedTopics(root)).length, 0);
    await utimes(join(root, "large.md"), new Date(1000), new Date(1000));
    assert.equal(warnings.fresh(await oversizedTopics(root)).length, 1);
    assert.equal(warnings.fresh(await oversizedTopics(root)).length, 0);
    await writeFile(join(root, "large.md"), Buffer.alloc(13000));
    assert.equal(warnings.fresh(await oversizedTopics(root)).length, 1);
    assert.equal(warnings.fresh(topics).length, 0, "an already seen size/mtime stays deduplicated after another revision");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unchanged Git pointer text is reused and same-content rewrites are version checked", async (t) => {
  await withCountingGit(async ({ root, git, calls }) => {
    const main = join(root, "main"), linked = join(root, "linked");
    git("init", main); git("-C", main, "commit", "--allow-empty", "-qm", "fixture");
    git("-C", main, "worktree", "add", "-qb", "linked", linked);
    const pointer = await realpath(join(linked, ".git"));
    const original = await readFile(pointer, "utf8");
    let reads = 0;
    const read = fs.readFile;
    t.mock.method(fs, "readFile", (...args: any[]) => {
      if (String(args[0]).endsWith("/.git") || String(args[0]).endsWith("/commondir")) reads++;
      return Reflect.apply(read, fs, args);
    });
    syncBuiltinESMExports();
    try {
      const resolve = createProjectResolver(), agent = join(root, "agent");
      const first = await resolve(linked, agent);
      assert.ok(first.available);
      const coldReads = reads, coldGit = await calls();
      assert.ok(coldReads >= 2);
      for (let index = 0; index < 3; index++) assert.deepEqual(await resolve(linked, agent), first);
      assert.equal(reads, coldReads, "unchanged versions must not reread gitfile/commondir");
      await writeFile(pointer, original);
      assert.deepEqual(await resolve(linked, agent), first);
      assert.equal(reads, coldReads + 1, "ctime/mtime change rechecks the pointer even with identical bytes");
      assert.equal(await calls(), coldGit, "identical pointer contents do not change project identity");
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  });
});
