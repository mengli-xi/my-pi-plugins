import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { installCompactionSkillRecovery } from "./compact-recovery.ts";
import {
  createSkillAutocompleteProvider,
  DraftSkillBindings,
} from "./autocomplete.ts";
import {
  InvocationStore,
  LEGACY_SKILL_BINDING_ENTRY_TYPE,
  SKILL_BINDING_ENTRY_TYPE,
} from "./invocations.ts";
import {
  AGENT_SKILL_READ_ENTRY_TYPE,
  AgentSkillReadTracker,
  createLoadedSkillsRenderer,
} from "./loaded-skill-entry.ts";
import { SkillPresentation } from "./presentation.ts";
import {
  discoverRuntimeSkillRefs,
  getSkillCommands,
  loadSkill,
  mergeSkillRefs,
  parseSkillCommandInvocation,
  resolveSkillMentions,
  type BoundSkillMention,
  type LoadedSkill,
  type SkillRef,
} from "./skills.ts";

async function loadResolvedSkills(
  text: string,
  catalog: readonly SkillRef[],
  bindings: readonly BoundSkillMention[],
  ctx: ExtensionContext,
): Promise<LoadedSkill[]> {
  const resolved = resolveSkillMentions(text, catalog, bindings);
  for (const name of resolved.ambiguousNames) {
    ctx.ui.notify(`Skill $${name} is ambiguous; choose it from completion to bind an exact path.`, "warning");
  }

  const loaded: LoadedSkill[] = [];
  for (const skill of resolved.skills) {
    try {
      loaded.push(await loadSkill(skill));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to load skill ${skill.name}: ${reason}`, "warning");
    }
  }
  return loaded;
}

async function refreshLegacySkill(skill: LoadedSkill, ctx: ExtensionContext): Promise<LoadedSkill> {
  try {
    return await loadSkill({ name: skill.name, path: skill.path, scope: "temporary" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to refresh legacy skill ${skill.name}: ${reason}`, "warning");
    return skill;
  }
}

function registerLoadedSkillsRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(
    SKILL_BINDING_ENTRY_TYPE,
    createLoadedSkillsRenderer(SKILL_BINDING_ENTRY_TYPE),
  );
  pi.registerEntryRenderer(
    LEGACY_SKILL_BINDING_ENTRY_TYPE,
    createLoadedSkillsRenderer(LEGACY_SKILL_BINDING_ENTRY_TYPE),
  );
  pi.registerEntryRenderer(
    AGENT_SKILL_READ_ENTRY_TYPE,
    createLoadedSkillsRenderer(AGENT_SKILL_READ_ENTRY_TYPE),
  );
}

export default function skillMentions(pi: ExtensionAPI): void {
  installCompactionSkillRecovery(pi);
  const draftBindings = new DraftSkillBindings();
  const invocations = new InvocationStore();
  const agentReads = new AgentSkillReadTracker();
  const presentation = new SkillPresentation();
  let commandCatalog: SkillRef[] = [];
  let discoveredCatalog: SkillRef[] = [];
  let catalog: SkillRef[] = [];
  let readableSkills: SkillRef[] = [];
  let commandSkills = new Map<string, SkillRef>();

  registerLoadedSkillsRenderer(pi);

  const rebuildCatalog = () => {
    catalog = mergeSkillRefs(discoveredCatalog, commandCatalog.filter(skill => existsSync(skill.path)));
    commandSkills = new Map<string, SkillRef>();
    for (const skill of catalog) {
      if (!commandSkills.has(skill.name)) commandSkills.set(skill.name, skill);
    }
    presentation.updateCatalog(catalog);
  };

  const refreshCommandCatalog = () => {
    commandCatalog = getSkillCommands(pi.getCommands());
    rebuildCatalog();
  };

  const refreshAutocompleteCatalog = (ctx: ExtensionContext) => {
    discoveredCatalog = discoverRuntimeSkillRefs({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    rebuildCatalog();
  };


  pi.on("session_start", (_event, ctx) => {
    refreshCommandCatalog();
    presentation.activate(ctx, catalog);
    draftBindings.clear();
    invocations.restore(ctx.sessionManager.getEntries());
    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider((current) => (
        createSkillAutocompleteProvider(current, async () => {
          refreshAutocompleteCatalog(ctx);
          return catalog;
        }, draftBindings)
      ));
    }
  });

  pi.on("before_agent_start", (event) => {
    readableSkills = (event.systemPromptOptions.skills ?? [])
      .filter((skill: Skill) => !skill.disableModelInvocation)
      .map((skill: Skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        scope: skill.sourceInfo.scope,
      }));
  });

  pi.on("input", async (event, ctx) => {
    const command = parseSkillCommandInvocation(event.text);
    const commandSkill = command ? commandSkills.get(command.name) : undefined;
    if (command && commandSkill) {
      draftBindings.clear();
      try {
        const skill = await loadSkill(commandSkill);
        invocations.stage(command.normalizedText, [skill]);
        return { action: "transform", text: command.normalizedText };
      } catch {
        // Preserve Pi's native expansion and error reporting when the file cannot be read.
        return { action: "continue" };
      }
    }
    if (!event.text.includes("$")) {
      draftBindings.clear();
      return { action: "continue" };
    }
    const bindings = draftBindings.takeForSubmission(event.text);
    const skills = await loadResolvedSkills(event.text, catalog, bindings, ctx);
    if (skills.length > 0) invocations.stage(event.text, skills);
    return { action: "continue" };
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "user") {
      invocations.captureUserMessage(event.message, ctx.sessionManager.getEntries());
    }
  });

  pi.on("tool_result", (event, ctx) => {
    agentReads.match({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      parentToolCallId: event.parentToolCallId,
      args: event.input,
    }, ctx.cwd, readableSkills);
  });

  pi.on("tool_execution_end", async (event) => {
    await agentReads.finish(event);
  });

  pi.on("turn_end", (event) => {
    // turn_end runs after Pi has persisted every toolResult in the batch. Append
    // the TUI-only rows here so they never split assistant tool calls/results.
    for (const snapshot of agentReads.takeForTurn(event.toolResults)) {
      pi.appendEntry(AGENT_SKILL_READ_ENTRY_TYPE, snapshot);
    }
  });

  pi.on("context", async (event, ctx) => {
    const messages = await invocations.inject(
      event.messages,
      (text) => loadResolvedSkills(text, catalog, [], ctx),
      (skill) => refreshLegacySkill(skill, ctx),
    );
    // `context` runs after Pi has persisted the user message but before the
    // provider call. The sidecar therefore becomes a child of that user node
    // without itself participating in the model context.
    for (const snapshot of invocations.takeUnpersisted()) {
      pi.appendEntry(SKILL_BINDING_ENTRY_TYPE, snapshot);
    }
    return { messages };
  });

  pi.on("session_tree", () => {
    draftBindings.clear();
    invocations.clearPending();
    agentReads.clear();
  });

  pi.on("session_shutdown", () => {
    draftBindings.clear();
    invocations.clearPending();
    readableSkills = [];
    agentReads.clear();
    presentation.deactivate();
  });

}
