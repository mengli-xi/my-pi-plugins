import { readFile } from "node:fs/promises";
const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/compare-runs.mjs <run.json> [--json]");
const run = JSON.parse(await readFile(path,"utf8"));
if(run.version!==1)throw new Error("Unsupported run version");
const result={operationId:run.operationId,status:run.status,adopted:run.adopted,contextSizes:run.contextSizes,outputs:run.outputs,compactInstructionsHash:run.compactInstructions?.mergedHash};
if(process.argv.includes("--json"))console.log(JSON.stringify(result,null,2));
else {
 console.log(`Operation ${run.operationId}: ${run.status}; adopted=${run.adopted?.slot??"none"}`);
 console.log(`Before (estimated): ${JSON.stringify(run.contextSizes.before.estimated)}\nAfter (estimated): ${JSON.stringify(run.contextSizes.after.estimated)}\nAfter (provider): ${JSON.stringify(run.contextSizes.after.providerReported)}`);
 for(const slot of ["main","small"]){const out=run.outputs[slot];console.log(`\n${slot.toUpperCase()}${run.adopted?.slot===slot?" [adopted]":" [not adopted]"}`);if(!out){console.log("无影子输出 / not generated");continue;}console.log(`${out.requestedModel??"unknown"} -> ${out.effectiveModel??"unknown"}; mode=${out.effectiveMode}; ${out.status}; fallback=${out.fallbackReason??"none"}`);console.log(JSON.stringify(out.attempts.map(a=>({model:a.model,effort:a.requestedEffort,input:a.inputTokens,usage:a.usage??null,deadline:a.predictedDeadlineMs,elapsed:a.elapsedMs,error:a.error})),null,2));console.log(out.validated?.summary??out.rawOutput??out.error);}
 console.log("\nRequest source sizes (estimates and provider observations):\n"+JSON.stringify(run.contextSizes.requests,null,2));
}
