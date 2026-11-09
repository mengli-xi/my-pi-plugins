import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createSkillAutocompleteProvider, DraftSkillBindings } from "../autocomplete.ts";
import {
  discoverRuntimeSkillRefs,
  findSkillMentions,
  loadSkill,
  parseSkillCommandInvocation,
  renderSkillInstructions,
  resolveSkillMentions,
  type SkillRef,
} from "../skills.ts";

const skills: SkillRef[] = [
  { name: "one", path: "/user/one/SKILL.md", scope: "user" },
  { name: "plugin:deploy", path: "/project/deploy/SKILL.md", scope: "project" },
];

test("runtime discovery scans user skills and only trusted project skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-discovery-"));
  try {
    const agentSkill = join(root, "agent", "skills", "hot-user", "SKILL.md");
    const agentsSkill = join(root, "home", ".agents", "skills", "hot-agents", "SKILL.md");
    const projectSkill = join(root, "repo", "child", ".pi", "skills", "hot-project", "SKILL.md");
    const ancestorSkill = join(root, "repo", ".agents", "skills", "hot-ancestor", "SKILL.md");
    await mkdir(join(root, "repo", "child"), { recursive: true });
    await mkdir(join(root, "repo", ".git"), { recursive: true });
    for (const path of [agentSkill, agentsSkill, projectSkill, ancestorSkill]) {
      await mkdir(dirname(path), { recursive: true });
    }
    await writeFile(agentSkill, "---\nname: hot-user\ndescription: User hot skill\n---\n", "utf8");
    await writeFile(agentsSkill, "---\nname: hot-agents\ndescription: Agents hot skill\n---\n", "utf8");
    await writeFile(projectSkill, "---\nname: hot-project\ndescription: Project hot skill\n---\n", "utf8");
    await writeFile(ancestorSkill, "---\nname: hot-ancestor\ndescription: Ancestor hot skill\n---\n", "utf8");

    assert.deepEqual(
      discoverRuntimeSkillRefs({
        cwd: join(root, "repo", "child"),
        agentDir: join(root, "agent"),
        home: join(root, "home"),
        projectTrusted: false,
      }).map((skill) => skill.name),
      ["hot-agents", "hot-user"],
    );
    assert.deepEqual(
      discoverRuntimeSkillRefs({
        cwd: join(root, "repo", "child"),
        agentDir: join(root, "agent"),
        home: join(root, "home"),
        projectTrusted: true,
      }).map((skill) => skill.name),
      ["hot-ancestor", "hot-project", "hot-agents", "hot-user"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function countedDiscovery(id: string) {
  const skillsUrl = new URL(`../skills.ts?discovery-test=${id}`, import.meta.url).href;
  const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const wrapperUrl = `data:text/javascript,${encodeURIComponent(`
    // ${id}: wrap this fresh skills module's import, never mutate the SDK or fs.
    import { getAgentDir, loadSkillsFromDir as load } from ${JSON.stringify(sdkUrl)};
    export { getAgentDir };
    export const calls = [];
    export function loadSkillsFromDir(options) {
      calls.push(options);
      return load(options);
    }
  `)}`;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === skillsUrl && specifier === "@earendil-works/pi-coding-agent") {
        return { url: wrapperUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const discovery = await import(skillsUrl) as typeof import("../skills.ts");
    const { calls } = await import(wrapperUrl) as { calls: { dir: string; source: string }[] };
    return { discover: discovery.discoverRuntimeSkillRefs, calls };
  } finally {
    hook.deregister();
  }
}

async function writeSkill(path: string, name: string, description = "Hot skill"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
}

test("completion reuses unchanged official catalogs but refreshes both repeated and different prefixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-cache-"));
  const { discover, calls } = await countedDiscovery("prefixes");
  const options = { cwd: join(root, "repo"), agentDir: join(root, "agent"), home: join(root, "home"), projectTrusted: false };
  const fallback = {
    getSuggestions: async () => null,
    applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
  };
  const provider = createSkillAutocompleteProvider(fallback, () => discover(options), new DraftSkillBindings());
  const suggest = (prefix: string) => provider.getSuggestions([prefix], 0, prefix.length, {} as never);
  try {
    const path = join(options.agentDir, "skills", "hot-first", "SKILL.md");
    await writeSkill(path, "hot-first", "Initial description");
    assert.deepEqual((await suggest("$hot"))?.items.map((item) => item.label), ["hot-first"]);
    const initialCalls = calls.length;
    assert.equal(initialCalls, 2);
    for (const prefix of ["$hot", "$h", "$", "$unknown", "$hot"]) await suggest(prefix);
    assert.equal(calls.length, initialCalls, "unchanged prefixes do not invoke the loader or reread SKILL.md");

    await writeSkill(path, "hot-first", "Updated description for the same prefix");
    assert.match((await suggest("$hot"))?.items[0].description ?? "", /Updated description/);
    assert.equal(calls.length, initialCalls + 1);
    await writeSkill(path, "warm-first", "Renamed while using a different prefix");
    assert.deepEqual((await suggest("$warm"))?.items.map((item) => item.label), ["warm-first"]);
    assert.equal(calls.length, initialCalls + 2);

    const added = join(options.agentDir, "skills", "warm-added", "SKILL.md");
    await writeSkill(added, "warm-added");
    assert.deepEqual((await suggest("$warm"))?.items.map((item) => item.label).sort(), ["warm-added", "warm-first"]);
    await rm(added);
    assert.deepEqual((await suggest("$warm"))?.items.map((item) => item.label), ["warm-first"]);
    const updatedCalls = calls.length;
    await suggest("$warm");
    assert.equal(calls.length, updatedCalls);

    const project = join(options.cwd, ".pi", "skills", "project-only", "SKILL.md");
    await mkdir(join(options.cwd, ".git"), { recursive: true });
    await writeSkill(project, "project-only");
    assert.equal(discover(options).some((skill) => skill.name === "project-only"), false);
    assert.equal(calls.some((call) => call.source === "project"), false);
    assert.equal(discover({ ...options, projectTrusted: true }).some((skill) => skill.name === "project-only"), true);
    const trustedCalls = calls.length;
    await writeSkill(project, "project-changed");
    assert.equal(discover(options).some((skill) => skill.scope === "project"), false);
    assert.equal(calls.length, trustedCalls, "untrusted discovery does not inspect or reload cached project roots");
    assert.equal(discover({ ...options, projectTrusted: true }).some((skill) => skill.name === "project-changed"), true);

    const alternate = { ...options, agentDir: join(root, "alternate-agent"), home: join(root, "alternate-home") };
    await writeSkill(join(alternate.agentDir, "skills", "alternate", "SKILL.md"), "alternate");
    await writeSkill(join(alternate.home, ".agents", "skills", "alternate-home", "SKILL.md"), "alternate-home");
    assert.deepEqual(discover(alternate).map((skill) => skill.name), ["alternate", "alternate-home"]);
    assert.deepEqual(discover(options).map((skill) => skill.name), ["warm-first"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog versions follow symlink targets and defer all ignore decisions to the official loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-cache-links-"));
  const { discover, calls } = await countedDiscovery("links-and-ignore");
  const options = { cwd: root, agentDir: join(root, "agent"), home: join(root, "home"), projectTrusted: false };
  const dir = join(options.agentDir, "skills");
  const names = () => discover(options).map((skill) => skill.name);
  try {
    const target = join(root, "external", "SKILL.md");
    await writeSkill(target, "linked-first");
    await mkdir(dir, { recursive: true });
    const link = join(dir, "linked");
    await symlink(dirname(target), link, "dir");
    assert.deepEqual(names(), ["linked-first"]);
    const initialCalls = calls.length;
    assert.deepEqual(names(), ["linked-first"]);
    assert.equal(calls.length, initialCalls);
    await writeSkill(target, "linked-updated");
    assert.deepEqual(names(), ["linked-updated"]);

    const replacement = join(root, "replacement", "SKILL.md");
    await writeSkill(replacement, "linked-replacement");
    await rm(link);
    await symlink(dirname(replacement), link, "dir");
    assert.deepEqual(names(), ["linked-replacement"]);
    await rm(replacement);
    assert.deepEqual(names(), []);
    await writeSkill(replacement, "linked-restored");
    assert.deepEqual(names(), ["linked-restored"]);

    const fileLink = join(dir, "direct.md");
    await symlink(target, fileLink, "file");
    assert.deepEqual(names(), ["linked-restored", "linked-updated"]);
    await rm(target);
    assert.deepEqual(names(), ["linked-restored"]);
    await writeSkill(target, "file-link-restored");
    assert.deepEqual(names(), ["file-link-restored", "linked-restored"]);

    for (const ignoreName of [".gitignore", ".ignore", ".fdignore"]) {
      const ignore = join(dir, ignoreName);
      await writeFile(ignore, "linked/\ndirect.md\n");
      assert.deepEqual(names(), []);
      const ignoredCalls = calls.length;
      assert.deepEqual(names(), []);
      assert.equal(calls.length, ignoredCalls, "ignore files are not reread when metadata is unchanged");
      await writeFile(ignore, "direct.md\n");
      assert.deepEqual(names(), ["linked-restored"]);
      await rm(ignore);
      assert.deepEqual(names(), ["file-link-restored", "linked-restored"]);
    }

    const nestedIgnore = join(dirname(replacement), ".ignore");
    await writeFile(nestedIgnore, "SKILL.md\n");
    assert.deepEqual(names(), ["file-link-restored"]);
    await rm(nestedIgnore);
    assert.deepEqual(names(), ["file-link-restored", "linked-restored"]);
    const moved = join(root, "old-replacement");
    await rename(dirname(replacement), moved);
    assert.deepEqual(names(), ["file-link-restored"]);
    await mkdir(dirname(replacement));
    await writeSkill(replacement, "new-target-inode");
    assert.deepEqual(names(), ["file-link-restored", "new-target-inode"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leading native skill commands normalize to the sole inline syntax", () => {
  assert.deepEqual(parseSkillCommandInvocation("/skill:deploy production  west "), {
    name: "deploy",
    args: "production  west",
    normalizedText: "$deploy production  west",
  });
  assert.deepEqual(parseSkillCommandInvocation("/skill:dispatch-agent"), {
    name: "dispatch-agent",
    args: "",
    normalizedText: "$dispatch-agent",
  });
  assert.equal(parseSkillCommandInvocation("prefix /skill:deploy"), undefined);
  assert.equal(parseSkillCommandInvocation("/skill:"), undefined);
  assert.equal(parseSkillCommandInvocation("/skill:not.a.skill"), undefined);
});

test("only bare Codex mentions are parsed", () => {
  assert.deepEqual(findSkillMentions("Use $one, then ($plugin:deploy)."), [
    { start: 4, end: 8, name: "one" },
    { start: 16, end: 30, name: "plugin:deploy" },
  ]);
  assert.deepEqual(findSkillMentions("legacy $[one]"), []);
});

test("definite shell variables are ignored", () => {
  assert.deepEqual(findSkillMentions("echo $PATH $HOME $PWD"), []);
});

test("manual names resolve only when unambiguous", () => {
  const duplicate: SkillRef = { name: "one", path: "/project/one/SKILL.md", scope: "project" };
  const result = resolveSkillMentions("$one", [...skills, duplicate]);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.ambiguousNames, ["one"]);
});

test("a completion binding resolves an exact duplicate path", () => {
  const duplicate: SkillRef = { name: "one", path: "/project/one/SKILL.md", scope: "project" };
  const result = resolveSkillMentions("$one", [...skills, duplicate], [
    { start: 0, end: 4, name: "one", path: duplicate.path },
  ]);
  assert.deepEqual(result.skills.map((skill) => skill.path), [duplicate.path]);
});

test("skill loading preserves the complete file, including frontmatter", async () => {
  const source = `---\nname: one\n---\n${"界".repeat(3_000)}`;
  const loaded = await loadSkill(skills[0], async () => source);
  assert.equal(loaded.contents.startsWith("---\nname: one\n---"), true);
  assert.equal(loaded.contents, source);
  assert.equal(Buffer.byteLength(loaded.contents, "utf8") > 8_000, true);
  assert.equal(loaded.truncated, undefined);
  assert.match(renderSkillInstructions(loaded), /^<skill>\n<name>one<\/name>\n<path>\/user\/one\/SKILL\.md<\/path>\n---/);
});
