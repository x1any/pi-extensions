import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	truncateHead,
	truncateTail,
	type AgentSession,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ThinkingLevel } from "./agents.ts";
import { isBuiltinToolName } from "./agents.ts";
import { resolveAgentExtensions } from "./extensions.ts";

const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;
const ABORT_GRACE_MS = 5000;

type FailureKind = "cancelled" | "timeout" | "startup" | "authentication" | "model"
	| "protocol" | "no-answer" | "cleanup";

export class SubagentError extends Error {
	constructor(public readonly kind: FailureKind, message: string) {
		super(`[${kind}] ${message}`);
		this.name = "SubagentError";
	}
}

export type RunState = "waiting" | "starting" | "running" | "tool" | "retrying" | "finishing"
	| "completed" | "cancelled" | "timed_out" | "failed";

export interface RunProgress {
	state: RunState;
	lastTool?: string;
}

export interface RunRequest {
	agent: AgentConfig;
	task: string;
	cwd: string;
	projectTrusted: boolean;
	provider: string;
	modelId: string;
	thinking: ThinkingLevel;
	signal?: AbortSignal;
	onProgress?: (progress: RunProgress) => void;
}

export interface RunResult {
	text: string;
	lastTool?: string;
	truncated: boolean;
	fullOutputPath?: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cancellation(signal: AbortSignal): SubagentError {
	return signal.reason instanceof SubagentError
		? signal.reason
		: new SubagentError("cancelled", "子 Agent 调用已取消。");
}

function checkCancelled(signal: AbortSignal): void {
	if (signal.aborted) throw cancellation(signal);
}

function diagnostic(text: string): string {
	const result = truncateTail(text.trim(), { maxBytes: 8 * 1024, maxLines: 80 });
	return `${result.truncated ? "[仅保留诊断末尾]\n" : ""}${result.content}`;
}

function isAuthFailure(text: string): boolean {
	return /\b(401|403|unauthorized|unauthenticated)\b|authentication|no api key|api key.*(missing|invalid|not found)|oauth|not logged in|credentials.*(missing|expired|invalid)/i.test(text);
}

function emit(request: RunRequest, state: RunState, lastTool?: string): void {
	try {
		request.onProgress?.({ state, lastTool });
	} catch {
		// 展示失败不能中断会话释放或执行槽回收。
	}
}

async function waitForSlot(slot: Promise<void>, signal: AbortSignal): Promise<void> {
	checkCancelled(signal);
	let onAbort: () => void = () => {};
	try {
		await Promise.race([
			slot,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(cancellation(signal));
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}),
		]);
		checkCancelled(signal);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

interface FinalAnswer {
	text: string;
	stopReason: string;
	errorMessage?: string;
	hasToolCalls: boolean;
}

/**
 * 在父进程内创建一个独立的 Pi 会话。
 *
 * 与旧版 spawn 一个 `pi --mode json --print` 子进程等价：全新上下文、无持久会话、不自动发现扩展与技能，
 * 只按 Agent 配置启用工具白名单、显式加载声明的扩展，并追加角色正文作为系统提示。
 * 不复制父会话内存态的 provider、认证和扩展工具；这些仍由普通 Pi 配置在子运行时中解析。
 */
async function createChildSession(request: RunRequest): Promise<AgentSession> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(request.cwd, agentDir, { projectTrusted: request.projectTrusted });
	let modelRuntime: ModelRuntime;
	try {
		modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
	} catch (error) {
		throw new SubagentError("startup", `无法初始化子会话模型运行时：${errorText(error)}`);
	}
	// 与 CLI 的 --provider/--model 走同一套解析；子运行时不认识的 provider/model 在启动前失败。
	const resolved = resolveCliModel({
		cliProvider: request.provider,
		cliModel: `${request.provider}/${request.modelId}`,
		modelRuntime,
	});
	if (resolved.error || !resolved.model) {
		throw new SubagentError("model", resolved.error ?? `子会话模型目录中不存在 ${request.provider}/${request.modelId}。`);
	}
	let extensionPaths: string[] = [];
	if (request.agent.extensions.length > 0) {
		let missing: string[] = [];
		try {
			const resolution = await resolveAgentExtensions(request.agent.extensions, {
				cwd: request.cwd, agentDir, settingsManager,
			});
			extensionPaths = resolution.paths;
			missing = resolution.missing;
		} catch (error) {
			throw new SubagentError("startup", `无法解析 Agent 声明的扩展：${errorText(error)}`);
		}
		if (missing.length > 0) {
			throw new SubagentError("startup", `Agent 声明的扩展不可用：[${missing.join(", ")}]。本扩展不会自动安装；请确认包来源已安装（写成 npm:xxx 或 git:xxx）、未被包过滤禁用，或改用已存在的本地路径。`);
		}
	}
	const loader = new DefaultResourceLoader({
		cwd: request.cwd,
		agentDir,
		settingsManager,
		// 等价于旧版的 --no-extensions --no-skills --no-prompt-templates --no-themes：
		// 不做环境发现，只加载 Agent 显式声明的扩展；也不会在同一进程里再加载一份本扩展。
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalExtensionPaths: extensionPaths,
		// 显式空值加 override，只追加角色正文，不读取 APPEND_SYSTEM.md，也不把正文当成文件路径。
		appendSystemPrompt: [],
		appendSystemPromptOverride: () => (request.agent.systemPrompt.trim() ? [request.agent.systemPrompt] : []),
	});
	try {
		await loader.reload();
	} catch (error) {
		throw new SubagentError("startup", `子会话资源加载失败：${errorText(error)}`);
	}
	const extensionErrors = loader.getExtensions().errors.filter((error) => isDeclaredExtensionPath(error.path, extensionPaths));
	if (extensionErrors.length > 0) {
		throw new SubagentError("startup", `声明的扩展加载失败：${extensionErrors.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
	}
	let session: AgentSession;
	try {
		({ session } = await createAgentSession({
			cwd: request.cwd,
			agentDir,
			modelRuntime,
			model: resolved.model,
			thinkingLevel: request.thinking,
			// 空数组表示不启用任何工具；非空数组是白名单，包含扩展工具名，但名字本身不加载扩展。
			tools: request.agent.tools,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(request.cwd),
			settingsManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		}));
	} catch (error) {
		throw new SubagentError("startup", `创建子会话失败：${errorText(error)}`);
	}
	// print 模式：没有交互式 UI，已加载的扩展只能走无界面路径。
	await session.bindExtensions({ mode: "print" });
	checkDeclaredTools(request, session);
	return session;
}

function isDeclaredExtensionPath(path: string, declared: string[]): boolean {
	const target = path.replace(/\\/gu, "/");
	return declared.some((root) => {
		const base = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
		return target === base || target.startsWith(`${base}/`);
	});
}

/** Pi 的工具白名单会静默忽略未注册的名字，所以在启动前对照子会话注册表校验。 */
function checkDeclaredTools(request: RunRequest, session: AgentSession): void {
	const provided = new Set(session.getAllTools().map((tool) => tool.name));
	const missing = request.agent.tools.filter((name) => !provided.has(name));
	if (missing.length === 0) return;
	const fromExtensions = [...new Set(session.extensionRunner.getAllRegisteredTools()
		.map((tool) => tool.definition.name)
		.filter((name) => !isBuiltinToolName(name)))];
	const hint = request.agent.extensions.length === 0
		? "该 Agent 未声明 extensions；扩展工具需要在 tools 列出名字，并在 extensions 中声明已安装的来源。"
		: fromExtensions.length > 0
			? `已加载扩展注册的工具：[${fromExtensions.join(", ")}]。`
			: "已声明的扩展没有注册任何工具，请检查扩展自身的启用条件。";
	throw new SubagentError("startup", `子会话缺少 Agent 声明的工具：[${missing.join(", ")}]。${hint}`);
}

async function runSession(request: RunRequest, signal: AbortSignal): Promise<{ text: string; lastTool?: string }> {
	checkCancelled(signal);
	const session = await createChildSession(request);
	checkCancelled(signal);

	let answer: FinalAnswer | undefined;
	let lastTool: string | undefined;
	let failure: SubagentError | undefined;
	let promptFailure: unknown;
	let abandoned = false;

	const fail = (error: SubagentError) => {
		failure ??= error;
		void session.abort().catch(() => {});
	};
	const handleEvent = (event: AgentSessionEvent): void => {
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant") {
			const message = event.message;
			if (message.provider !== request.provider || message.model !== request.modelId) {
				fail(new SubagentError("model", `子会话选择了 ${message.provider}/${message.model}，而非要求的 ${request.provider}/${request.modelId}；拒绝模型回退。`));
				return;
			}
			if (event.type === "message_start") {
				answer = undefined;
				emit(request, "running", lastTool);
				return;
			}
			const text: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") text.push(block.text);
			}
			answer = {
				text: text.join("\n\n"), stopReason: message.stopReason, errorMessage: message.errorMessage,
				hasToolCalls: message.content.some((block) => block.type === "toolCall"),
			};
			return;
		}
		if (event.type === "tool_execution_start") {
			if (!request.agent.tools.includes(event.toolName)) {
				fail(new SubagentError("protocol", `子会话尝试调用白名单外工具 ${event.toolName}。`));
				return;
			}
			lastTool = event.toolName;
			emit(request, "tool", lastTool);
			return;
		}
		if (event.type === "tool_execution_end" || event.type === "agent_start") {
			emit(request, "running", lastTool);
			return;
		}
		if (event.type === "auto_retry_start") {
			answer = undefined;
			emit(request, "retrying", lastTool);
			return;
		}
		if (event.type === "agent_end") emit(request, "finishing", lastTool);
	};

	// 事件来自 SDK 的类型化对象；订阅回调仍包一层，避免任何意外异常逃逸到 Pi 的事件总线。
	const unsubscribe = session.subscribe((event) => {
		if (failure) return;
		try {
			handleEvent(event);
		} catch (error) {
			fail(new SubagentError("protocol", `无法处理子会话事件：${diagnostic(errorText(error))}`));
		}
	});
	const abortSession = () => { void session.abort().catch(() => {}); };
	signal.addEventListener("abort", abortSession, { once: true });

	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let armGrace: (() => void) | undefined;
	try {
		if (signal.aborted) abortSession();
		const run = session.prompt(request.task).catch((error: unknown) => { promptFailure = error; });
		// 取消或超时后给 abort 一个宽限窗口；仍未结束就放弃等待，改由 dispose 释放会话。
		await Promise.race([
			run,
			new Promise<void>((resolve) => {
				armGrace = () => {
					graceTimer = setTimeout(() => {
						abandoned = true;
						resolve();
					}, ABORT_GRACE_MS);
				};
				if (signal.aborted) armGrace();
				else signal.addEventListener("abort", armGrace, { once: true });
			}),
		]);
	} finally {
		clearTimeout(graceTimer);
		if (armGrace) signal.removeEventListener("abort", armGrace);
		signal.removeEventListener("abort", abortSession);
		unsubscribe();
		// 没有扩展加载，无需广播 session_shutdown；dispose 只释放监听器和 agent 连接。
		if (abandoned) await session.abort().catch(() => {});
		session.dispose();
	}

	if (failure) throw failure;
	checkCancelled(signal);
	const errors = diagnostic([
		answer?.errorMessage,
		promptFailure === undefined ? "" : errorText(promptFailure),
		abandoned ? "子会话未在取消宽限期内结束。" : "",
	].filter(Boolean).join("\n"));
	if (promptFailure !== undefined || answer?.stopReason === "error") {
		if (isAuthFailure(errors)) throw new SubagentError("authentication", errors);
		throw new SubagentError("model", errors || "模型请求失败。");
	}
	if (answer?.stopReason === "aborted") throw new SubagentError("cancelled", errors || "子模型已中止。");
	if (answer?.stopReason === "length") throw new SubagentError("model", "模型达到输出长度上限，未将不完整回答当作成功结果。");
	if (!answer || answer.stopReason !== "stop" || answer.hasToolCalls || !answer.text.trim()) {
		throw new SubagentError("no-answer", `子会话没有有效的最终文本回答（stopReason=${answer?.stopReason ?? "none"}）。\n${errors}`);
	}
	return { text: answer.text, lastTool };
}

export class SubagentRunner {
	private readonly lifetime = new AbortController();
	private slot: Promise<void> = Promise.resolve();
	private readonly calls = new Set<Promise<RunResult>>();
	private readonly retainedDirs = new Set<string>();
	private shutdownPromise?: Promise<void>;

	run(request: RunRequest): Promise<RunResult> {
		const signal = AbortSignal.any([this.lifetime.signal, ...(request.signal ? [request.signal] : [])]);
		const previous = this.slot;
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		// 取消等待者只释放自己的位置，不能越过仍在执行的前一个任务。
		this.slot = previous.then(() => current);
		const call = (async () => {
			try {
				emit(request, "waiting");
				await waitForSlot(previous, signal);
				return await this.execute(request, signal);
			} catch (error) {
				if (error instanceof SubagentError && error.kind === "cleanup") this.lifetime.abort(error);
				throw error;
			} finally {
				release();
			}
		})();
		this.calls.add(call);
		void call.then(() => this.calls.delete(call), () => this.calls.delete(call));
		return call;
	}

	private async execute(request: RunRequest, parentSignal: AbortSignal): Promise<RunResult> {
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(new SubagentError("timeout", "执行超过固定的 10 分钟上限。")), EXECUTION_TIMEOUT_MS);
		const signal = AbortSignal.any([parentSignal, timeout.signal]);
		try {
			checkCancelled(signal);
			emit(request, "starting");
			const output = await runSession(request, signal);
			checkCancelled(signal);
			if (!truncateHead(output.text).truncated) return { text: output.text, lastTool: output.lastTool, truncated: false };
			return await this.retainFullOutput(output, signal);
		} finally {
			clearTimeout(timer);
		}
	}

	/** 只按需创建临时目录：没有截断就不留任何文件。 */
	private async retainFullOutput(output: { text: string; lastTool?: string }, signal: AbortSignal): Promise<RunResult> {
		let dir: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "pi-subagents-"));
			const fullOutputPath = join(dir, "result.md");
			await writeFile(fullOutputPath, output.text, { encoding: "utf8", mode: 0o600 });
			this.retainedDirs.add(dir);
			checkCancelled(signal);
			const notice = `[结果已截断。完整回答：${fullOutputPath}；保留至父会话关闭、切换或 /reload。]\n\n`;
			const preview = truncateHead(output.text, {
				maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
				maxLines: DEFAULT_MAX_LINES - notice.split("\n").length,
			});
			return { text: notice + preview.content, lastTool: output.lastTool, truncated: true, fullOutputPath };
		} catch (error) {
			// 取消等已知失败保留临时目录，由 shutdown 统一清理。
			if (error instanceof SubagentError) throw error;
			if (dir) {
				try {
					await rm(dir, { recursive: true, force: true });
				} catch {
					this.retainedDirs.add(dir);
				}
			}
			throw new SubagentError("cleanup", `无法保存完整回答：${errorText(error)}`);
		}
	}

	shutdown(): Promise<void> {
		this.shutdownPromise ??= (async () => {
			this.lifetime.abort(new SubagentError("cancelled", "父会话已关闭、切换或重载。"));
			await Promise.allSettled([...this.calls]);
			const failures: string[] = [];
			for (const dir of this.retainedDirs) {
				try {
					await rm(dir, { recursive: true, force: true });
					this.retainedDirs.delete(dir);
				} catch (error) {
					failures.push(`${dir}: ${errorText(error)}`);
				}
			}
			if (failures.length) throw new SubagentError("cleanup", failures.join("\n"));
		})();
		return this.shutdownPromise;
	}
}
