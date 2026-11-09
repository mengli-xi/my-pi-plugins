import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify } from "jsonc-parser";
import { reserveForWindow } from "./budget.ts";
type Settings = ReturnType<SettingsManager["getSettings"]>;

export const RESERVE_ACTIONS = ["write"] as const;
export function parseReserve(value: string): "report" | "write" | undefined {
  const action = value.trim().toLowerCase();
  return action === "" ? "report" : RESERVE_ACTIONS.find((item) => item === action);
}
export interface ReserveModel { provider: string; id: string; contextWindow: number }
export interface ReserveRow {
  key: string; window: number; reserve: number; source: string; target: number;
  status: "一致" | "缺覆盖" | "不一致"; project: boolean;
}
export interface ReservePatch { reserveTokens: number; keepRecentTokens: number }
export interface ReserveReport { rows: ReserveRow[]; changes: Record<string, ReservePatch>; project: Settings["compaction"]; projectTrusted: boolean }

/** Resolve defaults through Pi's public accessor; no copied host defaults or private fields. */
export function reserveReport(models: ReserveModel[], global: Settings, project: Settings, effective?: Settings, projectTrusted = true): ReserveReport {
  const settings = SettingsManager.inMemory(global);
  if (projectTrusted) settings.applyOverrides(project);
  const disk = settings.getSettings();
  const current = effective ?? disk;
  const resolved = SettingsManager.inMemory(current);
  const globalSettings = SettingsManager.inMemory(global);
  const changes: Record<string, ReservePatch> = {};
  const rows = [...models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`)).map((model): ReserveRow => {
    if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) throw new Error(`无效窗口：${model.provider}/${model.id}`);
    const key = `${model.provider}/${model.id}`, target = reserveForWindow(model.contextWindow);
    const reserve = resolved.getCompactionReserveTokens(model);
    const override = current.compaction?.modelOverrides?.[key];
    const diskOverride = disk.compaction?.modelOverrides?.[key];
    const sourceKnown = override?.reserveTokens === diskOverride?.reserveTokens &&
      (override?.reserveTokens !== undefined || current.compaction?.reserveTokens === disk.compaction?.reserveTokens);
    const projectOverride = project.compaction?.modelOverrides?.[key];
    const fromProject = projectTrusted && projectOverride?.reserveTokens !== undefined && projectOverride.reserveTokens === override?.reserveTokens;
    const source = !sourceKnown ? "无法确认（设置文件已变，重启后再看）" : override?.reserveTokens !== undefined ? `模型覆盖${fromProject ? "（项目级）" : ""}`
      : current.compaction?.reserveTokens !== undefined ? (projectTrusted && project.compaction?.reserveTokens === current.compaction.reserveTokens ? "项目级设置" : "全局设置") : "内置默认";
    const status = override?.reserveTokens === undefined ? "缺覆盖" : reserve !== target ? "不一致" : "一致";
    // Write global targets even if a project override already matches. A project conflict remains visible.
    if (global.compaction?.modelOverrides?.[key]?.reserveTokens !== target) {
      changes[key] = { reserveTokens: target, keepRecentTokens: globalSettings.getCompactionKeepRecentTokens(model) };
    }
    return { key, window: model.contextWindow, reserve, source, target,
      status, project: !!projectOverride || project.compaction?.reserveTokens !== undefined };
  });
  return { rows, changes, project: project.compaction, projectTrusted };
}

export function reserveJson(report: ReserveReport): string {
  return JSON.stringify(Object.keys(report.changes).length ? { compaction: { modelOverrides: report.changes } } : {}, null, 2);
}
export function describeReserve(report: ReserveReport): string {
  const lines = ["90% 压缩阈值校对（目标 reserveTokens = ceil(contextWindow × 10%)）", "模型 | 窗口 | 当前 reserveTokens | 来源 | 目标 | 状态"];
  for (const r of report.rows) lines.push(`${r.key} | ${r.window} | ${r.reserve} | ${r.source} | ${r.target} | ${r.status}${r.project ? "（有项目级覆盖）" : ""}`);
  if (!report.rows.length) lines.push("当前没有可用模型。");
  if (report.project) lines.push("", `项目级 .pi/settings.json 存在 compaction 设置（${report.projectTrusted ? "项目已信任" : "项目未信任，当前不加载"}）。write 只写全局，项目覆盖仍可能改变结果。`, JSON.stringify({ compaction: report.project }, null, 2));
  lines.push("", "当前值来自本进程已加载设置；下列 JSON 按磁盘全局设置生成。外部设置改动需重启后核对。");
  lines.push("", `全局需新增/修改 ${Object.keys(report.changes).length} 项（不删除不可用模型的已有覆盖）：`, reserveJson(report));
  return lines.join("\n");
}

export function parseSettings(text: string | undefined): Settings {
  const value: unknown = text === undefined ? {} : JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.json 必须是 JSON object");
  return value as Settings;
}

/** Unformatted AST edits preserve every other byte and existing property position. */
export function mergeReserve(text: string | undefined, changes: Record<string, ReservePatch>): string {
  parseSettings(text);
  let next = text ?? "{}\n";
  for (const [key, patch] of Object.entries(changes)) for (const [field, value] of Object.entries(patch)) {
    next = applyEdits(next, modify(next, ["compaction", "modelOverrides", key, field], value, {}));
  }
  // AST lookup can edit the first duplicate key while JSON.parse (and Pi) uses the last.
  // Validate effective values before the writer creates any backup or temporary file.
  const merged = parseSettings(next);
  for (const [key, patch] of Object.entries(changes)) {
    const actual = merged.compaction?.modelOverrides?.[key];
    if (actual?.reserveTokens !== patch.reserveTokens || actual?.keepRecentTokens !== patch.keepRecentTokens) {
      throw new Error(`未写入：${key} 的有效 token 设置与确认值不一致，请检查 settings.json 里的重复键。`);
    }
  }
  return next;
}
