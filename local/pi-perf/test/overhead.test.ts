import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

// A fresh process excludes concurrent test-runner CPU and permits full GC between
// accelerated days. It exercises real sampling, histogram, JSONL and daily files.
test("default monitoring stays below 0.5% CPU and retains bounded memory across days", { timeout: 120_000 }, async () => {
  const source = `
import { LowFrequencySampler } from ${JSON.stringify(new URL("../src/sampler.ts", import.meta.url).href)};
import { PerfHistory, DAY_MS } from ${JSON.stringify(new URL("../src/history.ts", import.meta.url).href)};
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = await mkdtemp(join(tmpdir(),'perf-overhead-'));
try {
 const history = new PerfHistory(root,{pid:process.pid,piVersion:'benchmark',packagesHash:'benchmark',packages:[],mode:'tui'});
 const startDay = Date.now() - Date.now() % DAY_MS;
 let at = startDay;
 history.setIdentityReady(Promise.resolve());
 const sampler = new LowFrequencySampler(sample => history.write('sample',sample,at),()=>({entries:200,contextTokens:10000}));
 if(sampler.interval!==60000) throw new Error('default interval changed');
 sampler.start(); sampler.sample(); await history.flush(); await delay(200);
 const cpu=process.cpuUsage(), start=performance.now();
 await delay(5000); sampler.sample(); await history.flush();
 const elapsed=performance.now()-start, used=process.cpuUsage(cpu);
 const cpuPercent=(used.user+used.system)/elapsed/10;
 sampler.stop();
 // Four accelerated days, flushing each write just as a minute timer would.
 const retained=[];
 const batchCpu=process.cpuUsage();
 for(let day=0;day<4;day++) {
   for(let minute=0;minute<1440;minute++) { at=startDay+day*DAY_MS+minute*60000; sampler.sample(); await history.flush(); }
   global.gc(); retained.push(process.memoryUsage());
 }
 const batchUsed=process.cpuUsage(batchCpu);
 if(history.error) throw new Error(history.error);
 const heapGrowth=retained[3].heapUsed-retained[1].heapUsed;
 const rssGrowth=retained[3].rss-retained[1].rss;
 console.log(JSON.stringify({cpuPercent,elapsed,heapGrowth,rssGrowth,heapRetained:retained[3].heapUsed,
   acceleratedSampleCpuPercent:(batchUsed.user+batchUsed.system)/(4*DAY_MS)/10}));
} finally {await rm(root,{recursive:true,force:true});}
`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--expose-gc", "--experimental-strip-types", "--input-type=module", "-e", source], { timeout: 110_000 });
  const result = JSON.parse(stdout.trim());
  console.log("pi-perf overhead", result);
  assert.ok(result.cpuPercent < .5, `idle histogram + sample + storage CPU ${result.cpuPercent}%`);
  assert.ok(result.acceleratedSampleCpuPercent < .5);
  assert.ok(result.heapGrowth < 4 * 1048576, `retained heap growth ${result.heapGrowth}`);
  assert.ok(result.rssGrowth < 16 * 1048576, `RSS growth after warmup ${result.rssGrowth}`);
});
