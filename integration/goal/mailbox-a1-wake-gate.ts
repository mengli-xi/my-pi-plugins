import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindMailbox, type MailboxHolder } from "pi-session-inject/mailbox-v1";

/** A test-only receive/release barrier around PUBLIC source callbacks. The real
 * A runtime/store/native send path is unchanged; business guards always run. */
export default function (pi: ExtensionAPI) {
	const bootstrap = bindMailbox(pi);
	const holder = (globalThis as unknown as Record<symbol, MailboxHolder>)[
		Symbol.for("pi.session-inject.mailbox.v1")
	];
	bootstrap.close();
	const original = holder.bind;
	let mainSession: string | undefined;
	const gate = join(process.env.GOAL_JOINT_BARRIER_DIR ?? "", "wake-open");
	holder.bind = (api, options) => {
		const binding = original.call(holder, api, options);
		return {
			close: () => binding.close(),
			registerProducer(registration) {
				return binding.registerProducer({
					...registration,
					async checkCurrent(mail, point, fence) {
						const decision = await registration.checkCurrent(mail, point, fence);
						return fence.session.id === mainSession &&
							decision.kind === "allow" &&
							!existsSync(gate)
							? { ...decision, wake: false }
							: decision;
					},
				});
			},
		};
	};
	pi.on("session_start", (_event, ctx) => {
		mainSession = ctx.sessionManager.getSessionId();
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (
			ctx.sessionManager.getSessionId() === mainSession &&
			event.messageType === "custom" &&
			event.message.customType === "agent-mailbox-trigger-v1" &&
			existsSync(gate)
		)
			unlinkSync(gate);
	});
	pi.on("session_shutdown", () => {
		holder.bind = original;
	});
}
