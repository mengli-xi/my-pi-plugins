import { ccMemoryActivityPrefix, classifyTool, isCollapsibleTool } from "./semantics.ts";
import type {
  GroupingConfig,
  ImportantToolsConfig,
  ToolPresentation,
} from "./types.ts";

export interface PresentationPolicyConfig {
  grouping: GroupingConfig;
  importantTools: ImportantToolsConfig;
}

export function resolveToolPresentation(
  toolName: string,
  args: unknown,
  config: PresentationPolicyConfig,
): ToolPresentation {
  const name = toolName.toLowerCase();
  if (ccMemoryActivityPrefix(name, args)) {
    return { kind: config.grouping.memory ? "grouped" : "native" };
  }
  if (name === "ask_user_question" && config.importantTools.askUserQuestion) {
    return { kind: "question" };
  }
  if (name === "web_search" && config.importantTools.webSearch) {
    return { kind: "web-search" };
  }
  if (name === "web_fetch" && config.importantTools.webFetch) {
    return { kind: "web-fetch" };
  }
  if (name === "edit" && config.importantTools.singleFileEdit) {
    return { kind: "single-file-edit" };
  }
  // A collapsed "updated 1 todo list" row would replace the checklist the tool
  // draws itself, so todo tools stay on Pi's native renderer.
  if (classifyTool(name) === "todo" && config.importantTools.todoList) {
    return { kind: "native" };
  }
  return {
    kind: isCollapsibleTool(toolName, config.grouping) ? "grouped" : "native",
  };
}
