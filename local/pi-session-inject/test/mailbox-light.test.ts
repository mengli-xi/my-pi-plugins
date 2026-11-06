import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const resolver = join(root, "test/ts-resolve.mjs");
const harnessModule = new URL("./mailbox-harness.ts", import.meta.url).href;
const engineKey = "pi.session-inject.mailbox.engine.v1";
function run(code: string, directory: string) {
  return execFileSync(process.execPath, ["--import", resolver, "--experimental-strip-types", "--input-type=module", "-e", code], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1" },
    encoding: "utf8",
  });
}
test("light empty startup registers canonical command completions without importing heavy mailbox modules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-light-empty-"));
  try {
    run(
      `import assert from 'node:assert/strict'; import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier,ctx,next){const value=next(specifier,ctx);if(/mailbox-v1\\/(engine|commands|schema|proof|storage|store|validation)\\.(ts|js)$/.test(value.url))throw Error('eager heavy import: '+value.url);return value;}});
      const {harness}=await import(${JSON.stringify(harnessModule)});const h=await harness({directory:${JSON.stringify(directory)}});
      try{h.producer('pi-processes');h.producer('pi-scheduler');await h.emit('session_start',{reason:'startup'});
        const command=h.commands.get('mailbox').definition;assert.deepEqual(command.getArgumentCompletions('').map(x=>x.value),['status','resume','recover']);
        assert.deepEqual(command.getArgumentCompletions('res').map(x=>x.value),['resume']);assert.equal(command.getArgumentCompletions('unknown'),null);
        const shared=globalThis[Symbol.for(${JSON.stringify(engineKey)})];assert.equal(shared.namespace,null);assert.equal(shared.loading,null);assert.equal(h.sends.length,0);
      }finally{await h.cleanup();}`,
      directory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("calling readonly projection on an empty owner loads no engine/writer and creates no mailbox storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-projection-empty-"));
  try {
    run(`import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {registerHooks} from 'node:module';
      registerHooks({resolve(specifier,ctx,next){const value=next(specifier,ctx);if(/mailbox-v1\\/(engine|storage|store)\\.(ts|js)$/.test(value.url))throw Error('loaded engine/writer: '+value.url);return value;}});
      const {harness}=await import(${JSON.stringify(harnessModule)});const {filterMailboxMessages}=await import(${JSON.stringify(new URL("../src/mailbox-v1/light.ts", import.meta.url).href)});
      const h=await harness({directory:${JSON.stringify(directory)}});
      try{h.producer('pi-processes');await h.emit('session_start',{reason:'startup'});const messages=[{role:'custom',customType:'ordinary',content:'kept',display:false,timestamp:1}];
        const output=await filterMailboxMessages(h.ctx,messages,{agentDir:h.agentDir});assert.equal(output[0],messages[0]);
        const shared=globalThis[Symbol.for(${JSON.stringify(engineKey)})];assert.equal(shared.namespace,null);assert.equal(shared.loading,null);
        assert.equal(existsSync(h.agentDir+'/mailbox'),false);assert.equal(h.sends.length,0);
      }finally{await h.cleanup();}`, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

let bundleDirectory: string | undefined;
async function bundles(): Promise<string> {
  if (bundleDirectory) return bundleDirectory;
  bundleDirectory = await mkdtemp(join(tmpdir(), "mailbox-light-bundles-"));
  await writeFile(join(bundleDirectory, "package.json"), '{"type":"module"}\n');
  await symlink(join(root, "node_modules"), join(bundleDirectory, "node_modules"));
  const source = `export {bindMailbox} from ${JSON.stringify(join(root, "src/mailbox-v1/light.ts"))}; export {loadEngine} from ${JSON.stringify(join(root, "src/mailbox-v1/engine-loader.ts"))};`;
  await writeFile(join(bundleDirectory, "entry.ts"), source);
  for (const label of ["a", "b"])
    execFileSync(
      "bun",
      [
        "build",
        join(bundleDirectory, "entry.ts"),
        "--target=node",
        "--format=esm",
        "--splitting",
        "--external=@earendil-works/*",
        `--outdir=${join(bundleDirectory, label)}`,
      ],
      { stdio: "pipe" },
    );
  return bundleDirectory;
}
after(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
});
for (const order of [
  ["a", "b"],
  ["b", "a"],
])
  test(`independent extensions ${order.join("→")} share one concurrent engine import and preserve original producer targets`, async () => {
    const directory = await bundles(),
      sessionDirectory = await mkdtemp(join(tmpdir(), "mailbox-light-session-"));
    try {
      run(
        `import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
      const [first,second]=await Promise.all(${JSON.stringify(order.map((label) => join(directory, label, "entry.js")))}.map(path=>import(pathToFileURL(path).href)));
      const {harness,tick}=await import(${JSON.stringify(harnessModule)});const h=await harness({directory:${JSON.stringify(sessionDirectory)}});
      try{const register=(module,id)=>module.bindMailbox(h.piFor(id),{agentDir:h.agentDir}).registerProducer({id,checkCurrent:()=>({kind:'hold',reason:'fixture'}),proveNative:()=>({kind:'observed',entries:[]})});
        const a=register(first,'pi-processes'),b=register(second,'pi-scheduler');await h.emit('session_start',{reason:'startup'});
        const target=a.target(h.ctx);const slot=globalThis[Symbol.for('pi.session-inject.mailbox.v1')].slots.get(target.slotKey);const epoch=slot.ownerEpoch;
        assert.equal(globalThis[Symbol.for(${JSON.stringify(engineKey)})].loading,null);
        const p=first.loadEngine(),q=second.loadEngine();assert.equal(p,q);const [x,y]=await Promise.all([p,q]);assert.equal(x,y);assert.equal(globalThis[Symbol.for(${JSON.stringify(engineKey)})].namespace,x);
        await Promise.all([a.put(h.mail('pi-processes','a'),target),b.put(h.mail('pi-scheduler','b'))]);await tick();
        assert.equal(slot.snapshot.pending.length,2);assert.equal(slot.ownerEpoch,epoch);assert.deepEqual(a.target(h.ctx),target);assert.equal(h.sends.length,0);
      }finally{await h.cleanup();}`,
        sessionDirectory,
      );
    } finally {
      await rm(sessionDirectory, { recursive: true, force: true });
    }
  });

test("pending recovery loads the engine before session_start resolves and stays cold-held", async () => {
  const { harness, recoveredPending, tick } = await import("./mailbox-harness.js");
  const h = await harness({ persist: true });
  try {
    const old = h.mail("pi-processes", "recovered-before-first-run");
    await recoveredPending(h.agentDir, h.manager, [old]);
    const p = h.producer("pi-processes");
    await h.emit("session_start", { reason: "startup" });
    const holder = (globalThis as any)[Symbol.for("pi.session-inject.mailbox.v1")];
    const slot = holder.slots.get(p.endpoint.target(h.ctx).slotKey);
    assert.equal(slot.snapshot.pending.length, 1);
    assert.equal(slot.recoveryHeld, true);
    assert.ok((globalThis as any)[Symbol.for(engineKey)].namespace);
    await tick();
    await tick();
    assert.equal(h.sends.length, 0);
  } finally {
    await h.cleanup();
  }
});
test("an incompatible process-wide engine holder fails closed without replacement", async () => {
  const { bindMailbox, MAILBOX_TRANSPORT_BUILD_ID } = await import("../src/mailbox-v1/light.js");
  const key = Symbol.for(engineKey),
    root = globalThis as any,
    previous = root[key];
  const incompatible = { version: 1, transportBuildId: `${MAILBOX_TRANSPORT_BUILD_ID}-other`, namespace: null, loading: null };
  try {
    root[key] = incompatible;
    assert.throws(() => bindMailbox({} as any), { code: "holder-incompatible" });
    assert.equal(root[key], incompatible);
  } finally {
    if (previous === undefined) delete root[key];
    else root[key] = previous;
  }
});
