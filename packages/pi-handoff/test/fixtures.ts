import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HandoffSessionContext } from "../src/session.ts";
import { HandoffStore, type HandoffPayload } from "../src/bundle.ts";

export function payload(): HandoffPayload {
	return {
		prompt: "## 上下文\n已审阅的完整草稿\n\n## 任务\n不自动提交\n",
		goal: "继续实现",
		record: { goal: "继续实现", source: { id: "source-id", name: "来源" }, chain: [{ id: "source-id" }], createdAt: Date.now() },
		cwd: process.cwd(),
		configuration: "target-defaults",
	};
}

export async function withStore(run: (store: HandoffStore) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-handoff-test-"));
	try { await run(new HandoffStore(join(root, "store"))); }
	finally { await rm(root, { recursive: true, force: true }); }
}

export function fakeSession(cancelled = false) {
	const state = { text: "", original: "", name: "", entries: [] as unknown[], switches: 0, notices: [] as string[], parent: undefined as string | undefined };
	const ui = {
		setEditorText: (text: string) => { state.text = text; },
		getEditorText: () => state.text,
		notify: (message: string) => { state.notices.push(message); },
	};
	const manager = {
		getSessionId: () => "target-session",
		getSessionFile: () => undefined,
		appendSessionInfo: (name: string) => { state.name = name; },
		appendCustomEntry: (type: string, data: unknown) => { state.entries.push({ type, data }); },
	};
	const replacement = { mode: "tui", ui, sessionManager: manager } as unknown as HandoffSessionContext;
	const ctx = {
		mode: "tui", hasUI: true, cwd: process.cwd(),
		ui: { ...ui, setEditorText: (text: string) => { state.original = text; }, getEditorText: () => state.original },
		isIdle: () => true,
		sessionManager: { getEntries: () => [] },
		newSession: async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
			state.switches++;
			if (cancelled) return { cancelled: true };
			state.parent = options?.parentSession;
			// Replacement UI is deliberately distinct from the original editor.
			await options?.setup?.(manager as never);
			await options?.withSession?.(replacement);
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, replacement, state };
}
