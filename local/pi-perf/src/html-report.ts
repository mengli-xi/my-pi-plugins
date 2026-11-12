import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DailySummary } from "./history.ts";
import type { MemorySummary } from "./runtime-metrics.ts";
import type { TelemetrySnapshot } from "./telemetry.ts";
import type { PerfTimelineSample } from "./timeline.ts";

export interface ReportMetricStats {
  name: string;
  count: number;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface PerfReportData {
  trends?: DailySummary[];
  maintenanceError?: string;
  skippedDailyFiles?: number;
  trendsLimited?: boolean;
  trendGroupsCombined?: boolean;
  busyTrendDays?: number;
  generatedAt: number;
  sessionId: string;
  monitoringEnabled: boolean;
  uiMetrics: ReportMetricStats[];
  telemetry: TelemetrySnapshot;
  memory: MemorySummary;
  eventLoop: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    utilization: number;
  };
  instrumentation: {
    frame: boolean;
    request: boolean;
    input: boolean;
    hostReloadCache?: boolean;
    hostReloadCacheDetail?: string;
    detail?: string;
  };
  timeline: PerfTimelineSample[];
}

function reportTimestamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function defaultPerfReportPath(at = Date.now()): string {
  return join(getAgentDir(), "perf", "reports", `perf-${reportTimestamp(at)}.html`);
}

function serialized(data: PerfReportData): string {
  return JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function htmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
/** Static inline SVG works even with scripts disabled and keeps series separate
 * by mode, Pi version and package combination. Missing days are not invented. */
export function renderTrendCharts(rows: DailySummary[]): string {
  const metrics: Array<[string, string, number, "p50" | "p95" | "mean"]> = [
    ["readyMs", "冷启动 ≈p50 ms", 1, "p50"], ["rss", "RSS ≈p95 MiB", 1048576, "p95"],
    ["cpuPercent", "CPU 平均 %", 1, "mean"], ["loopP99Ms", "事件循环超时 ≈p95 ms", 1, "p95"]];
  const colors = ["#df8f68", "#78b9bd", "#8fba7e", "#a995ca", "#d6b46b", "#dc7b73"];
  return metrics.map(([metric, label, scale, statistic]) => {
    const series = new Map<string, Array<{ day: string; at: number; value: number }>>();
    for (const row of rows) {
      const stats = row.metrics[metric]; if (!stats) continue;
      const key = `${row.piVersion} / ${row.mode} / ${row.packages.join(", ") || "未知/无包"} (${row.packagesHash})`;
      const points = series.get(key) ?? [];
      points.push({ day: row.day, at: Date.parse(row.day), value: stats[statistic] / scale }); series.set(key, points);
    }
    if (!series.size) return `<figure><figcaption>${label}</figcaption><p>暂无样本</p></figure>`;
    const points = [...series.values()].flat();
    const from = Math.min(...points.map(p => p.at)), to = Math.max(...points.map(p => p.at));
    const max = Math.max(1, ...points.map(p => p.value));
    const x = (at: number) => 60 + (at - from) / Math.max(1, to - from) * 550;
    const y = (value: number) => 155 - value / max * 130;
    const lines = [...series].map(([key, points], i) => {
      points.sort((a, b) => a.at - b.at);
      const color = colors[i % colors.length];
      return `<g stroke="${color}" fill="${color}"><title>${htmlText(key)}</title><polyline fill="none" stroke-width="2" points="${points.map(p => `${x(p.at).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ")}"/>${points.map(p => `<circle r="3" cx="${x(p.at).toFixed(2)}" cy="${y(p.value).toFixed(2)}"><title>${p.day}: ${p.value.toFixed(2)}</title></circle>`).join("")}</g>`;
    }).join("");
    return `<figure><figcaption>${label}</figcaption><svg role="img" aria-label="${label}" viewBox="0 0 640 190" style="width:100%;max-height:260px"><path d="M60 20V155H615" fill="none" stroke="#827a71"/><g fill="#9d958b" font-size="11"><text x="4" y="28">${max.toFixed(1)}</text><text x="40" y="158">0</text><text x="60" y="180">${new Date(from).toISOString().slice(0, 10)}</text><text x="530" y="180">${new Date(to).toISOString().slice(0, 10)}</text></g>${lines}</svg><details><summary>版本 / 模式 / 插件组合</summary>${[...series.keys()].map((key, i) => `<div style="color:${colors[i % colors.length]}">${htmlText(key)}</div>`).join("")}</details></figure>`;
  }).join("");
}

export function renderPerfReportHtml(data: PerfReportData): string {
  const payload = serialized(data);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Pi performance report</title>
<style>
:root{color-scheme:dark;--bg:#10100f;--panel:#191816;--panel2:#211f1c;--line:#39342e;--text:#eee8df;--muted:#9d958b;--accent:#df8f68;--cyan:#78b9bd;--green:#8fba7e;--yellow:#d6b46b;--red:#dc7b73;--purple:#a995ca}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#282019 0,transparent 35%),var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
main{max-width:1500px;margin:auto;padding:30px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:22px}.hero h1{font:700 30px/1.1 system-ui,sans-serif;margin:0 0 8px}.hero p{margin:0;color:var(--muted)}.badge{border:1px solid var(--line);border-radius:999px;padding:7px 11px;color:var(--muted);white-space:nowrap}
.cards{display:grid;grid-template-columns:repeat(6,minmax(140px,1fr));gap:10px;margin:18px 0}.card,.panel{background:linear-gradient(145deg,rgba(34,32,29,.96),rgba(24,23,21,.96));border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px #0003}.card{padding:14px}.card .label{color:var(--muted);font-size:12px}.card .value{font:650 22px/1.3 system-ui,sans-serif;margin-top:5px}.card .note{color:var(--muted);font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:12px;margin:12px 0}.panel{padding:16px;min-width:0}.panel h2{font:650 16px system-ui,sans-serif;margin:0 0 4px}.panel .sub{color:var(--muted);font-size:12px;margin-bottom:12px}.wide{grid-column:1/-1}canvas{display:block;width:100%;height:260px;background:#121210;border:1px solid #302c27;border-radius:8px}
select{background:#171614;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 9px;max-width:100%}.toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:10px}.legend{display:flex;gap:12px;color:var(--muted);font-size:11px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.table-wrap{max-height:420px;overflow:auto;border:1px solid #302c27;border-radius:8px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:right;padding:8px 9px;border-bottom:1px solid #2e2b27;white-space:nowrap}th{position:sticky;top:0;background:#24211e;color:var(--muted);z-index:1}th:first-child,td:first-child{text-align:left;max-width:440px;overflow:hidden;text-overflow:ellipsis}.barcell{position:relative}.bar{position:absolute;inset:4px auto 4px 4px;background:#df8f6826;border-radius:4px;z-index:0}.barcell span{position:relative;z-index:1}
.interactions{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:9px;max-height:500px;overflow:auto}.interaction{border:1px solid #34302b;border-radius:9px;padding:10px;background:#151412}.interaction header{display:flex;justify-content:space-between;color:var(--muted);margin-bottom:8px}.stage{display:grid;grid-template-columns:minmax(125px,1fr) 2fr 65px;gap:8px;align-items:center;margin:5px 0;font-size:11px}.stage-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{height:9px;background:#2b2824;border-radius:99px;overflow:hidden}.fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--yellow));border-radius:99px}.empty{color:var(--muted);padding:25px;text-align:center}
.health{display:flex;gap:9px;flex-wrap:wrap}.health span{border:1px solid var(--line);border-radius:7px;padding:6px 8px}.ok{color:var(--green)}.bad{color:var(--red)}footer{color:var(--muted);font-size:11px;margin:24px 2px}.privacy{color:var(--cyan)}
@media(max-width:1100px){.cards{grid-template-columns:repeat(3,1fr)}.grid{grid-template-columns:1fr}}@media(max-width:650px){main{padding:16px}.cards{grid-template-columns:repeat(2,1fr)}.hero{display:block}.badge{display:inline-block;margin-top:12px}.stage{grid-template-columns:110px 1fr 55px}}
</style>
</head>
<body><main>
<section class="hero"><div><h1>Pi performance report</h1><p id="subtitle"></p></div><div class="badge" id="status"></div></section>
<section class="cards" id="cards"></section>
<section class="grid">
  <article class="panel wide"><h2>长期趋势 · 最近 30 天</h2><div class="sub">按 Pi 版本、模式和插件组合分组；≈p50 / p95 / max</div>${data.maintenanceError ? `<p class="bad">${htmlText(data.maintenanceError)}</p>` : ""}${data.trendsLimited ? `<p class="bad">趋势读取达到文件上限，结果不完整。</p>` : ""}${data.trendGroupsCombined ? `<p class="bad">旧日过多组合按模式合并为 mixed / other。</p>` : ""}${data.busyTrendDays ? `<p class="bad">跳过 ${data.busyTrendDays} 个正在维护或写入的日期，结果不完整。</p>` : ""}${data.skippedDailyFiles ? `<p class="bad">跳过 ${data.skippedDailyFiles} 个 daily 文件，趋势不完整。</p>` : ""}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">${renderTrendCharts(data.trends ?? [])}</div><div class="table-wrap"><table id="trends"></table></div></article>
  <article class="panel wide"><div class="toolbar"><div><h2>Timeline explorer</h2><div class="sub">选择任意 UI、插件或运行时指标查看时间趋势</div></div><select id="series"></select></div><canvas id="timeline"></canvas><div class="legend" id="timeline-legend"></div></article>
  <article class="panel"><h2>Memory</h2><div class="sub">RSS 与 heap used，采样周期由 pi-perf 控制</div><canvas id="memory"></canvas><div class="legend"><span><i class="dot" style="background:var(--accent)"></i>RSS</span><span><i class="dot" style="background:var(--cyan)"></i>Heap</span></div></article>
  <article class="panel"><h2>Instrumentation health</h2><div class="sub">全局边界探针与数据安全状态；事件循环统计为本分钟窗口（≤60s，采样/reset 后重置）</div><div class="health" id="health"></div><footer class="privacy">报告只包含数值指标、owner、metric、interaction ID 与有界标量标签。</footer></article>
  <article class="panel wide"><h2>Plugin span ranking</h2><div class="sub">所有 producer，按 p95 从慢到快</div><div class="table-wrap"><table id="plugins"></table></div></article>
  <article class="panel wide"><h2>Interaction waterfall</h2><div class="sub">最近带 interaction ID 的交互阶段；条形长度表示该阶段耗时</div><div class="interactions" id="interactions"></div></article>
  <article class="panel"><h2>UI latency distribution</h2><div class="sub">当前 bounded window 的聚合统计</div><div class="table-wrap"><table id="ui-table"></table></div></article>
  <article class="panel"><div class="toolbar"><div><h2>Slow samples</h2><div class="sub">按耗时排序，可筛选数据源</div></div><select id="source"><option value="">all sources</option><option>ui</option><option>plugin</option><option>runtime</option></select></div><div class="table-wrap"><table id="samples"></table></div></article>
</section>
<footer>Generated locally by pi-perf · self-contained HTML · no network requests</footer>
</main>
<script id="perf-data" type="application/json">${payload}</script>
<script>
"use strict";
const data=JSON.parse(document.getElementById("perf-data").textContent);
const timeline=data.timeline||[];
const trendMetrics=[['readyMs','冷启动 ms',1],['rss','RSS MiB',1048576],['heapUsed','heap MiB',1048576],['cpuPercent','CPU %',1],['loopP99Ms','loop p99 ms',1]];
const trendTable=document.getElementById("trends");
const header=trendTable.createTHead().insertRow();
for(const label of ['日期','Pi','模式','插件组合','插件哈希','会话',...trendMetrics.map(v=>v[1])]) header.insertCell().textContent=label;
const tbody=trendTable.createTBody();
for(const row of data.trends||[]){const tr=tbody.insertRow();for(const value of [row.day,row.piVersion,row.mode,(row.packages||[]).join(", ")||"未知/无包",row.packagesHash,row.sessions,...trendMetrics.map(([key,,scale])=>{const v=row.metrics[key];return v?[v.p50,v.p95,v.max].map(n=>(n/scale).toFixed(1)).join(' / '):'—'})])tr.insertCell().textContent=String(value);}

const fmtMs=v=>v>=1000?(v/1000).toFixed(v>=10000?1:2)+"s":v<1?v.toFixed(2)+"ms":v.toFixed(1)+"ms";
const fmtBytes=v=>v>=1073741824?(v/1073741824).toFixed(2)+"GB":v>=1048576?(v/1048576).toFixed(1)+"MB":v>=1024?(v/1024).toFixed(1)+"KB":v+"B";
const fmtTime=v=>new Date(v).toLocaleTimeString([], {hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"});
const esc=v=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const maxBy=(rows,key)=>rows.reduce((best,row)=>!best||row[key]>best[key]?row:best,null);
document.getElementById("subtitle").textContent=(data.sessionId?"session "+data.sessionId:"ephemeral session")+" · "+new Date(data.generatedAt).toLocaleString();
document.getElementById("status").textContent=data.monitoringEnabled?"● monitoring enabled":"○ monitoring disabled";
const worstUi=maxBy(data.uiMetrics||[],"p95Ms");const worstPlugin=maxBy(data.telemetry.measures||[],"p95Ms");
const startup=(data.uiMetrics||[]).find(row=>row.name==="launcher→first-observed-frame")||(data.uiMetrics||[]).find(row=>row.name==="process-start→first-observed-frame")||(data.uiMetrics||[]).find(row=>row.name==="launcher→first-paint")||(data.uiMetrics||[]).find(row=>row.name==="process-start→first-paint");
const cards=[
 ["First observed startup frame",startup?fmtMs(startup.lastMs):"—","after session_start; not the process first frame"],
 ["Current RSS",fmtBytes(data.memory.current.rss),"peak "+fmtBytes(data.memory.peak.rss)],
 ["Event-loop p95",fmtMs(data.eventLoop.p95Ms),"本分钟窗口（采样后重置） · max "+fmtMs(data.eventLoop.maxMs)],
 ["Worst UI p95",worstUi?fmtMs(worstUi.p95Ms):"—",worstUi?worstUi.name:"no samples"],
 ["Worst plugin p95",worstPlugin?fmtMs(worstPlugin.p95Ms):"—",worstPlugin?worstPlugin.owner+"/"+worstPlugin.name:"no samples"],
 ["Timeline samples",String(timeline.length),"fixed-capacity ring"],
 ["Producers",String((data.telemetry.owners||[]).length),(data.telemetry.owners||[]).join(", ")||"none"]
];
document.getElementById("cards").innerHTML=cards.map(c=>'<div class="card"><div class="label">'+esc(c[0])+'</div><div class="value">'+esc(c[1])+'</div><div class="note" title="'+esc(c[2])+'">'+esc(c[2])+'</div></div>').join("");
const health=data.instrumentation;document.getElementById("health").innerHTML=[
 ["frame",health.frame],["request",health.request],["input",health.input],...(health.hostReloadCache===undefined?[]:[["host reload cache",health.hostReloadCache]])
].map(v=>'<span class="'+(v[1]?"ok":"bad")+'">'+(v[1]?"✓ ":"✕ ")+v[0]+'</span>').join("")+'<span>event loop '+(data.eventLoop.utilization*100).toFixed(1)+'%</span>'+(health.hostReloadCacheDetail?'<span>'+esc(health.hostReloadCacheDetail)+'</span>':"")+(health.detail?'<span>'+esc(health.detail)+'</span>':"");
function setupCanvas(canvas){const ratio=devicePixelRatio||1;const rect=canvas.getBoundingClientRect();canvas.width=Math.max(1,Math.floor(rect.width*ratio));canvas.height=Math.max(1,Math.floor(rect.height*ratio));const ctx=canvas.getContext("2d");ctx.setTransform(ratio,0,0,ratio,0,0);return {ctx,w:rect.width,h:rect.height};}
function drawLines(canvas,series,formatter){const c=setupCanvas(canvas),ctx=c.ctx,w=c.w,h=c.h,p={l:48,r:12,t:16,b:28};ctx.clearRect(0,0,w,h);const all=series.flatMap(s=>s.rows);if(!all.length){ctx.fillStyle="#9d958b";ctx.fillText("no time-series samples",p.l,p.t+20);return}const minX=Math.min(...all.map(r=>r.at)),maxX=Math.max(...all.map(r=>r.at));const maxY=Math.max(1,...all.map(r=>r.value))*1.08;ctx.strokeStyle="#302c27";ctx.fillStyle="#827a71";ctx.font="10px ui-monospace";for(let i=0;i<=4;i++){const y=p.t+(h-p.t-p.b)*i/4;ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText(formatter(maxY*(1-i/4)),4,y+3)}ctx.fillText(fmtTime(minX),p.l,h-8);const end=fmtTime(maxX);ctx.fillText(end,w-p.r-ctx.measureText(end).width,h-8);for(const s of series){ctx.strokeStyle=s.color;ctx.lineWidth=1.8;ctx.beginPath();s.rows.forEach((r,i)=>{const x=p.l+(w-p.l-p.r)*((r.at-minX)/Math.max(1,maxX-minX));const y=p.t+(h-p.t-p.b)*(1-r.value/maxY);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke()}}
const seriesKey=s=>s.owner+"/"+s.metric+" ["+s.unit+"]";const grouped=new Map();for(const row of timeline){const key=seriesKey(row);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row)}
const seriesSelect=document.getElementById("series");const keys=[...grouped.keys()].sort();seriesSelect.innerHTML=keys.map(k=>'<option>'+esc(k)+'</option>').join("");const preferred=keys.find(k=>k.includes("ui-request→paint"))||keys.find(k=>k.includes("render [ms]"))||keys[0];if(preferred)seriesSelect.value=preferred;
function renderTimeline(){const key=seriesSelect.value,rows=grouped.get(key)||[];const unit=rows[0]?.unit||"";drawLines(document.getElementById("timeline"),[{rows,color:"#df8f68"}],unit==="bytes"?fmtBytes:unit==="ratio"?v=>(v*100).toFixed(1)+"%":fmtMs);document.getElementById("timeline-legend").innerHTML='<span><i class="dot" style="background:var(--accent)"></i>'+esc(key||"no samples")+' · '+rows.length+' points</span>'}
seriesSelect.addEventListener("change",renderTimeline);renderTimeline();
const rss=timeline.filter(r=>r.owner==="runtime"&&r.metric==="memory.rss").map(r=>({...r,value:r.value/1048576}));const heap=timeline.filter(r=>r.owner==="runtime"&&r.metric==="memory.heap-used").map(r=>({...r,value:r.value/1048576}));drawLines(document.getElementById("memory"),[{rows:rss,color:"#df8f68"},{rows:heap,color:"#78b9bd"}],v=>v.toFixed(0)+"MB");
function metricTable(rows,plugin){const max=Math.max(1,...rows.map(r=>r.p95Ms));return '<thead><tr><th>metric</th><th>n</th><th>last</th><th>p50</th><th>p95</th><th>max</th></tr></thead><tbody>'+rows.map(r=>'<tr><td title="'+esc((plugin?r.owner+"/":"")+r.name)+'">'+esc((plugin?r.owner+"/":"")+r.name)+'</td><td>'+r.count+'</td><td>'+fmtMs(r.lastMs)+'</td><td>'+fmtMs(r.p50Ms)+'</td><td class="barcell"><i class="bar" style="width:'+Math.max(1,r.p95Ms/max*96)+'%"></i><span>'+fmtMs(r.p95Ms)+'</span></td><td>'+fmtMs(r.maxMs)+'</td></tr>').join("")+'</tbody>'}
const pluginRows=[...(data.telemetry.measures||[])].sort((a,b)=>b.p95Ms-a.p95Ms);document.getElementById("plugins").innerHTML=pluginRows.length?metricTable(pluginRows,true):'<tbody><tr><td class="empty">no plugin spans</td></tr></tbody>';
const uiRows=[...(data.uiMetrics||[])].sort((a,b)=>b.p95Ms-a.p95Ms);document.getElementById("ui-table").innerHTML=uiRows.length?metricTable(uiRows,false):'<tbody><tr><td class="empty">no UI samples</td></tr></tbody>';
const interactionMap=new Map();for(const row of timeline){if(row.interaction===undefined)continue;if(!interactionMap.has(row.interaction))interactionMap.set(row.interaction,[]);interactionMap.get(row.interaction).push(row)}const interactionRows=[...interactionMap.entries()].sort((a,b)=>b[0]-a[0]).slice(0,24);document.getElementById("interactions").innerHTML=interactionRows.length?interactionRows.map(([id,rows])=>{rows=rows.filter(r=>r.unit==="ms").sort((a,b)=>a.at-b.at);const max=Math.max(1,...rows.map(r=>r.value));return '<div class="interaction"><header><b>#'+id+'</b><span>'+esc(rows[0]?fmtTime(rows[0].at):"")+'</span></header>'+rows.map(r=>'<div class="stage"><span class="stage-name" title="'+esc(r.owner+"/"+r.metric)+'">'+esc(r.metric)+'</span><span class="track"><i class="fill" style="display:block;width:'+Math.max(1,r.value/max*100)+'%"></i></span><span>'+fmtMs(r.value)+'</span></div>').join("")+'</div>'}).join(""):'<div class="empty">no interaction-correlated samples yet</div>';
function renderSamples(){const source=document.getElementById("source").value;const rows=timeline.filter(r=>r.unit==="ms"&&(!source||r.source===source)).sort((a,b)=>b.value-a.value).slice(0,100);document.getElementById("samples").innerHTML='<thead><tr><th>metric</th><th>source</th><th>time</th><th>value</th></tr></thead><tbody>'+rows.map(r=>'<tr><td title="'+esc(r.owner+"/"+r.metric)+'">'+esc(r.owner+"/"+r.metric)+'</td><td>'+esc(r.source)+'</td><td>'+fmtTime(r.at)+'</td><td>'+fmtMs(r.value)+'</td></tr>').join("")+'</tbody>'}
document.getElementById("source").addEventListener("change",renderSamples);renderSamples();
let resizeTimer;addEventListener("resize",()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{renderTimeline();drawLines(document.getElementById("memory"),[{rows:rss,color:"#df8f68"},{rows:heap,color:"#78b9bd"}],v=>v.toFixed(0)+"MB")},120)});
</script></body></html>`;
}

export async function writePerfReport(data: PerfReportData, path = defaultPerfReportPath(data.generatedAt)): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const file = await open(path, "w", 0o600);
  try { await file.chmod(0o600); await file.writeFile(renderPerfReportHtml(data), "utf8"); } finally { await file.close(); }
  return path;
}

export function browserLaunchSpec(path: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [path] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", path] };
  return { command: "xdg-open", args: [path] };
}

/** Launch the platform browser without keeping Pi alive. */
export async function openPerfReport(path: string): Promise<void> {
  const { command, args } = browserLaunchSpec(path);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
