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
import { isBuiltinToolName, isReadOnlyAgent } from "./agents.ts";
import { resolveAgentExtensions, normalizeSource } from "./extensions.ts";

const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;
const ABORT_GRACE_MS = 5000;

/**
 * 默认在子会话里加载的扩展来源：Agent 不用在 frontmatter 里声明。
 * 只放随 pi 提供检索/只读能力的来源；来源缺失（未安装、未启用）时静默跳过，子会话退回 Pi 内置工具
 * （pi-fff 处于 `override` 模式时，它覆盖的就是内置名 `grep`/`find`，所以回退不需要换工具名）。
 * 加载失败（来源存在但自身报错）仍然报错，不静默降级。
 */
const DEFAULT_CHILD_EXTENSIONS = ["npm:@ff-labs/pi-fff"];

/** 父会话内只读子任务的并发上限：同一并行调用内的任务与模型并行发出的多个单任务调用共用这一个池。 */
export const MAX_CONCURRENCY = 3;

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

/** 调度视图：并发上限、在跑数与排队数。展示层直接回填，不做推导。 */
export interface ConcurrencyView {
	limit: number;
	active: number;
	queued: number;
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

/**
 * 等待调度器发槽。等待期间可取消，取消只释放自己的排队位置（由调用方的 finally 回收槽位），
 * 不影响前面仍在执行的任务。
 */
async function waitForSlot(ready: Promise<void>, signal: AbortSignal): Promise<void> {
	checkCancelled(signal);
	let onAbort: () => void = () => {};
	try {
		await Promise.race([
			ready,
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

/** 读任务共享并发槽；只读判定见 isReadOnlyAgent，未验证（可能写盘）的任务独占整个池。 */
type SlotKind = "shared" | "exclusive";

interface Waiter {
	kind: SlotKind;
	admitted: boolean;
	grant: () => void;
}

/**
 * 有界并发池：读任务最多 limit 个同时运行，未验证任务需要整个池空闲并立即独占。
 *
 * 持有者是 runner 单例，所以上限作用于父会话内的全部 subagent 调用，而不是某一个 tasks 数组。
 * 队列严格 FIFO：排在独占任务后面的读任务也不会被放行，因此写任务不会饥饿。
 */
class SlotPool {
	private readonly queue: Waiter[] = [];
	private active = 0;
	private exclusiveRunning = false;

	constructor(private readonly limit: number) {}

	get view(): ConcurrencyView {
		return { limit: this.limit, active: this.active, queued: this.queue.length };
	}

	/**
	 * 排队索取一个槽位。返回的 release 幂等：还在排队时表示取消排队，已获得槽位时表示释放槽位。
	 * 因此调用方只需在 finally 里调用一次，取消和正常结束共用同一条回收路径。
	 */
	acquire(kind: SlotKind): { ready: Promise<void>; release: () => void } {
		let grant!: () => void;
		const ready = new Promise<void>((resolve) => { grant = resolve; });
		const waiter: Waiter = { kind, admitted: false, grant };
		this.queue.push(waiter);
		this.pump();
		return {
			ready,
			release: () => {
				const position = this.queue.indexOf(waiter);
				if (position >= 0) {
					this.queue.splice(position, 1);
					this.pump();
					return;
				}
				// 不在队列里：要么已经发过槽位，要么之前已经释放过，只有前一种需要还给池子。
				if (!waiter.admitted) return;
				waiter.admitted = false;
				this.active -= 1;
				if (kind === "exclusive") this.exclusiveRunning = false;
				this.pump();
			},
		};
	}

	/** 从队首逐个发放槽位；每次 release 或 acquire 都推进一次，FIFO 顺序与调用顺序一致。 */
	private pump(): void {
		while (this.queue.length > 0) {
			const next = this.queue[0] as Waiter;
			if (next.kind === "exclusive") {
				// 独占需要整个池空闲：运行中的任务结束后会再 pump 一次。
				if (this.exclusiveRunning || this.active > 0) return;
				this.exclusiveRunning = true;
			} else if (this.exclusiveRunning || this.active >= this.limit) return;
			this.queue.shift();
			next.admitted = true;
			this.active += 1;
			next.grant();
		}
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
 * 只按 Agent 配置启用工具白名单、默认加载 `npm:@ff-labs/pi-fff`（Agent 不用声明）、显式加载 Agent 声明的
 * 扩展（含来源随包提供的 skills），并追加角色正文作为系统提示。
 * 来源不可用（未安装、未启用或路径不存在）时跳过该来源，子会话用已注册的工具继续；只有显式写进 tools 的
 * 名字缺失才拒绝启动。
 * 不复制父会话内存态的 provider、认证和扩展工具；这些仍由普通 Pi 配置在子运行时中解析。
 */
async function createChildSession(request: RunRequest): Promise<{ session: AgentSession; unavailableSources: string[] }> {
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
	let skillPaths: string[] = [];
	// 默认来源在前、声明来源在后，同一来源只解析一次（Agent 重复声明 pi-fff 也不会加载两次）。
	let unavailableSources: string[] = [];
	try {
		const resolution = await resolveAgentExtensions(mergeSources(request.agent.extensions), {
			cwd: request.cwd, agentDir, settingsManager,
		});
		extensionPaths = resolution.paths;
		skillPaths = resolution.skillPaths;
		// 默认来源缺失属于正常回退（改用内置 grep/find），不写进结果文本；Agent 显式声明的才提示。
		const defaults = new Set(DEFAULT_CHILD_EXTENSIONS.map((source) => normalizeSource(source)));
		unavailableSources = resolution.missing.filter((source) => !defaults.has(normalizeSource(source)));
	} catch (error) {
		throw new SubagentError("startup", `无法解析子会话要加载的扩展：${errorText(error)}`);
	}
	const loader = new DefaultResourceLoader({
		cwd: request.cwd,
		agentDir,
		settingsManager,
		// 等价于旧版的 --no-extensions --no-skills --no-prompt-templates --no-themes：
		// 不做环境发现，只加载默认来源与 Agent 声明的扩展；也不会在同一进程里再加载一份本扩展。
		// 来源随包提供的 skills 由 additionalSkillPaths 显式传入，不依赖全局发现。
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		additionalExtensionPaths: extensionPaths,
		additionalSkillPaths: skillPaths,
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
	checkDeclaredTools(request, session, unavailableSources);
	return { session, unavailableSources };
}

/** 默认来源在前、声明来源在后；同一来源（忽略 `npm:` 前缀与版本号）只保留第一次出现。 */
function mergeSources(declared: string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const source of [...DEFAULT_CHILD_EXTENSIONS, ...declared]) {
		const key = normalizeSource(source);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(source);
	}
	return merged;
}

function isDeclaredExtensionPath(path: string, declared: string[]): boolean {
	const target = path.replace(/\\/gu, "/");
	return declared.some((root) => {
		const base = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
		return target === base || target.startsWith(`${base}/`);
	});
}

/**
 * Pi 的工具白名单会静默忽略未注册的名字，所以在启动前对照子会话注册表校验。
 * 只校验 requiredTools（frontmatter 显式写出的名字）：省略 tools 时自动带上的扩展工具
 * 可能因功能开关或改名而不存在，那些名字由子会话静默忽略。
 * 缺的是来源不可用（已跳过）造成的，就在提示里点名来源，避免误指到扩展自身的启用条件。
 */
function checkDeclaredTools(request: RunRequest, session: AgentSession, unavailableSources: string[]): void {
	const provided = new Set(session.getAllTools().map((tool) => tool.name));
	const missing = request.agent.requiredTools.filter((name) => !provided.has(name));
	if (missing.length === 0) return;
	const fromExtensions = [...new Set(session.extensionRunner.getAllRegisteredTools()
		.map((tool) => tool.definition.name)
		.filter((name) => !isBuiltinToolName(name)))];
	const hint = request.agent.extensions.length === 0
		? "该 Agent 未声明 extensions（子会话只默认加载 pi-fff）；扩展工具需要在 tools 列出名字，并在 extensions 中声明已安装的来源。"
		: unavailableSources.length > 0
			? `已声明的扩展来源不可用：[${unavailableSources.join(", ")}]（未安装、未启用或路径不存在），因此没有注册任何工具。`
			: fromExtensions.length > 0
				? `已加载扩展注册的工具：[${fromExtensions.join(", ")}]。`
				: "已声明的扩展没有注册任何工具，请检查扩展自身的启用条件。";
	throw new SubagentError("startup", `子会话缺少 Agent 声明的工具：[${missing.join(", ")}]。${hint}`);
}

async function runSession(request: RunRequest, signal: AbortSignal): Promise<{ text: string; lastTool?: string }> {
	checkCancelled(signal);
	const { session, unavailableSources } = await createChildSession(request);
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
	// 跳过来源的事实要进入模型可见文本：主 Agent 需要知道这次委派少了哪些扩展工具，
	// 而不是以为子会话的检索仍走 pi-fff。
	const notice = unavailableSources.length > 0
		? `[已跳过不可用的扩展来源：${unavailableSources.join(", ")}（未安装、未启用或路径不存在），子会话用已注册的工具继续。]`
		: "";
	return { text: notice ? `${notice}\n\n${answer.text}` : answer.text, lastTool };
}

export class SubagentRunner {
	private readonly lifetime = new AbortController();
	private readonly pool = new SlotPool(MAX_CONCURRENCY);
	private readonly calls = new Set<Promise<RunResult>>();
	private readonly retainedDirs = new Set<string>();
	private shutdownPromise?: Promise<void>;

	/** 当前调度视图，供进度快照回填并发量。 */
	get concurrency(): ConcurrencyView {
		return this.pool.view;
	}

	run(request: RunRequest): Promise<RunResult> {
		const signal = AbortSignal.any([this.lifetime.signal, ...(request.signal ? [request.signal] : [])]);
		// 只读 Agent 共享并发槽；含写入或扩展工具时无法静态判断是否写盘，独占整个池。
		const ticket = this.pool.acquire(isReadOnlyAgent(request.agent) ? "shared" : "exclusive");
		const call = (async () => {
			try {
				emit(request, "waiting");
				await waitForSlot(ticket.ready, signal);
				return await this.execute(request, signal);
			} finally {
				// 排队时等于取消排队，已发槽位时等于释放；取消或失败都不能卡住其他任务。
				ticket.release();
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
		const fullOutputPath = await this.retainFullText(output.text);
		checkCancelled(signal);
		const notice = `[结果已截断。完整回答：${fullOutputPath}；保留至父会话关闭、切换或 /reload。]\n\n`;
		const preview = truncateHead(output.text, {
			maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
			maxLines: DEFAULT_MAX_LINES - notice.split("\n").length,
		});
		return { text: notice + preview.content, lastTool: output.lastTool, truncated: true, fullOutputPath };
	}

	/**
	 * 写入完整输出并返回路径。临时目录注册进 retainedDirs，由 shutdown 统一清理，
	 * 因此取消、超时或父会话关闭都不会遗留文件。
	 */
	async retainFullText(text: string, fileName = "result.md"): Promise<string> {
		let dir: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "pi-subagents-"));
			const path = join(dir, fileName);
			await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
			this.retainedDirs.add(dir);
			return path;
		} catch (error) {
			// 写盘失败不影响调用结果，但目录已经建出来时不能留着。
			if (dir) {
				try {
					await rm(dir, { recursive: true, force: true });
				} catch {
					this.retainedDirs.add(dir);
				}
			}
			throw new SubagentError("cleanup", `无法保存完整输出：${errorText(error)}`);
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
