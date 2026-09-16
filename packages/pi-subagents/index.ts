import {
	type ExtensionAPI,
	type ExtensionContext,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentDiscovery, configurationHint, discoverAgents } from "./src/agents.ts";
import { type RunProgress, type RunState, SubagentError, SubagentRunner } from "./src/runner.ts";

const Parameters = Type.Object({
	agent: Type.String({ minLength: 1, description: "可用 Agent 的准确名称。" }),
	task: Type.String({ minLength: 1, description: "完整、自包含的单个任务，包含背景、相关路径、约束和预期输出；子 Agent 不知道父会话历史。" }),
}, { additionalProperties: false });

interface SubagentDetails extends RunProgress {
	agent: string;
	model?: string;
	truncated?: boolean;
	fullOutputPath?: string;
}

const STATES: Record<RunState, string> = {
	waiting: "等待执行槽",
	starting: "启动中",
	running: "执行中",
	tool: "使用工具",
	retrying: "模型重试中",
	finishing: "等待会话结束",
	completed: "完成",
	cancelled: "已取消",
	timed_out: "已超时",
	failed: "失败",
};

function readableError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const bounded = truncateHead(message, { maxBytes: 48 * 1024, maxLines: 1990 });
	return bounded.content + (bounded.truncated ? "\n[错误诊断已截断，请检查 Agent 配置和 Pi provider 配置。]" : "");
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
				"所有 subagent 调用串行执行；等待和执行均可取消，执行超时为 10 分钟。",
				"默认工具为只读 read, grep, find, ls。仅 Agent 配置可以显式授予写入/命令工具，且执行写入仍须用户授权。",
				"主 Agent 不得在委派期间修改与子 Agent 相同的文件。子会话不是文件系统沙箱。",
				"默认继承当前模型与 thinking；不继承父扩展、自定义工具或仅存在于父进程的 provider/认证配置。",
				"扩展只在 Agent 声明 extensions 时按已安装来源显式加载，不会自动安装或发现其他扩展；扩展工具名必须同时列在 tools 中。",
				"返回内容最多 50 KiB / 2000 行（含截断提示），截断时提供完整结果临时文件路径。",
				configError ? `配置加载失败，委派已禁用：${configError}` : `可用 Agent：\n${listing || "（无）"}`,
				loadedCwd && !listing ? configurationHint(loadedCwd) : "",
			].filter(Boolean).join("\n"),
			parameters: Parameters,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				let details: SubagentDetails = { agent: params.agent, state: "waiting" };
				const update = (progress: RunProgress) => {
					details = { ...details, ...progress, lastTool: progress.lastTool ?? details.lastTool };
					onUpdate?.({
						content: [{ type: "text", text: `${details.agent}：${STATES[details.state]}${details.lastTool ? `；最近工具：${details.lastTool}` : ""}` }],
						details: { ...details },
					});
				};
				try {
					if (typeof params.agent !== "string" || !params.agent.trim() || typeof params.task !== "string" || !params.task.trim()) {
						throw new Error("agent 和 task 均必须是非空字符串。");
					}
					if (Object.keys(params).some((key) => key !== "agent" && key !== "task")) {
						throw new Error("subagent 只接受 agent 和 task 两个参数。");
					}
					if (configError) throw new Error(configError);
					if (!discovery || loadedCwd !== ctx.cwd || discovery.projectTrusted !== ctx.isProjectTrusted()) {
						throw new Error("Agent 定义尚未初始化或会话环境已变化，请 /reload 后重试。");
					}
					const agent = discovery.agents.find((candidate) => candidate.name === params.agent);
					if (!agent) {
						throw new Error(discovery.agents.length
							? `未知 Agent ${JSON.stringify(params.agent)}。可用名称：${discovery.agents.map((a) => JSON.stringify(a.name)).join(", ")}。`
							: `没有可用 Agent。${configurationHint(ctx.cwd)}`);
					}
					let model = ctx.model;
					if (agent.model) {
						const slash = agent.model.indexOf("/");
						model = ctx.modelRegistry.find(agent.model.slice(0, slash), agent.model.slice(slash + 1));
						if (!model) throw new SubagentError("model", `未找到准确模型 ${agent.model}。请使用完整 provider/model 标识，不使用模糊名称或 :thinking 后缀。`);
					}
					if (!model) throw new SubagentError("model", "父会话没有当前模型，Agent 也未配置可用模型。");
					details.model = `${model.provider}/${model.id}`;
					const result = await runner.run({
						agent, task: params.task, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(),
						provider: model.provider, modelId: model.id,
						thinking: agent.thinking ?? ctx.thinkingLevel ?? pi.getThinkingLevel(),
						signal, onProgress: update,
					});
					details = { ...details, state: "completed", lastTool: result.lastTool, truncated: result.truncated, fullOutputPath: result.fullOutputPath };
					return { content: [{ type: "text", text: result.text }], details };
				} catch (error) {
					const state: RunState = error instanceof SubagentError && error.kind === "timeout" ? "timed_out"
						: signal?.aborted || (error instanceof SubagentError && error.kind === "cancelled") ? "cancelled" : "failed";
					try { update({ state }); } catch { /* 错误仍由 execute 抛出，交给 Pi 标记。 */ }
					throw new Error(readableError(error));
				}
			},
		});
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
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
	pi.on("session_shutdown", () => runner.shutdown());
}
