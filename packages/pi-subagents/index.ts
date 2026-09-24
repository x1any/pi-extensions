import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentDiscovery, type ThinkingLevel, configurationHint, discoverAgents, isBuiltinToolName } from "./src/agents.ts";
import { inferLoadedToolSources } from "./src/extensions.ts";
import { type CallProgress, ProgressHub, type TaskSink } from "./src/progress.ts";
import { MAX_CONCURRENCY, type RunState, SubagentError, SubagentRunner } from "./src/runner.ts";
import { formatProgressText, renderSubagentCall, renderSubagentResult, ticker } from "./src/ui.ts";

/** 工具结果 details：展示层共用的进度快照。 */
type SubagentDetails = CallProgress;

/** 一次调用只委派一项任务；并行调查由模型在同一条消息里发起多个调用。 */
const Parameters = Type.Object({
	agent: Type.String({ minLength: 1, description: "可用 Agent 的准确名称。" }),
	task: Type.String({ minLength: 1, description: "完整、自包含的单个任务，包含背景、相关路径、约束和预期输出；子 Agent 不知道父会话历史。" }),
}, { additionalProperties: false });

/** 解析出 Agent 与模型的任务，可提交 runner。 */
interface PlannedTask {
	agentName: string;
	agent: AgentConfig;
	provider: string;
	modelId: string;
	thinking: ThinkingLevel;
	sink: TaskSink;
}

function readableError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const bounded = truncateHead(message, { maxBytes: 48 * 1024, maxLines: 1990 });
	return bounded.content + (bounded.truncated ? "\n[错误诊断已截断，请检查 Agent 配置和 Pi provider 配置。]" : "");
}

/** 只有 SubagentError 带结构化 kind，终态判定共用这一处。 */
function failureKind(error: unknown): string | undefined {
	return error instanceof SubagentError ? error.kind : undefined;
}

/** 失败终态：超时、取消与其余失败分开标记。 */
function failureState(error: unknown, signal: AbortSignal | undefined): RunState {
	const kind = failureKind(error);
	if (kind === "timeout") return "timed_out";
	if (signal?.aborted || kind === "cancelled") return "cancelled";
	return "failed";
}

function requiredText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
	return value.trim();
}

/** 单任务参数：agent 与 task 必填非空，不接受其他字段。 */
function taskSpec(params: { agent?: unknown; task?: unknown }): { agentName: string; task: string } {
	const extra = Object.keys(params).find((key) => key !== "agent" && key !== "task");
	if (extra) throw new Error(`subagent 只接受 agent 和 task 参数，收到 ${JSON.stringify(extra)}。`);
	return {
		agentName: requiredText(params.agent, "agent"),
		task: requiredText(params.task, "task"),
	};
}

export default function (pi: ExtensionAPI): void {
	let runner = new SubagentRunner();
	/** 抛错时 Pi 清空 details；暂存快照供 tool_result 钩子回填。 */
	const failedDetails = new Map<string, SubagentDetails>();
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
			promptSnippet: "把自包含任务委派给独立上下文的子 Agent，只返回最终回答",
			promptGuidelines: [
				"subagent：每次调用只委派 1 项任务；互相独立的调查在同一消息里并行发起多个 subagent 调用。",
				"subagent：委派前把任务写完整（背景、路径或符号、约束、期望输出），子 Agent 看不到本会话历史。",
				"subagent：需要来回确认或依赖本会话细节的工作自己做。",
				"subagent：子会话不是文件系统沙箱，委派期间不要修改与子 Agent 相同的文件。",
			],
			description: [
				"把一个自包含任务同步委派给独立上下文的子 Agent，只返回最终回答；子会话不继承本会话历史，可用工具由 Agent 定义决定。",
				"每次调用只委派一项任务；互相独立的调查请在同一条消息里并行发起多个 subagent 调用。",
				`只读 Agent 最多 ${MAX_CONCURRENCY} 个并行，可能写盘的任务独占执行，超出排队；单次执行上限 10 分钟，等待与执行均可取消。`,
				"单次结果至多 50 KiB / 2000 行，超限时完整内容写入临时文件，并在返回文本里给出路径。",
				configError ? `配置加载失败，委派已禁用：${configError}` : `可用 Agent：\n${listing || "（无）"}`,
				loadedCwd && !listing ? configurationHint(loadedCwd) : "",
			].filter(Boolean).join("\n"),
			parameters: Parameters,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				// 固定用调用开始时的 runner：重载换实例，在飞调用不能被换掉。
				const active = runner;
				const hub = new ProgressHub((progress) => {
					onUpdate?.({ content: [{ type: "text", text: formatProgressText(progress) }], details: progress });
				});
				let sink: TaskSink | undefined;

				/** 解析 Agent 与模型；失败即整次调用失败。 */
				function resolveTask(agentName: string, taskSink: TaskSink): PlannedTask {
					const failure = configError;
					if (failure) throw new Error(failure);
					// 会话环境变化后旧定义立即失效，不拿旧快照继续委派。
					const available = loadedCwd === ctx.cwd && discovery?.projectTrusted === ctx.isProjectTrusted()
						? discovery.agents
						: undefined;
					if (!available) throw new Error("Agent 定义尚未初始化或会话环境已变化，请 /reload 后重试。");
					const agent = available.find((candidate) => candidate.name === agentName);
					if (!agent) {
						throw new Error(available.length
							? `未知 Agent ${JSON.stringify(agentName)}。可用名称：${available.map((a) => JSON.stringify(a.name)).join(", ")}。`
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
						agentName, agent, sink: taskSink,
						provider: model.provider, modelId: model.id,
						thinking: agent.thinking ?? ctx.thinkingLevel ?? pi.getThinkingLevel(),
					};
				}

				try {
					const spec = taskSpec(params);
					// 先注册任务：参数或启动失败也能在状态行收成终态。
					const taskSink = hub.task(1, spec.agentName);
					sink = taskSink;
					const task = resolveTask(spec.agentName, taskSink);
					const result = await active.run({
						agent: task.agent, task: spec.task, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(),
						provider: task.provider, modelId: task.modelId, thinking: task.thinking,
						signal, onProgress: taskSink,
					});
					// 终态附加信息（截断、临时文件路径）走 complete，不进 onUpdate。
					hub.complete(1, {
						state: "completed", lastTool: result.lastTool,
						truncated: result.truncated, fullOutputPath: result.fullOutputPath,
					});
					// 模型可见文本就是子 Agent 的回答；截断通知由 runner 拼在开头。
					return { content: [{ type: "text", text: result.text }], details: hub.snapshot() };
				} catch (error) {
					// 出错时 Pi 丢弃 details；先收敛状态行，再暂存快照供钩子回填。
					sink?.({ state: failureState(error, signal) });
					const details = hub.snapshot();
					if (details.tasks.length > 0) failedDetails.set(toolCallId, details);
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
					...options, isError: context.isError, args: context.args,
					toolCallId: context.toolCallId, invalidate: context.invalidate,
				});
			},
		});
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		ticker.dispose();
		failedDetails.clear();
		await runner.shutdown();
		runner = new SubagentRunner();
		discovery = undefined;
		configError = undefined;
		loadedCwd = ctx.cwd;
		try {
			const found = discoverAgents(ctx.cwd, ctx.isProjectTrusted());
			if (found.agents.some((agent) => agent.inferExtensions && agent.tools.some((tool) => !isBuiltinToolName(tool)))) {
				const sources = await inferLoadedToolSources(pi.getAllTools(), {
					cwd: ctx.cwd, agentDir: getAgentDir(),
					settingsManager: SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: found.projectTrusted }),
				});
				for (const agent of found.agents) {
					if (agent.inferExtensions) {
						agent.extensions = [...new Set(agent.tools.flatMap((tool) =>
							isBuiltinToolName(tool) ? [] : sources.get(tool) ?? []))];
					}
				}
			}
			discovery = found;
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

	/** 保留错误语义（继续 throw），同时恢复渲染所需的结构化 details。 */
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const details = failedDetails.get(event.toolCallId);
		failedDetails.delete(event.toolCallId);
		if (event.isError && event.details === undefined && details) return { details };
	});

	registerTool();
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("session_shutdown", () => {
		ticker.dispose();
		failedDetails.clear();
		return runner.shutdown();
	});
}
