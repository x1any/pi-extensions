import {
	type ExtensionAPI,
	type ExtensionContext,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentDiscovery, type ThinkingLevel, configurationHint, discoverAgents } from "./src/agents.ts";
import { type ParallelProgress, ProgressHub, type TaskSink } from "./src/progress.ts";
import { MAX_CONCURRENCY, type RunResult, type RunState, SubagentError, SubagentRunner } from "./src/runner.ts";
import { clearRows, formatProgressText, publishRow, renderSubagentCall, renderSubagentResult, ticker } from "./src/ui.ts";

/** 单次调用允许的任务数；与 runner 的并发上限对齐，超出直接报错而不是静默截断。 */
const MAX_TASKS_PER_CALL = 4;

/** 工具结果 details：与展示层共用的多任务进度快照，单任务模式即 tasks.length === 1。 */
type SubagentDetails = ParallelProgress;

const TASK_ITEM = Type.Object({
	agent: Type.String({ minLength: 1, description: "可用 Agent 的准确名称。" }),
	task: Type.String({ minLength: 1, description: "完整、自包含的单个任务，包含背景、相关路径、约束和预期输出；子 Agent 不知道父会话历史。" }),
}, { additionalProperties: false });

const Parameters = Type.Object({
	agent: Type.Optional(Type.String({ minLength: 1, description: "单任务模式的 Agent 名称，与 task 搭配；不能与 tasks 同时出现。" })),
	task: Type.Optional(Type.String({ minLength: 1, description: "单任务模式的完整任务；不能与 tasks 同时出现。" })),
	tasks: Type.Optional(Type.Array(TASK_ITEM, {
		minItems: 1,
		maxItems: MAX_TASKS_PER_CALL,
		description: `并行模式：最多 ${MAX_TASKS_PER_CALL} 项互相独立的只读任务，按输入顺序返回逐项结果；不能与 agent/task 同时出现。`,
	})),
}, { additionalProperties: false });

/** 一次调用里的一项任务：index 从 1 开始，同时是展示顺序和结果顺序。 */
interface TaskSpec {
	index: number;
	agentName: string;
	task: string;
}

/** 已解析出 Agent 与模型、可以提交给 runner 的任务。 */
interface PlannedTask extends TaskSpec {
	agent: AgentConfig;
	provider: string;
	modelId: string;
	thinking: ThinkingLevel;
	sink: TaskSink;
}

/** 单个任务的结局：成功带结果，失败带错误，两者必居其一。 */
interface TaskOutcome {
	task: PlannedTask;
	state: RunState;
	result?: RunResult;
	error?: unknown;
}

/** footer 汇总行的固定 key。 */
const STATUS_KEY = "pi-subagents";

function readableError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const bounded = truncateHead(message, { maxBytes: 48 * 1024, maxLines: 1990 });
	return bounded.content + (bounded.truncated ? "\n[错误诊断已截断，请检查 Agent 配置和 Pi provider 配置。]" : "");
}

/** 并行模式下的逐项诊断：各任务独立截断，并去掉与标题重复的 kind 前缀。 */
function taskDiagnostic(error: unknown): string {
	const text = readableError(error);
	return error instanceof SubagentError ? text.replace(/^\[[a-z-]+\]\s*/u, "") : text;
}

/** 逐项标题里的状态：只有终态写原因，用词与工具行渲染保持一致。 */
function outcomeLabel(outcome: TaskOutcome): string {
	if (outcome.state === "completed") return "完成";
	if (outcome.state === "timed_out") return "失败（timeout）";
	if (outcome.state === "cancelled") return "已取消";
	const kind = outcome.error instanceof SubagentError ? `（${outcome.error.kind}）` : "";
	return `失败${kind}`;
}

/** 并行模式的模型可见文本：先给成功计数，再按输入顺序给出逐项小节。 */
function parallelReport(outcomes: TaskOutcome[], total: number): string {
	const succeeded = outcomes.filter((outcome) => outcome.result !== undefined).length;
	const sections = [`${succeeded}/${total} 成功`];
	for (const outcome of outcomes) {
		const header = `### [${outcome.task.index}/${total}] ${outcome.task.agentName} · ${outcomeLabel(outcome)}`;
		sections.push(`${header}\n\n${outcome.result?.text ?? taskDiagnostic(outcome.error)}`);
	}
	return sections.join("\n\n");
}

/** 失败任务的终态：超时、取消与其余失败分开标记，取消包含尚未开始就被取消的任务。 */
function failureState(error: unknown, signal: AbortSignal | undefined): RunState {
	if (error instanceof SubagentError && error.kind === "timeout") return "timed_out";
	if (signal?.aborted || (error instanceof SubagentError && error.kind === "cancelled")) return "cancelled";
	return "failed";
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
	return value.trim();
}

/** 从工具参数里取出 1–4 项任务：单任务用 agent + task，并行用 tasks，两种模式互斥。 */
function taskSpecs(params: { agent?: unknown; task?: unknown; tasks?: unknown }): TaskSpec[] {
	const extra = Object.keys(params).find((key) => key !== "agent" && key !== "task" && key !== "tasks");
	if (extra) throw new Error(`subagent 只接受 agent、task 和 tasks 参数，收到 ${JSON.stringify(extra)}。`);
	if (params.tasks !== undefined) {
		if (params.agent !== undefined || params.task !== undefined) {
			throw new Error("agent/task 与 tasks 互斥，请只使用其中一种模式。");
		}
		if (!Array.isArray(params.tasks) || params.tasks.length === 0) throw new Error("tasks 必须是非空数组。");
		if (params.tasks.length > MAX_TASKS_PER_CALL) {
			throw new Error(`单次调用最多 ${MAX_TASKS_PER_CALL} 项任务，收到 ${params.tasks.length} 项；请拆成多次调用。`);
		}
		return params.tasks.map((entry, position) => {
			const index = position + 1;
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				throw new Error(`tasks[${index}] 必须是 { agent, task } 对象。`);
			}
			// 逐项不支持 cwd、model、thinking：这些参数只来自 Agent 定义与父会话。
			const item = entry as { agent?: unknown; task?: unknown };
			const unknownKey = Object.keys(item).find((key) => key !== "agent" && key !== "task");
			if (unknownKey) throw new Error(`tasks[${index}] 只接受 agent 和 task，收到 ${JSON.stringify(unknownKey)}。`);
			return {
				index,
				agentName: requiredText(item.agent, `tasks[${index}] 的 agent`),
				task: requiredText(item.task, `tasks[${index}] 的 task`),
			};
		});
	}
	if (params.agent === undefined || params.task === undefined) {
		throw new Error("必须提供 agent 和 task，或提供 tasks 数组。");
	}
	return [{ index: 1, agentName: requiredText(params.agent, "agent"), task: requiredText(params.task, "task") }];
}

export default function (pi: ExtensionAPI): void {
	let runner = new SubagentRunner();
	let discovery: AgentDiscovery | undefined;
	let configError: string | undefined;
	let loadedCwd: string | undefined;

	function registerTool(): void {
		const listing = discovery?.agents.map((agent) =>
			`- ${JSON.stringify(agent.name)}: ${agent.description.replace(/\s+/gu, " ")}`,
		).join("\n");
		pi.registerTool<typeof Parameters, SubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description: [
				"将一个自包含任务同步委派给独立上下文的 Agent，只返回最终回答，不继承父会话历史。",
				`单任务用 agent + task；多个互相独立的只读调查用 tasks 数组一次提交（1–${MAX_TASKS_PER_CALL} 项），按输入顺序返回逐项结果。两种模式互斥。`,
				`只读 Agent（工具白名单全部是 read/grep/find/ls，或已知只读的扩展工具 ffgrep/fffind/fff-multi-grep/web_search/source_check/fetch_content/get_search_content/resolve-library-id/query-docs）最多同时运行 ${MAX_CONCURRENCY} 个（父会话内所有 subagent 调用共用一个队列），多出的排队；含写入或名单外扩展工具的 Agent 无法静态判断是否写盘，会独占执行，期间不与其他子任务并行。`,
				"等待和执行均可取消，执行超时为 10 分钟；单个任务失败不影响其他任务，全部失败才报错。",
				"默认工具为只读 read, grep, find, ls。写入/命令工具必须在 Agent 定义里显式授予；pi 没有权限弹窗，授权只发生在配置这一步，授予后子会话会直接执行。",
				"主 Agent 不得在委派期间修改与子 Agent 相同的文件。子会话不是文件系统沙箱。",
				"默认继承当前模型与 thinking；不继承父扩展、自定义工具或仅存在于父进程的 provider/认证配置。",
				"扩展只在 Agent 声明 extensions 时按已安装来源显式加载，不会自动安装或发现其他扩展；扩展工具名必须同时列在 tools 中。",
				"单个任务与整次调用的模型可见输出各至多 50 KiB / 2000 行；超限时完整内容写入临时文件（单任务 result.md，整次调用 parallel.md），返回文本里给出路径。",
				configError ? `配置加载失败，委派已禁用：${configError}` : `可用 Agent：\n${listing || "（无）"}`,
				loadedCwd && !listing ? configurationHint(loadedCwd) : "",
			].filter(Boolean).join("\n"),
			parameters: Parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				// 整个调用固定用一个 runner：重载会换实例，在飞的调用不能被换掉。
				const active = runner;
				const hub = new ProgressHub(
					(progress) => {
						onUpdate?.({ content: [{ type: "text", text: formatProgressText(progress) }], details: progress });
						if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, publishRow(toolCallId, progress));
					},
					() => active.concurrency,
				);
				const tasks: PlannedTask[] = [];
				const sinks: TaskSink[] = [];

				/** 解析 Agent 与模型；任何一项失败都让整次调用失败，与单任务模式的语义一致。 */
				function resolveTask(spec: TaskSpec, sink: TaskSink): PlannedTask {
					const failure = configError;
					if (failure) throw new Error(failure);
					// 会话环境变化（切换项目、信任状态变化）后旧定义立即失效，不拿旧快照继续委派。
					const available = loadedCwd === ctx.cwd && discovery?.projectTrusted === ctx.isProjectTrusted()
						? discovery.agents
						: undefined;
					if (!available) throw new Error("Agent 定义尚未初始化或会话环境已变化，请 /reload 后重试。");
					const agent = available.find((candidate) => candidate.name === spec.agentName);
					if (!agent) {
						throw new Error(available.length
							? `未知 Agent ${JSON.stringify(spec.agentName)}。可用名称：${available.map((a) => JSON.stringify(a.name)).join(", ")}。`
							: `没有可用 Agent。${configurationHint(ctx.cwd)}`);
					}
					let model = ctx.model;
					if (agent.model) {
						const slash = agent.model.indexOf("/");
						model = ctx.modelRegistry.find(agent.model.slice(0, slash), agent.model.slice(slash + 1));
						if (!model) throw new SubagentError("model", `未找到准确模型 ${agent.model}。请使用完整 provider/model 标识，不使用模糊名称或 :thinking 后缀。`);
					}
					if (!model) throw new SubagentError("model", "父会话没有当前模型，Agent 也未配置可用模型。");
					return {
						...spec, agent, sink,
						provider: model.provider, modelId: model.id,
						thinking: agent.thinking ?? ctx.thinkingLevel ?? pi.getThinkingLevel(),
					};
				}

				/** 提交一个任务并按结果写终态；任务失败不外抛，交给整次调用汇总。 */
				async function runTask(task: PlannedTask): Promise<TaskOutcome> {
					try {
						const result = await active.run({
							agent: task.agent, task: task.task, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(),
							provider: task.provider, modelId: task.modelId, thinking: task.thinking,
							signal, onProgress: task.sink,
						});
						// 成功走 complete：终态附加信息（截断、临时文件路径）不进 onUpdate。
						hub.complete(task.index, {
							state: "completed", lastTool: result.lastTool,
							truncated: result.truncated, fullOutputPath: result.fullOutputPath,
						});
						return { task, state: "completed", result };
					} catch (error) {
						const state = failureState(error, signal);
						// 失败走 sink：状态变化会立即刷新这一行与 footer。
						task.sink({ state });
						return { task, state, error };
					}
				}

				/** 整次调用的模型可见输出上限：超限时整次调用结果落盘，并在文本里给出临时文件路径。 */
				async function boundParallel(report: string, outcomes: TaskOutcome[]): Promise<string> {
					const bounded = truncateHead(report, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
					if (!bounded.truncated) return report;
					const paths = outcomes
						.map((outcome) => outcome.result?.fullOutputPath)
						.filter((path): path is string => typeof path === "string");
					let parallelPath: string | undefined;
					// 取消后不再新建文件：结果视图已被丢弃，临时目录也开始回收。
					if (!signal?.aborted) {
						try {
							parallelPath = await active.retainFullText(report, "parallel.md");
						} catch {
							parallelPath = undefined;
						}
					}
					return [
						bounded.content,
						"",
						"### 并行输出已被截断",
						parallelPath ? `完整结果见：${parallelPath}` : "完整结果未能保存。",
						paths.length > 0 ? `已单独截断的任务结果：${paths.join("、")}` : "",
						"临时文件保留至父会话关闭、切换或 /reload。",
					].filter(Boolean).join("\n");
				}

				try {
					for (const spec of taskSpecs(params)) {
						// 先按输入顺序注册每个任务：校验或启动失败也能在对应行上收成终态，footer 不留残影。
						const sink = hub.task(spec.index, spec.agentName);
						sinks.push(sink);
						const task = resolveTask(spec, sink);
						hub.describe(spec.index, { agent: task.agent.name, model: `${task.provider}/${task.modelId}` });
						tasks.push(task);
					}
					const outcomes = await Promise.all(tasks.map((task) => runTask(task)));
					const details = hub.snapshot();
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, publishRow(toolCallId, details));
					const [only] = outcomes;
					// 单任务模式与 v0.1 完全一致：结果就是最终回答文本，失败直接抛错。
					if (tasks.length === 1 && only) {
						if (only.result) return { content: [{ type: "text", text: only.result.text }], details };
						throw new Error(readableError(only.error));
					}
					const report = parallelReport(outcomes, tasks.length);
					// 全部失败抛错，与单任务失败语义一致；部分失败不抛错，失败项在文本里逐项标注。
					if (outcomes.every((outcome) => !outcome.result)) throw new Error(report);
					return { content: [{ type: "text", text: await boundParallel(report, outcomes) }], details };
				} catch (error) {
					// Pi 出错时会丢弃 details，只把错误文本交给模型；这里保证每行收敛到终态、footer 不残留。
					const state = failureState(error, signal);
					for (const sink of sinks) sink({ state });
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, publishRow(toolCallId, hub.snapshot()));
					throw new Error(readableError(error));
				} finally {
					hub.dispose();
				}
			},
			renderCall(args, theme) {
				return renderSubagentCall(args, theme);
			},
			renderResult(result, options, theme, context) {
				return renderSubagentResult(result, theme, {
					...options, isError: context.isError,
					toolCallId: context.toolCallId, invalidate: context.invalidate,
				});
			},
		});
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		ticker.dispose();
		clearRows();
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		await runner.shutdown();
		runner = new SubagentRunner();
		discovery = undefined;
		configError = undefined;
		loadedCwd = ctx.cwd;
		try {
			discovery = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
		} catch (error) {
			configError = readableError(error);
		}
		registerTool();
		const warning = configError ?? (!discovery?.agents.length ? configurationHint(ctx.cwd) : undefined);
		if (warning) {
			if (ctx.hasUI) ctx.ui.notify(`pi-subagents: ${warning}`, configError ? "error" : "warning");
			else console.error(`pi-subagents: ${warning}`);
		}
	}

	registerTool();
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("session_shutdown", () => {
		ticker.dispose();
		clearRows();
		return runner.shutdown();
	});
}
