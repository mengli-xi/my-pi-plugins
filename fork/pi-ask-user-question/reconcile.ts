/** Hide ask_user_question without UI without overriding the host's tool selection. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASK_USER_QUESTION_TOOL_NAME } from "./ask-user-question.ts";

/**
 * Pi 1.5's public active-tool API reports a selection, not a selection revision
 * or its owner. Even an unchanged list may be an explicit host/user decision.
 * Only remove the tool without UI; never infer permission to restore it. The
 * host/user must explicitly reactivate it, or a new session may initialize it.
 * RPC reports hasUI and keeps whichever tools the host selected.
 */
export function reconcileAskUserQuestionTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.hasUI) return;
	const active = pi.getActiveTools();
	if (active.includes(ASK_USER_QUESTION_TOOL_NAME)) {
		pi.setActiveTools(active.filter((name) => name !== ASK_USER_QUESTION_TOOL_NAME));
	}
}

/** Reconcile before Pi snapshots the active tools for the next run. */
export function registerAskUserQuestionReconciler(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (_event, ctx) => reconcileAskUserQuestionTool(pi, ctx));
}
