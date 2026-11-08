import assert from "node:assert/strict";
import test from "node:test";
import { freshHost } from "../fixtures/fresh-host.js";
test("send_input rejects Main as a target without admitting work", {timeout:60000}, async t => {
 const f=await freshHost(t);await f.rpc("prompt",{message:"/subagents-test-spawn"});const before=await f.settled();
 const result=await f.control("send_input",{target:"/root",message:"must not run"});assert.equal(result.details.outcome,"rejected");assert.equal((await f.snapshot()).snapshot.agents[0].tasks.length,before.snapshot.agents[0].tasks.length);await f.stop();
});
