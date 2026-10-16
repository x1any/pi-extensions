/** Target-only bootstrap. Lifecycle handlers never call newSession themselves. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HandoffStore, type HandoffPackage } from "./bundle.ts";
import { openHandoffSession, type HandoffSessionContext } from "./session.ts";
import { INIT_FLAG, STORE_FLAG } from "./herdr.ts";

export const INITIALIZE_COMMAND = "pi-handoff-initialize";

export function registerHandoffInitialization(pi: ExtensionAPI): void {
	pi.registerFlag(INIT_FLAG, { type: "string", description: "Internal: one-shot handoff package ID (not a prompt)" });
	pi.registerFlag(STORE_FLAG, { type: "string", description: "Internal: private handoff store path" });
	let startupContext: ExtensionContext | undefined;
	let bootstrap: NodeJS.Immediate | undefined;
	let invoked = false;
	let invalidated = false;
	let ownReplacement = false;
	let sourceShutdown = false;

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "startup" && ctx.mode === "tui" && typeof pi.getFlag(INIT_FLAG) === "string") startupContext = ctx;
	});
	pi.on("resources_discover", () => {
		if (!startupContext || bootstrap || invoked) return;
		// Dispatch out of lifecycle handlers, after session_start has completed.
		// No CLI initialMessage exists: if this extension fails to load, no message
		// of any kind is submitted. Only a registered command is dispatched here.
		bootstrap = setImmediate(() => {
			bootstrap = undefined;
			if (invalidated) return;
			if (!pi.getCommands().some((command) => command.name === INITIALIZE_COMMAND)) {
				startupContext!.ui.notify("Handoff initializer is unavailable. No prompt was sent.", "error");
				return;
			}
			pi.sendUserMessage(`/${INITIALIZE_COMMAND}`, { expandPromptTemplates: true });
		});
	});
	pi.on("session_shutdown", (event) => {
		sourceShutdown = true;
		if (bootstrap) clearImmediate(bootstrap);
		bootstrap = undefined;
		startupContext = undefined;
		if (!ownReplacement || event.reason !== "new") invalidated = true;
	});

	pi.registerCommand(INITIALIZE_COMMAND, {
		description: "Internal: initialize a one-shot handoff draft; never submit it",
		handler: async (args, ctx) => {
			let ticket: HandoffPackage | undefined;
			let replacement: HandoffSessionContext | undefined;
			try {
				if (invoked) throw new Error("Handoff initialization was already attempted in this runtime");
				invoked = true;
				const id = pi.getFlag(INIT_FLAG);
				const root = pi.getFlag(STORE_FLAG);
				if (args.trim() || ctx.mode !== "tui" || !ctx.isIdle() || invalidated ||
					typeof id !== "string" || typeof root !== "string" ||
					process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
					throw new Error("Handoff initialization requires a dedicated interactive herdr target and valid startup flags");
				}
				if (ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) {
					throw new Error("Refusing to initialize handoff over an existing conversation");
				}
				const claimed = await new HandoffStore(root).claim(id, ctx.cwd, process.env.HERDR_PANE_ID);
				ticket = claimed.ticket;
				const assertActive = async () => {
					if (invalidated) throw new Error("Target Pi changed sessions during handoff initialization");
					await claimed.ticket.assertActive();
				};
				await assertActive();
				// A cancelled switch also leaves a usable draft in this initial session.
				ctx.ui.setEditorText(claimed.payload.prompt);
				const result = await openHandoffSession(ctx, claimed.payload, {
					beforeSwitch: () => { ownReplacement = true; },
					assertActive,
					onReplacement: (fresh) => { replacement = fresh; },
				});
				if (result.cancelled || !result.sessionId) throw new Error("Target handoff session creation was cancelled");
				await assertActive();
				if (!replacement || replacement.sessionManager.getSessionId() !== result.sessionId || replacement.ui.getEditorText() !== claimed.payload.prompt) {
					throw new Error("Target handoff session or editor changed before acknowledgement");
				}
				await ticket.acknowledge({
					status: "ready", paneId: process.env.HERDR_PANE_ID, sessionId: result.sessionId,
					sessionFile: replacement.sessionManager.getSessionFile(),
				});
			} catch (error) {
				let acknowledgementError: unknown;
				if (ticket) {
					try { await ticket.acknowledge({ status: "failed" }); }
					catch (failure) { acknowledgementError = failure; }
				}
				const message = `Handoff initialization failed: ${error instanceof Error ? error.message : String(error)}${acknowledgementError ? "; failure receipt could not be written (source may have revoked the package)" : ""}. Nothing sent.`;
				if (replacement && !invalidated) replacement.ui.notify(message, "error");
				else if (!sourceShutdown && !invalidated) ctx.ui.notify(message, "error");
				else console.error(message);
			}
		},
	});
}
