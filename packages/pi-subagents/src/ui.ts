import { getMarkdownTheme, keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ParallelProgress, TaskProgress, TaskUsage } from "./progress.ts";
import { TERMINAL_STATES } from "./progress.ts";
import type { RunState } from "./runner.ts";

/** 进行中的行统一用动画圈：状态词不进界面，避免堆砌状态。 */
const SPINNER_MS = 120;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 展开态要重排 Markdown，放慢节拍，避免每 120ms 重解析整篇回答。 */
const EXPANDED_TICK_MS = 1000;

/** 折叠态最多显示的任务行数；超出时优先保留运行中的任务与最近完成的任务。 */
const MAX_VISIBLE_TASKS = 4;
/** 折叠态的答案预览行数。 */
const PREVIEW_LINES = 3;
/** renderCall 里任务预览的最大列宽：此时拿不到终端宽度，短终端交给 Text 自行换行。 */
const CALL_PREVIEW_WIDTH = 80;

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

/** 截断提示由 runner 拼进模型可见文本，UI 已单独标注截断状态，预览里必须去掉这段噪声。 */
const TRUNCATION_NOTICE = /^\[结果已截断[^\]]*\]\n*/u;

/** 工具参数：现在只有 agent/task；tasks 留给并行模式，属性全部按未知值防御。 */
export interface SubagentCallArgs {
	agent?: unknown;
	task?: unknown;
	tasks?: unknown;
}

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
}

/**
 * onUpdate 的一行文本。非 UI 上下文（RPC、print）也会收到它，因此保持纯文本、不含富信息。
 * 并行分支：一行汇总加最近变化，顺序固定，不会被最后一个事件覆盖已有状态。
 */
export function formatProgressText(progress: ParallelProgress): string {
	if (progress.tasks.length <= 1) {
		const task = progress.tasks[0];
		if (!task) return "子任务尚未开始。";
		const parts = [stateLabel(task.state)];
		if (task.lastTool) parts.push(`最近工具：${task.lastTool}`);
		const elapsed = elapsedText(task);
		if (elapsed) parts.push(`已用时 ${elapsed}`);
		return `${task.agent}：${parts.join("；")}`;
	}
	const total = progress.tasks.length;
	const finished = progress.tasks.filter((task) => TERMINAL_STATES.has(task.state)).length;
	const running = progress.tasks.filter((task) => !TERMINAL_STATES.has(task.state) && task.state !== "waiting").length;
	const queued = progress.tasks.filter((task) => task.state === "waiting").length;
	const current = progress.tasks.find((task) => !TERMINAL_STATES.has(task.state));
	const parts = [`${finished}/${total} 完成`];
	if (running > 0) parts.push(`${running} 个执行中`);
	if (queued > 0) parts.push(`${queued} 个排队中`);
	if (current) {
		parts.push(`${current.agent} ${stateLabel(current.state)}${current.lastTool ? `（最近工具：${current.lastTool}）` : ""}`);
	}
	return parts.join("；");
}

/** 工具行标题：单任务显示 Agent 名与任务摘要；并行模式显示逐项摘要（有 tasks 时走这一支）。 */
export function renderSubagentCall(args: SubagentCallArgs | undefined, theme: Theme): Component {
	const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
	if (tasks.length === 0) {
		const agent = agentName(args?.agent);
		const lines = [theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agent)];
		const preview = previewLine(args?.task);
		if (preview) lines.push(theme.fg("dim", `  ${preview}`));
		return new Text(lines.join("\n"), 0, 0);
	}
	const lines = [theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel ${tasks.length}`)];
	tasks.slice(0, MAX_VISIBLE_TASKS).forEach((entry, position) => {
		const item = entry as SubagentCallArgs | undefined;
		const preview = previewLine(item?.task);
		const line = theme.fg("muted", `  ${position + 1}. `) + theme.fg("accent", agentName(item?.agent));
		lines.push(preview ? `${line}${theme.fg("dim", ` ${preview}`)}` : line);
	});
	if (tasks.length > MAX_VISIBLE_TASKS) {
		lines.push(theme.fg("muted", `  ... 另有 ${tasks.length - MAX_VISIBLE_TASKS} 项`));
	}
	return new Text(lines.join("\n"), 0, 0);
}

/** 工具结果：details 可用时渲染任务列表，被 Pi 清空时（出错）退回纯文本。 */
export function renderSubagentResult(
	result: SubagentResult,
	theme: Theme,
	options: SubagentResultOptions,
): Component {
	const text = textOf(result.content);
	const details = result.details as ParallelProgress | undefined;
	const tasks = Array.isArray(details?.tasks) ? details.tasks : [];
	// 分片推进期间登记重绘节拍（动画圈 + 耗时靠自己跳动），终态渲染时注销。
	if (options.isPartial && tasks.length > 0) {
		ticker.watch(options.toolCallId, options.invalidate, options.expanded ? EXPANDED_TICK_MS : SPINNER_MS);
	} else ticker.unwatch(options.toolCallId);
	if (tasks.length === 0) {
		return new Text(options.isError ? theme.fg("error", text) : theme.fg("toolOutput", text), 0, 0);
	}
	return new TaskListComponent({
		tasks, text, theme,
		expanded: options.expanded, isPartial: options.isPartial, isError: options.isError,
	});
}

/** 耗时自己跳动：一行一个重绘回调，整次调用只跑一个定时器。 */
class Ticker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private cadence = 0;
	private readonly rows = new Map<string, { invalidate: () => void; intervalMs: number; due: number }>();

	/** intervalMs 由调用方定：折叠态跟动画圈走，展开态放慢。 */
	watch(toolCallId: string, invalidate: () => void, intervalMs = SPINNER_MS): void {
		// 拿不到重绘句柄就不要走表，否则定时器只会白跑。
		if (typeof invalidate !== "function") return;
		this.rows.set(toolCallId, { invalidate, intervalMs, due: Date.now() + intervalMs });
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

	/** 定时器按最小节拍跑，每行只在自己的间隔到期时重绘。 */
	private reschedule(): void {
		const cadence = this.rows.size === 0 ? 0 : Math.min(...[...this.rows.values()].map((row) => row.intervalMs));
		if (cadence === this.cadence) return;
		this.stop();
		if (cadence === 0) return;
		this.cadence = cadence;
		const timer = setInterval(() => this.tick(), cadence);
		(timer as { unref?: () => void }).unref?.();
		this.timer = timer;
	}

	private tick(): void {
		const now = Date.now();
		for (const row of [...this.rows.values()]) {
			if (row.due > now) continue;
			row.due = now + row.intervalMs;
			try {
				row.invalidate();
			} catch {
				// 行已销毁：下一次 unwatch 或 dispose 会清掉它。
			}
		}
	}

	private stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.cadence = 0;
	}
}

/** 模块级单例：定时器数量与并行行数无关。 */
export const ticker = new Ticker();

interface TaskListOptions {
	tasks: TaskProgress[];
	text: string;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	theme: Theme;
}

/**
 * 结果视图：折叠态每个任务一行状态（单任务再给几行答案预览），展开态追加逐任务明细与完整回答。
 *
 * 布局只取决于 tasks.length，不依赖并发上限、调度策略或任务数量，因此并行落地时无需改动。
 */
class TaskListComponent implements Component {
	private lines: string[] | undefined;
	private width = -1;

	constructor(private readonly options: TaskListOptions) {}

	render(width: number): string[] {
		if (this.lines && this.width === width) return this.lines;
		this.width = width;
		this.lines = buildLines(this.options, width);
		return this.lines;
	}

	invalidate(): void {
		this.lines = undefined;
		this.width = -1;
	}
}

function buildLines(options: TaskListOptions, width: number): string[] {
	const { tasks, text, expanded, isPartial, isError, theme } = options;
	const multi = tasks.length > 1;
	// 一次渲染固定一帧，同一行里所有任务用同一个动画相位。
	const at = Date.now();
	const lines: string[] = [];
	if (multi) lines.push(summaryLine(tasks, theme, isError, at));
	const { shown, hidden } = selectTasks(tasks, expanded ? tasks.length : MAX_VISIBLE_TASKS);
	for (const task of shown) {
		lines.push(...taskLines(task, theme, multi, expanded, at).map((line) => truncateToWidth(line, width)));
	}
	if (hidden > 0) lines.push(theme.fg("muted", `  ... 另有 ${hidden} 项`));
	// 执行期间的 content 就是那行进度文本，不能当回答预览，也不能提示展开。
	if (isPartial) return lines;
	// 单任务截断时，提示文字已在上面用结构化形式给出，正文里不再重复一遍。
	const body = (tasks.length === 1 && tasks[0]?.truncated ? text.replace(TRUNCATION_NOTICE, "") : text).trim();
	if (expanded) {
		if (body) lines.push("", ...new Markdown(body, 0, 0, getMarkdownTheme()).render(width));
		return lines;
	}
	// 并行模式的结果文本是逐任务报告的拼接，折叠态只给状态与展开提示，不再截取预览。
	if (!multi) lines.push(...previewLines(text, tasks[0]?.truncated === true, theme, width));
	if (body) lines.push(keyHint("app.tools.expand", multi ? "展开任务与回答" : "查看完整回答"));
	return lines;
}

function summaryLine(tasks: TaskProgress[], theme: Theme, isError: boolean, at: number): string {
	const finished = tasks.filter((task) => TERMINAL_STATES.has(task.state)).length;
	const failed = tasks.filter((task) => task.state === "failed" || task.state === "timed_out").length;
	const active = tasks.find((task) => !TERMINAL_STATES.has(task.state));
	const glyph = failed > 0 || isError ? theme.fg("error", "✗")
		: finished === tasks.length ? theme.fg("success", "✓")
		: activeMark(active?.state ?? "running", theme, at);
	const parts = [failed > 0 ? `${finished}/${tasks.length} 结束` : `${finished}/${tasks.length} 完成`];
	if (failed > 0) parts.push(`${failed} 项失败`);
	const total = totalElapsed(tasks);
	if (total) parts.push(`总用时 ${total}`);
	return `${glyph} ${theme.fg("toolTitle", `parallel ${tasks.length}`)} ${theme.fg("muted", "·")} ${theme.fg("muted", parts.join(" · "))}`;
}

/** 折叠态挑选任务：运行中的全部保留，剩余名额给最近完成的任务。 */
function selectTasks(tasks: TaskProgress[], limit: number): { shown: TaskProgress[]; hidden: number } {
	if (tasks.length <= limit) return { shown: tasks, hidden: 0 };
	const active = tasks.filter((task) => !TERMINAL_STATES.has(task.state));
	const finished = tasks
		.filter((task) => TERMINAL_STATES.has(task.state))
		.sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
	const budget = Math.max(limit - active.length, 1);
	const keep = new Set([...active, ...finished.slice(0, budget)].map((task) => task.index));
	const shown = tasks.filter((task) => keep.has(task.index));
	return { shown, hidden: tasks.length - shown.length };
}

function taskLines(task: TaskProgress, theme: Theme, multi: boolean, expanded: boolean, at: number): string[] {
	const terminal = TERMINAL_MARKS[task.state];
	const parts = [terminal ? theme.fg(terminal.color, terminal.glyph) : activeMark(task.state, theme, at)];
	const label = `${multi ? `#${task.index} ` : ""}${task.agent}`;
	parts.push(expanded && task.model ? `${theme.fg("toolTitle", label)} ${theme.fg("dim", `(${task.model})`)}` : theme.fg("toolTitle", label));
	// 进行中不写状态词，只有终态需要说明原因（失败/已超时/已取消）。
	if (terminal?.label) parts.push(theme.fg("muted", "·"), theme.fg(terminal.color, terminal.label));
	if (!expanded && task.lastTool) parts.push(theme.fg("muted", `· ${task.lastTool}`));
	const elapsed = elapsedText(task);
	if (elapsed) parts.push(theme.fg("dim", `· ${elapsed}`));
	const usage = task.usage ? formatUsage(task.usage) : undefined;
	if (usage) parts.push(theme.fg("dim", `· ${usage}`));
	if (task.truncated && !expanded) parts.push(theme.fg("warning", "· 结果已截断"));
	const lines = [parts.join(" ")];
	if (!expanded) return lines;
	const trail = task.toolCalls
		?.filter((call) => call.count > 0)
		.map((call) => (call.count > 1 ? `${call.name} ×${call.count}` : call.name))
		.join(" · ");
	if (trail) lines.push(theme.fg("muted", `  → ${trail}`));
	if (task.truncated) {
		lines.push(theme.fg("warning", "  [结果已截断]"));
		if (task.fullOutputPath) lines.push(theme.fg("dim", `  完整结果：${task.fullOutputPath}`));
	}
	return lines;
}

/** 折叠态答案预览：去掉空行，只取开头几行，逐行按终端宽度截断。 */
function previewLines(text: string, truncated: boolean, theme: Theme, width: number): string[] {
	const body = truncated ? text.replace(TRUNCATION_NOTICE, "") : text;
	return body
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.slice(0, PREVIEW_LINES)
		.map((line) => theme.fg("toolOutput", truncateToWidth(line, width)));
}

function agentName(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim() : "（未指定 Agent）";
}

function previewLine(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const collapsed = value.replace(/\s+/gu, " ").trim();
	return collapsed ? truncateToWidth(collapsed, CALL_PREVIEW_WIDTH) : undefined;
}

function stateLabel(state: RunState): string {
	return STATE_LABELS[state] ?? state;
}

function elapsedText(task: TaskProgress): string | undefined {
	if (task.startedAt === undefined) return undefined;
	return formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
}

/** 整次调用耗时：最早开始到最晚结束，仍在运行的任务算到当前时刻。 */
function totalElapsed(tasks: TaskProgress[]): string | undefined {
	const starts = tasks.map((task) => task.startedAt).filter((value): value is number => value !== undefined);
	if (starts.length === 0) return undefined;
	const ends = tasks.map((task) => task.endedAt ?? Date.now());
	return formatDuration(Math.max(...ends) - Math.min(...starts));
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function formatUsage(usage: TaskUsage): string | undefined {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.costTotal) parts.push(`$${usage.costTotal.toFixed(4)}`);
	return parts.length ? parts.join(" ") : undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}
