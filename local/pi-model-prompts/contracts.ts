/**
 * The system-prompt fragment contract. Owner: pi-model-prompts.
 *
 * One package assembles every system-prompt addition so injections cannot
 * fight over the tail of the prompt or silently double up. Contributors do
 * NOT import this file — per the workspace's event-bus convention they copy
 * the channel string and the payload shape and annotate the owner, so load
 * order and bundling stay irrelevant. See 根 AGENTS.md 的能力协议表.
 *
 * The handshake is pull-based: the owner emits the request synchronously at
 * `before_agent_start`, contributors call `contribute()` during that emit,
 * and the owner appends what it collected. There is no cache to invalidate
 * and no registration order to get right — a contributor that loads later
 * simply participates in the next turn.
 */

/** Channel the owner emits on, once per agent run. */
export const PROMPT_FRAGMENTS_CHANNEL = "prompt:fragments-v1";

export interface PromptFragmentsRequest {
  /** Active model id; undefined when no model is resolved. */
  model: string | undefined;
  /** Active thinking level, when the session runtime provides one. */
  thinkingLevel: string | undefined;
  /**
   * Tool names this turn's system prompt was built with. A fragment that
   * instructs the model to use a tool MUST check the tool is here first —
   * telling a model to call a tool that is not registered is how runs derail.
   */
  selectedTools: readonly string[] | undefined;
  /**
   * Add one fragment. Empty text is ignored; a repeated key replaces its
   * earlier value. Fragments are appended in key order, after the model's own
   * `model-prompts/<model-id>.md` block, so ordering is deterministic across
   * runs regardless of which extension answered first.
   */
  contribute(key: string, text: string): void;
}
