/**
 * Handoff extension - transfer context to a new focused session.
 *
 * Adapted from:
 * https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/handoff.ts
 *
 * Upstream copyright and MIT license are preserved in ../LICENSE.
 * The generated prompt is reviewed before opening a new session, and remains
 * a draft until the user submits it. New sessions receive a goal-derived name
 * and a compact provenance card (a custom entry outside LLM context).
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type UserMessage, uuidv7 } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	ExtensionEditorComponent,
	getAgentDir,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

import {
	buildHandoffRecord,
	HANDOFF_ENTRY_TYPE,
	type HandoffRecordData,
	readHandoffChain,
	renderHandoffCard,
} from "./record.ts";
import { deliverHandoff } from "./delivery.ts";
import { registerHandoffInitialization } from "./init.ts";
import { parseHandoffArgs } from "./options.ts";
import { HandoffStore } from "./bundle.ts";
import { openHandoffSession } from "./session.ts";
import { HerdrClient, herdrEnvironment } from "./herdr.ts";

const SYSTEM_PROMPT = `你是一名上下文交接助手。请根据对话历史和用户的新会话目标，生成一份聚焦任务的提示词，满足以下要求：

1. 概括对话中与目标相关的上下文（已作出的决策、采用的方法、关键发现）
2. 列出讨论或修改过的相关文件
3. 根据用户目标明确说明下一步任务
4. 内容完整、可独立使用，让新会话无需查看旧对话即可继续工作

将回复写成用户可直接发送以开始新会话的提示词。使用中文撰写，代码、命令和文件路径保留原文。简明扼要，但包含所有必要的上下文。不要添加“以下是提示词”等开场白，只输出提示词本身。

输出格式示例：
## 上下文
我们一直在处理 X。关键决策：
- 决策 1
- 决策 2

涉及的文件：
- path/to/file1.ts
- path/to/file2.ts

## 任务
[根据用户目标清楚描述接下来要做的事情]`;

/** Height cap for a bottom panel, leaving room for Pi's surrounding UI. */
const PANEL_MAX_HEIGHT_PERCENT = 92;
/** Rows reserved below the panel for Pi's editor/footer. */
const PANEL_RESERVED_ROWS = 2;

/** Maximum panel rows within the terminal height minus the reserved rows. */
function panelRowBudget(termRows: number): number {
	const capped = Math.floor((termRows * PANEL_MAX_HEIGHT_PERCENT) / 100);
	const available = Math.max(1, termRows - PANEL_RESERVED_ROWS);
	return Math.max(1, Math.min(capped, available));
}

type HandoffResult =
	| { status: "ok"; prompt: string }
	| { status: "cancelled" }
	| { status: "error"; message: string };

type HandoffOperation = {
	controller: AbortController;
	cancelUI?: () => void;
	allowReplacement: boolean;
};

export default function handoffExtension(pi: ExtensionAPI) {
	let activeOperation: HandoffOperation | undefined;
	registerHandoffInitialization(pi);

	// Provenance cards stay out of LLM context; they only render in the TUI.
	pi.registerEntryRenderer<HandoffRecordData>(HANDOFF_ENTRY_TYPE, renderHandoffCard);

	pi.on("session_shutdown", (event) => {
		const operation = activeOperation;
		if (!operation) return;

		// Shutdown runs before Pi invalidates the old context. Close our UI now,
		// not from a late provider response after another session/UI has taken over.
		operation.allowReplacement &&= event.reason === "new";
		operation.controller.abort();
		operation.cancelUI?.();
		if (!operation.allowReplacement && activeOperation === operation) activeOperation = undefined;
	});

	pi.registerCommand("handoff", {
		description: "Hand off a reviewed draft to a new herdr tab (--split right|down, --here)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				const message = "handoff requires interactive mode";
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else console.error(message);
				return;
			}

			if (activeOperation) {
				ctx.ui.notify("A handoff is already in progress. Finish or cancel it before starting another.", "info");
				return;
			}

			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			let parsed: ReturnType<typeof parseHandoffArgs>;
			let herdr: HerdrClient | undefined;
			try {
				parsed = parseHandoffArgs(args);
				if (parsed.destination !== "here") herdr = new HerdrClient(herdrEnvironment());
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const { goal, destination } = parsed;

			// Acquire before the first await; Pi can invoke commands concurrently while busy.
			const operation: HandoffOperation = { controller: new AbortController(), allowReplacement: false };
			activeOperation = operation;
			const isValid = () => activeOperation === operation && !operation.controller.signal.aborted;

			try {
				// Wait for finalized messages and tool results before taking the snapshot.
				try {
					if (!ctx.isIdle()) {
						ctx.ui.notify("Waiting for the current task to finish. Handoff will not interrupt it.", "info");
					}
					await ctx.waitForIdle();
				} catch (error: unknown) {
					if (!isValid()) return;
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Handoff preparation failed: ${message}`, "error");
					return;
				}
				if (!isValid()) return;

				// Reuse Pi's active-branch projection, including compaction summaries
				// and retained messages, rather than copying session traversal logic.
				const { messages } = buildSessionContext(
					ctx.sessionManager.getEntries(),
					ctx.sessionManager.getLeafId(),
				);
				const conversationText = serializeConversation(convertToLlm(messages));

				if (!conversationText.trim()) {
					ctx.ui.notify("No conversation to hand off", "error");
					return;
				}

				const currentSessionFile = ctx.sessionManager.getSessionFile();
				const userMessage: UserMessage = {
					role: "user",
					content: [
						{
							type: "text",
							text: `## 对话历史\n\n${conversationText}\n\n## 用户的新会话目标\n\n${goal}`,
						},
					],
					timestamp: Date.now(),
				};

				const result = await ctx.ui.custom<HandoffResult>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, "Generating handoff draft...");
					const signal = AbortSignal.any([operation.controller.signal, loader.signal]);
					const finish = (value: HandoffResult) => {
						if (operation.cancelUI !== cancelUI) return;
						operation.cancelUI = undefined;
						// Also covers shutdown before Pi has mounted the returned component.
						loader.dispose();
						done(value);
					};
					const cancelUI = () => finish({ status: "cancelled" });
					operation.cancelUI = cancelUI;
					loader.onAbort = cancelUI;

					const doGenerate = async (): Promise<HandoffResult> => {
						// Use the registry's simple streaming API with the generation-only options.
						const response = await ctx.modelRegistry
							.streamSimple(
								model,
								{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
								{ signal, cacheRetention: "none", sessionId: uuidv7() },
							)
							.result();

						if (signal.aborted || response.stopReason === "aborted") {
							return { status: "cancelled" };
						}
						if (response.stopReason === "error") {
							return { status: "error", message: response.errorMessage ?? "LLM error" };
						}

						const prompt = response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("\n");

						if (!prompt.trim()) {
							return { status: "error", message: "No handoff prompt received" };
						}
						return { status: "ok", prompt };
					};

					doGenerate()
						.then((value) => { if (isValid()) finish(value); })
						.catch((error: unknown) => {
							if (!isValid()) return;
							finish(signal.aborted
								? { status: "cancelled" }
								: { status: "error", message: error instanceof Error ? error.message : String(error) });
						});

					return loader;
				}, {
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						// Keep Pi's bottom rows visible below the panel.
						margin: { bottom: PANEL_RESERVED_ROWS },
					},
				});
				if (!isValid()) return;

				if (result.status === "cancelled") {
					ctx.ui.notify("Handoff generation cancelled. No new session was created.", "info");
					return;
				}
				if (result.status === "error") {
					ctx.ui.notify(`Handoff generation failed: ${result.message}`, "error");
					return;
				}

				const editedPrompt = await ctx.ui.custom<string | undefined>((tui, _theme, kb, done) => {
					const finish = (value: string | undefined) => {
						if (operation.cancelUI !== cancelUI) return;
						operation.cancelUI = undefined;
						done(value);
					};
					const cancelUI = () => finish(undefined);
					operation.cancelUI = cancelUI;
					const editor = new ExtensionEditorComponent(
						tui, kb,
						`Review handoff draft (confirm: ${destination === "here" ? "same pane" : destination === "tab" ? "new herdr tab" : `split ${destination}`}; does not send)`,
						result.prompt, finish, cancelUI,
						{ description: "External editor is disabled here to protect pasted text (Pi 1.2.0)." },
					);
					// A bottom panel taller than its budget is clamped to the top of
					// the terminal, which would hide the hint and the editor cursor.
					// Clip from the top instead: keep the editor and its chrome.
					const renderEditor = editor.render.bind(editor);
					editor.render = (width: number): string[] => {
						const lines = renderEditor(width);
						const budget = panelRowBudget(tui.terminal.rows ?? 24);
						return lines.length > budget
							? lines.slice(lines.length - budget)
							: lines;
					};
					const handleInput = editor.handleInput.bind(editor);
					editor.handleInput = (data) => {
						if (!isValid() || operation.cancelUI !== cancelUI) return;
						// Keep Pi's cancel-key precedence, including customized bindings.
						if (!getKeybindings().matches(data, "tui.select.cancel") && kb.matches(data, "app.editor.external")) {
							ctx.ui.notify("External editor is disabled in handoff review: Pi 1.2.0 can lose collapsed paste content. Edit here or in the new session instead.", "warning");
							return;
						}
						handleInput(data);
					};
					return editor;
				}, {
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						// Keep Pi's bottom rows visible below the panel.
						margin: { bottom: PANEL_RESERVED_ROWS },
					},
				});
				if (!isValid()) return;

				if (editedPrompt === undefined) {
					ctx.ui.notify("Handoff review cancelled. No new session was created.", "info");
					return;
				}
				if (!editedPrompt.trim()) {
					ctx.ui.notify("Handoff prompt is empty. No new session was created.", "warning");
					return;
				}

				// Capture provenance from the outgoing session before switching. Only this
				// compact metadata reaches the new session, never the old transcript or
				// cards. The chain follows the active branch, so a fork of a common source
				// yields source -> this session without borrowing a sibling's history.
				const record = buildHandoffRecord({
					goal,
					source: {
						id: ctx.sessionManager.getSessionId(),
						name: ctx.sessionManager.getSessionName(),
						file: currentSessionFile,
					},
					inheritedChain: readHandoffChain(ctx.sessionManager.getBranch()),
				});
				const data = { prompt: editedPrompt, goal, record };
				const previousDraft = ctx.ui.getEditorText();
				// Keep a local copy before any external side effect. On failure it stays
				// here; on success restore the old draft only if the user did not edit it.
				ctx.ui.setEditorText(editedPrompt);
				if (destination !== "here") {
					ctx.ui.setStatus("pi-handoff", "Opening handoff in herdr…");
					try {
						const target = await deliverHandoff({
							payload: { ...data, cwd: ctx.cwd, configuration: "target-defaults" },
							destination,
							store: new HandoffStore(join(getAgentDir(), "handoffs")),
							herdr: herdr!,
							extension: fileURLToPath(new URL("../index.ts", import.meta.url)),
							signal: operation.controller.signal,
							hasDraftBackup: () => isValid() && ctx.ui.getEditorText() === editedPrompt,
						});
						if (!isValid()) return;
						if (ctx.ui.getEditorText() === editedPrompt) ctx.ui.setEditorText(previousDraft);
						ctx.ui.notify(`Handoff draft ready in ${target.paneId}. Nothing sent; source session unchanged.`, "info");
					} finally {
						if (isValid()) ctx.ui.setStatus("pi-handoff", undefined);
					}
					return;
				}

				// Only an explicit --here replaces the source session. Use a fresh
				// withSession context after the old runtime has shut down.
				const newSessionResult = await openHandoffSession(ctx, data, {
					beforeSwitch: () => { operation.allowReplacement = true; },
					canPopulate: () => operation.allowReplacement,
				});
				if (isValid() && newSessionResult.cancelled) {
					ctx.ui.notify("Handoff session switch cancelled. Reviewed draft retained in the current editor.", "info");
				}
			} catch (error: unknown) {
				// Before replacement we can report via the original UI. After shutdown
				// the host owns fatal switch errors; never touch the stale ctx/pi.
				if (!isValid()) throw error;
				ctx.ui.notify(`Handoff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				operation.controller.abort();
				operation.cancelUI?.();
				// A late old waiter must not release a newer operation's lock.
				if (activeOperation === operation) activeOperation = undefined;
			}
		},
	});
}
