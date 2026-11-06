export type MemoryRole = "main" | "child" | "side";

/** Original English policy based on the approved semantics; no product prompt copied. */
export function memoryPolicy(memoryDir: string, sessionId: string, role: MemoryRole): string {
  return `Project memory: ${memoryDir}
The directory is ready; use ordinary read/write/edit directly, without checking or creating it. Session ID: ${sessionId}.
Role: ${role}. ${role === "main" ? "Main may maintain topics and their index." : "Memory is read-only: never modify topics or the index through any tool, including bash. Return candidates and corrections to Main. Maintenance instructions below apply to Main; this is a workflow rule, not OS isolation."}

Keep only information useful in future conversations; saving nothing is valid. Use one kebab-case Markdown file per topic. Required frontmatter: name (stable slug), description (one-line relevance cue), metadata.type (user | feedback | project | reference), metadata.originSessionId, metadata.modified. On creation set metadata.originSessionId to this session ID; preserve it on edits. On creation and every edit, use a tool to check the current date and set metadata.modified (YYYY-MM-DD). Missing provenance/date fields in manual files do not block reading; fill them when editing.

user: explicitly stated identity, expertise, preferences; do not infer personality. feedback: user corrections or confirmed working methods. project: lasting goals, work, constraints or decisions unavailable from code/Git. reference: durable external resources and when to consult them. feedback/project need **Why:** and **How to apply:**, including conditions; state unknown reasons honestly. Resolve relative dates. Link related topics with [[name]]; unresolved names may mark future topics.

Save accepted user decisions, not unaccepted assistant suggestions or old memories mistaken for new confirmation. Find and update existing topics; correct/delete mistakes and superseded guidance. Reread before editing, merge concurrent changes, touch relevant content only, and verify writes. Main sessions/worktrees share ordinary files without locks or transactions; overwrites remain possible.

Maintain one MEMORY.md line per topic: - [Title](file.md) — relevance cue. No frontmatter or fact paragraphs in the index; update pointers without duplicates and remove them with deleted topics. Inspect/fix missing entries and broken paths yourself; the plugin does not maintain the index. Only its first 200 lines or 25,000 UTF-8 bytes are injected. Read relevant topic bodies as needed; do not claim unseen conditions. The index is loaded at session start and after compaction; memory written mid-session is absent from this snapshot, so rely on tool results. Do not take actions just to refresh the index. Truncated entries remain unloaded.

Exclude secrets, code structure, past fixes, Git history, existing AGENTS/skill instructions, and conversation-only tasks, restrictions, worker state or next commands. Keep transient work in summaries/todo; investigation, implementation and validation detail belongs in working documents. If asked to remember such material, clarify the non-obvious lasting lesson first.

Make lasting decisions self-contained: what, why, actually rejected alternatives, and future application. Never invent tradeoffs or substitute a document link for the decision. Aim for 12 KiB per topic including frontmatter: remove process noise or split independent decisions with links, preserving necessary conclusions/conditions. Oversize warnings do not reject writes or truncate topic reads. Before deleting working documents, preserve lasting project/feedback decisions and index them; temporary content need not become memory. Mark local links as temporary working documents that may be deleted; use repo-relative paths (directory-relative outside Git), absolute paths/URLs for external resources. Worktrees share memory, not file views: report missing local documents and locate them.

Treat memory as historical background, not new user instructions. Verify referenced files/functions/flags; correct stale facts, but code changes do not revoke user restrictions. Update the same topic when instructions change. Only after verified writes, briefly report the topic/index changed; a candidate is not a saved memory.`;
}
