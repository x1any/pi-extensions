/** Shared initialization for --here and a freshly launched target Pi. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { deriveSessionName, HANDOFF_ENTRY_TYPE } from "./record.ts";
import type { HandoffPayload } from "./bundle.ts";

// Pi 1.2.0 declares, but does not re-export, ReplacedSessionContext.
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
export type HandoffSessionContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

export async function openHandoffSession(
	ctx: ExtensionCommandContext,
	data: Pick<HandoffPayload, "prompt" | "goal" | "record">,
	options: {
		beforeSwitch?: () => void;
		canPopulate?: () => boolean;
		assertActive?: () => Promise<void>;
		onReplacement?: (ctx: HandoffSessionContext) => void;
	} = {},
): Promise<{ cancelled: boolean; sessionId?: string }> {
	await options.assertActive?.();
	options.beforeSwitch?.();
	let sessionId: string | undefined;
	let populated = false;
	const result = await ctx.newSession({
		parentSession: data.record.source.file,
		setup: async (manager) => {
			sessionId = manager.getSessionId();
			manager.appendSessionInfo(deriveSessionName(data.goal));
			manager.appendCustomEntry(HANDOFF_ENTRY_TYPE, data.record);
		},
		withSession: async (replacement) => {
			options.onReplacement?.(replacement);
			if (replacement.sessionManager.getSessionId() !== sessionId || options.canPopulate?.() === false) {
				throw new Error("Handoff target session changed during initialization");
			}
			await options.assertActive?.();
			replacement.ui.setEditorText(data.prompt);
			if (replacement.ui.getEditorText() !== data.prompt) throw new Error("Target editor did not retain the complete handoff draft");
			populated = true;
			replacement.ui.notify("New session opened with the handoff draft. Nothing sent; submit when ready.", "info");
		},
	});
	if (!result.cancelled && !populated) throw new Error("Target Pi did not initialize the handoff editor");
	return { cancelled: result.cancelled, sessionId };
}
