import { getMarkdownTheme, keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, sliceByColumn, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CallProgress, TaskProgress, ToolCallProgress, ToolCallState } from "./progress.ts";
import { TERMINAL_STATES } from "./progress.ts";
import type { RunState } from "./runner.ts";

/** 进行中的行统一用动画圈：状态词不进界面，避免堆砌状态。 */
const SPINNER_MS = 120;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** details 缺失（出错被 Pi 清空）时的回退行数：与 Pi 自带 fallback 的 10 行保持一致。 */
const FALLBACK_LINES = 10;
/** 截断提示占 3 列，与 pi-tui 默认省略号等宽。 */
const ELLIPSIS = "...";

/** 状态文案：只用于非 UI 通道（onUpdate 的一行文本）。 */
const STATE_LABELS: Record<RunState, string> = {
	waiting: "排队中",
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

interface StateMark {
	glyph: string;
	color: ThemeColor;
	label?: string;
}

/** 终态标记：只有终态需要在行里写明原因（失败/已超时/已取消）。 */
const TERMINAL_MARKS: Partial<Record<RunState, StateMark>> = {
	completed: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error", label: "失败" },
	timed_out: { glyph: "✗", color: "warning", label: "已超时" },
	cancelled: { glyph: "⊘", color: "muted", label: "已取消" },
};

const TOOL_MARKS: Partial<Record<ToolCallState, StateMark>> = {
	completed: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error", label: "失败" },
	interrupted: { glyph: "⊘", color: "muted", label: "已中断" },
};

/** 动画圈取当前时间的帧，因此同一时刻所有行相位一致，也不需要额外状态。 */
function spinnerFrame(at: number): string {
	return SPINNER_FRAMES[Math.floor(at / SPINNER_MS) % SPINNER_FRAMES.length] as string;
}

/** 排队是暗淡的，重试中换成警告色提示，两者都不额外加状态词。 */
function activeColor(state: RunState): ThemeColor {
	if (state === "waiting") return "muted";
	if (state === "retrying") return "warning";
	return "accent";
}

function activeMark(state: RunState, theme: Theme, at: number): string {
	return theme.fg(activeColor(state), spinnerFrame(at));
}

/**
 * 截断提示由 runner 拼进模型可见文本，UI 已用任务行单独标注截断状态，正文里必须去掉这段噪声。
 * 多项任务时提示跟随各小节出现，因此按行匹配并全局清除。
 */
const TRUNCATION_NOTICE = /^\[结果已截断[^\]]*\]\n*/gmu;
/** 报告首行与树上汇总重复；只在展开渲染时移除，不改变模型可见 content。 */
const REPORT_SUMMARY = /^\d+\/\d+ 成功(?:\r?\n)+/u;

/** 工具结果：Pi 出错时会用空 details 覆盖部分结果，所以这里不假设 shape。 */
export interface SubagentResult {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: unknown;
}

/** 渲染选项：直接复用 Pi 传入的结果选项，额外补上错误标记与重绘句柄。 */
export interface SubagentResultOptions {
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	toolCallId: string;
	invalidate: () => void;
	args?: unknown;
}

/**
 * onUpdate 的一行文本。非 UI 上下文（RPC、print）也会收到它，因此保持纯文本、不含富信息。
 * 单项与多项共用同一节：先给成功计数（与报告头部同一口径），再给当前任务，顺序固定，不会被最后一个事件覆盖已有状态。
 */
export function formatProgressText(progress: CallProgress): string {
	const total = progress.tasks.length;
	if (total === 0) return "子任务尚未开始。";
	// 只数成功：失败、超时、取消都不算，与报告头部的 `N/M 成功` 保持一致。
	const succeeded = progress.tasks.filter((task) => task.state === "completed").length;
	const running = progress.tasks.filter((task) => !TERMINAL_STATES.has(task.state) && task.state !== "waiting").length;
	const queued = progress.tasks.filter((task) => task.state === "waiting").length;
	const current = progress.tasks.find((task) => !TERMINAL_STATES.has(task.state));
	const parts = [`${succeeded}/${total} 成功`];
	// 单项任务里“1 个执行中”与后面点名的那个任务是同一件事，只在真的并发时才单给计数。
	if (running > 1) parts.push(`${running} 个执行中`);
	if (queued > 0) parts.push(`${queued} 个排队中`);
	if (current) {
		const elapsed = elapsedText(current);
		const detail = [
			current.lastTool ? `最近工具：${current.lastTool}` : "",
			elapsed ? `已用时 ${elapsed}` : "",
		].filter(Boolean).join("；");
		parts.push(`${current.agent} ${stateLabel(current.state)}${detail ? `（${detail}）` : ""}`);
	}
	return parts.join("；");
}

/** 从调用参数恢复计划任务；错误结果没有 details 时仍能保留树的基本形态。 */
function plannedAgents(args: unknown): string[] {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
	const tasks = (args as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return [];
	return tasks.map((task) => {
		if (typeof task !== "object" || task === null || Array.isArray(task)) return "?";
		const agent = (task as { agent?: unknown }).agent;
		return typeof agent === "string" && agent.trim() ? agent.trim() : "?";
	});
}

/** 将结构化快照与调用参数合并；配置解析中途失败时，尚未注册的任务也不会从树上消失。 */
function tasksForRender(details: CallProgress | undefined, args: unknown, isError: boolean): TaskProgress[] {
	const structured = Array.isArray(details?.tasks) ? details.tasks : [];
	const planned = plannedAgents(args);
	if (planned.length === 0) return structured;
	const byIndex = new Map(structured.map((task) => [task.index, task]));
	return planned.map((agent, position) => byIndex.get(position + 1) ?? {
		index: position + 1,
		agent,
		state: isError ? "failed" : "waiting",
		tools: [],
		omittedTools: 0,
	});
}

/** 工具行标题作为树根，只显示静态任务数；实时汇总放在结果区域。 */
export function renderSubagentCall(args: unknown, theme: Theme): Component {
	const count = plannedAgents(args).length;
	const suffix = count > 0 ? theme.fg("muted", ` · ${count} 项`) : "";
	return new Text(theme.fg("toolTitle", theme.bold("subagent")) + suffix, 0, 0);
}

/** 工具结果：优先使用 details；错误清空 details 时从调用参数恢复任务骨架。 */
export function renderSubagentResult(
	result: SubagentResult,
	theme: Theme,
	options: SubagentResultOptions,
): Component {
	const text = textOf(result.content);
	const details = result.details as CallProgress | undefined;
	const tasks = tasksForRender(details, options.args, options.isError);
	// 分片推进期间登记重绘节拍（动画圈 + 耗时靠自己跳动），终态渲染时注销。
	if (options.isPartial && tasks.length > 0) {
		ticker.watch(options.toolCallId, options.invalidate);
	} else ticker.unwatch(options.toolCallId);
	if (tasks.length === 0) {
		return plainResult(text, options, theme);
	}
	return new TaskListComponent({
		tasks, text, theme,
		expanded: options.expanded, isPartial: options.isPartial,
	});
}

/** details 被 Pi 清空时的回退（出错只有纯文本）：折叠态只给开头几行，超出的部分提示展开。 */
function plainResult(text: string, options: SubagentResultOptions, theme: Theme): Component {
	const color: ThemeColor = options.isError ? "error" : "toolOutput";
	const lines = text.split("\n");
	if (options.expanded || lines.length <= FALLBACK_LINES) {
		return new Text(theme.fg(color, lines.join("\n")), 0, 0);
	}
	const hidden = lines.length - FALLBACK_LINES;
	const body = lines.slice(0, FALLBACK_LINES).map((line) => theme.fg(color, line)).join("\n");
	const hint = theme.fg("muted", `... 另有 ${hidden} 行 `)
		+ keyHint("app.tools.expand", "查看完整内容");
	return new Text(`${body}\n${hint}`, 0, 0);
}

/** 进行中的行靠时间自己跳动：整体只跑一个固定节拍的定时器。 */
class Ticker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly rows = new Map<string, () => void>();

	watch(toolCallId: string, invalidate: () => void): void {
		// 拿不到重绘句柄就不要走表，否则定时器只会白跑。
		if (typeof invalidate !== "function") return;
		this.rows.set(toolCallId, invalidate);
		this.reschedule();
	}

	unwatch(toolCallId: string): void {
		this.rows.delete(toolCallId);
		this.reschedule();
	}

	/** 会话结束或重载时清空，不留下指向旧界面的定时器。 */
	dispose(): void {
		this.rows.clear();
		this.reschedule();
	}

	/** 只有一个节拍：有行就开表，没行就停表。 */
	private reschedule(): void {
		if (this.rows.size === 0) {
			this.stop();
			return;
		}
		if (this.timer) return;
		const timer = setInterval(() => this.tick(), SPINNER_MS);
		(timer as { unref?: () => void }).unref?.();
		this.timer = timer;
	}

	private tick(): void {
		for (const invalidate of [...this.rows.values()]) {
			try {
				invalidate();
			} catch {
				// 行已销毁：下一次 unwatch 或 dispose 会清掉它。
			}
		}
	}

	private stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

/** 模块级单例：定时器数量与并行行数无关。 */
export const ticker = new Ticker();

interface TaskListOptions {
	tasks: TaskProgress[];
	text: string;
	expanded: boolean;
	isPartial: boolean;
	theme: Theme;
}

/**
 * 结果视图：单项与多项走同一形态——执行中只给状态行，完成后折叠态追加展开提示，展开态追加任务明细与完整回答。
 *
 * 布局只取决于 tasks.length，不依赖并发上限或调度策略。
 */
class TaskListComponent implements Component {
	constructor(private readonly options: TaskListOptions) {}

	render(width: number): string[] {
		return buildLines(this.options, width);
	}

	/** Pi 每次无效化都会重建渲染组件，这里没有需要失效的缓存。 */
	invalidate(): void {}
}

function buildLines(options: TaskListOptions, width: number): string[] {
	const { tasks, text, expanded, isPartial, theme } = options;
	const multi = tasks.length > 1;
	// 明细只在完成后生效：执行期间按展开键也只给状态，进度文本不是回答，不该被当成结果铺开。
	const detail = expanded && !isPartial;
	// 一次渲染固定一帧，同一行里所有任务与工具用同一个动画相位。
	const at = Date.now();
	const lines: string[] = [clipToWidth(summaryLine(tasks, isPartial, theme), width)];
	for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index] as TaskProgress;
		lines.push(...taskLines(
			task, theme, multi, detail, isPartial, at, index === tasks.length - 1,
		).map((line) => clipToWidth(line, width)));
	}
	// 执行期间的 content 就是那行进度文本：树已经包含进度，不再重复追加纯文本。
	if (isPartial) return lines;
	// 截断提示已由任务节点用结构化形式给出（含完整结果路径），正文里不再重复一遍。
	const body = text.replace(TRUNCATION_NOTICE, "").trim();
	const report = body.replace(REPORT_SUMMARY, "").trim();
	if (detail) {
		if (report) {
			lines.push("", clipToWidth(theme.fg("muted", "完整回答"), width));
			lines.push(...new Markdown(report, 0, 0, getMarkdownTheme()).render(width));
		}
		return lines;
	}
	// 折叠态一律只给树与展开提示，正文预览只放在展开态。
	if (body) lines.push(keyHint("app.tools.expand", "展开完整回答"));
	return lines;
}

function summaryLine(tasks: TaskProgress[], isPartial: boolean, theme: Theme): string {
	const succeeded = tasks.filter((task) => task.state === "completed").length;
	const parts = [theme.fg(succeeded === tasks.length ? "success" : "accent", `${succeeded}/${tasks.length} 成功`)];
	if (isPartial) {
		const running = tasks.filter((task) => !TERMINAL_STATES.has(task.state) && task.state !== "waiting").length;
		const queued = tasks.filter((task) => task.state === "waiting").length;
		if (running > 0) parts.push(theme.fg("accent", `${running} 个执行中`));
		if (queued > 0) parts.push(theme.fg("muted", `${queued} 个排队中`));
	} else {
		const unsuccessful = tasks.filter((task) => TERMINAL_STATES.has(task.state) && task.state !== "completed").length;
		if (unsuccessful > 0) parts.push(theme.fg("warning", `${unsuccessful} 个未成功`));
	}
	return parts.join(theme.fg("muted", " · "));
}

function taskLines(
	task: TaskProgress,
	theme: Theme,
	multi: boolean,
	detail: boolean,
	isPartial: boolean,
	at: number,
	isLastTask: boolean,
): string[] {
	const terminal = TERMINAL_MARKS[task.state];
	const connector = theme.fg("borderMuted", isLastTask ? "└─" : "├─");
	const parts = [connector, terminal ? theme.fg(terminal.color, terminal.glyph) : activeMark(task.state, theme, at)];
	const label = `${multi ? `#${task.index} ` : ""}${task.agent}`;
	parts.push(theme.fg("toolTitle", label));
	// 进行中不写状态词，只有终态需要说明原因（失败/已超时/已取消）。
	if (terminal?.label) parts.push(theme.fg("muted", "·"), theme.fg(terminal.color, terminal.label));
	const toolCount = (task.omittedTools ?? 0) + (task.tools?.length ?? 0);
	if (toolCount > 0) parts.push(theme.fg("muted", `· ${toolCount} 个工具`));
	else if (task.lastTool) parts.push(theme.fg("muted", `· ${task.lastTool}`));
	const elapsed = elapsedText(task);
	if (elapsed) parts.push(theme.fg("dim", `· ${elapsed}`));
	if (task.truncated && !detail) parts.push(theme.fg("warning", "· 结果已截断"));
	const lines = [parts.join(" ")];

	const children: string[] = [];
	if (detail && (task.omittedTools ?? 0) > 0) {
		children.push(theme.fg("muted", `… ${task.omittedTools} 个更早的工具调用`));
	}
	const tools = task.tools ?? [];
	const visibleTools = detail ? tools : isPartial && !terminal ? tools.slice(-1) : [];
	for (const tool of visibleTools) children.push(toolText(tool, theme, at));
	if (detail && task.truncated) {
		const path = task.fullOutputPath ? theme.fg("dim", ` · ${task.fullOutputPath}`) : "";
		children.push(theme.fg("warning", "结果已截断") + path);
	}
	const stem = theme.fg("borderMuted", isLastTask ? "   " : "│  ");
	for (let index = 0; index < children.length; index += 1) {
		const childConnector = theme.fg("borderMuted", index === children.length - 1 ? "└─" : "├─");
		lines.push(`${stem}${childConnector} ${children[index]}`);
	}
	return lines;
}

function toolText(tool: ToolCallProgress, theme: Theme, at: number): string {
	const terminal = TOOL_MARKS[tool.state];
	const mark = terminal ? theme.fg(terminal.color, terminal.glyph) : activeMark("tool", theme, at);
	const parts = [mark, theme.fg("accent", tool.name)];
	if (terminal?.label) parts.push(theme.fg(terminal.color, `· ${terminal.label}`));
	parts.push(theme.fg("dim", `· ${formatDuration((tool.endedAt ?? at) - tool.startedAt)}`));
	return parts.join(" ");
}

/**
 * 按可见宽度截断并补省略号。
 *
 * 不能用 pi-tui 的 truncateToWidth：它在省略号两侧插全量重置（\x1b[0m），
 * 而 Pi 的工具卡片靠外层 Box 给整行铺底色，全量重置会把底色一起清掉，
 * 省略号及其右侧会回落成终端默认底色（前景色也会一起丢）。
 */
function clipToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	// 极窄宽度下省略号自己也要裁，否则会返回 3 列、超出 maxWidth。
	if (maxWidth <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxWidth);
	return sliceByColumn(text, 0, maxWidth - ELLIPSIS.length, true) + ELLIPSIS;
}

function stateLabel(state: RunState): string {
	return STATE_LABELS[state] ?? state;
}

function elapsedText(task: TaskProgress): string | undefined {
	if (task.startedAt === undefined) return undefined;
	return formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
}

function formatDuration(ms: number): string {
	const elapsedMs = Math.max(0, ms);
	if (elapsedMs < 1000) return "<1s";
	const seconds = Math.round(elapsedMs / 1000);
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}
