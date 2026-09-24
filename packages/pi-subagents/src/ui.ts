import { getMarkdownTheme, keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, sliceByColumn, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CallProgress, TaskProgress, ToolCallProgress, ToolCallState } from "./progress.ts";
import { TERMINAL_STATES } from "./progress.ts";
import type { RunState } from "./runner.ts";

/** 进行中的行统一用动画圈，不写状态词。 */
const SPINNER_MS = 120;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** details 被清空时的回退行数，与 Pi 自带 fallback 一致。 */
const FALLBACK_LINES = 10;
/** 省略号占 3 列。 */
const ELLIPSIS = "...";

/** 状态文案：只用于 onUpdate 的一行文本。 */
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

/** 终态标记：只有失败/超时/取消在行里写明原因。 */
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

/** 动画圈按时间取帧：同一时刻所有行相位一致。 */
function spinnerFrame(at: number): string {
	return SPINNER_FRAMES[Math.floor(at / SPINNER_MS) % SPINNER_FRAMES.length] as string;
}

/** 排队用暗色、重试用警告色，都不加状态词。 */
function activeColor(state: RunState): ThemeColor {
	if (state === "waiting") return "muted";
	if (state === "retrying") return "warning";
	return "accent";
}

function activeMark(state: RunState, theme: Theme, at: number): string {
	return theme.fg(activeColor(state), spinnerFrame(at));
}

/** 截断提示由 runner 拼在文本开头，UI 用结构化标注替代，正文里要去掉。 */
const TRUNCATION_NOTICE = /^\[结果已截断[^\]]*\]\n*/gmu;
/** 旧会话多任务报告的首行汇总与树上重复，展开渲染时移除。 */
const REPORT_SUMMARY = /^\d+\/\d+ 成功(?:\r?\n)+/u;

/** 工具结果：出错时 Pi 可能覆盖 details，这里不假设 shape。 */
export interface SubagentResult {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: unknown;
}

/** 渲染选项：Pi 选项 + 错误标记与重绘句柄。 */
export interface SubagentResultOptions {
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	toolCallId: string;
	invalidate: () => void;
	args?: unknown;
}

/** onUpdate 的一行文本（RPC、print 也会收到）：agent、状态与细节。 */
export function formatProgressText(progress: CallProgress): string {
	const task = progress.tasks[0];
	if (!task) return "子任务尚未开始。";
	const elapsed = elapsedText(task);
	const detail = [
		task.lastTool ? `最近工具：${task.lastTool}` : "",
		elapsed ? `已用时 ${elapsed}` : "",
	].filter(Boolean).join("；");
	return `${task.agent}：${stateLabel(task.state)}${detail ? `（${detail}）` : ""}`;
}

/** 从调用参数取任务名：新形态单个 agent，旧会话是多项 tasks。 */
function plannedAgents(args: unknown): string[] {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
	const single = (args as { agent?: unknown }).agent;
	if (typeof single === "string" && single.trim()) return [single.trim()];
	const tasks = (args as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return [];
	return tasks.map((task) => {
		if (typeof task !== "object" || task === null || Array.isArray(task)) return "?";
		const agent = (task as { agent?: unknown }).agent;
		return typeof agent === "string" && agent.trim() ? agent.trim() : "?";
	});
}

/** 合并 details 与调用参数；details 缺失时用参数补骨架。 */
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

/** 工具行标题：单任务给 agent 名，旧会话多任务给任务数。 */
export function renderSubagentCall(args: unknown, theme: Theme): Component {
	const names = plannedAgents(args);
	const suffix = names.length > 0
		? theme.fg("muted", ` · ${names.length > 1 ? `${names.length} 项` : names[0]}`)
		: "";
	return new Text(theme.fg("toolTitle", theme.bold("subagent")) + suffix, 0, 0);
}

/** 结果渲染：优先 details，缺失时从参数恢复骨架；单任务与旧会话分别渲染。 */
export function renderSubagentResult(
	result: SubagentResult,
	theme: Theme,
	options: SubagentResultOptions,
): Component {
	const text = textOf(result.content);
	const details = result.details as CallProgress | undefined;
	const tasks = tasksForRender(details, options.args, options.isError);
	// 推进期间登记重绘节拍，终态注销。
	if (options.isPartial && tasks.length > 0) {
		ticker.watch(options.toolCallId, options.invalidate);
	} else ticker.unwatch(options.toolCallId);
	if (tasks.length === 0) {
		return plainResult(text, options, theme);
	}
	// 新调用固定单任务：一张卡片一个回答。
	if (tasks.length === 1) {
		return new SingleTaskComponent({
			task: tasks[0] as TaskProgress, text, theme,
			expanded: options.expanded, isPartial: options.isPartial,
		});
	}
	return new TaskListComponent({
		tasks, text, theme,
		expanded: options.expanded, isPartial: options.isPartial,
	});
}

/** details 被清空时的回退：折叠态只给开头几行。 */
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

/** 进行中的行按固定节拍重绘：整体只用一个定时器。 */
class Ticker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly rows = new Map<string, () => void>();

	watch(toolCallId: string, invalidate: () => void): void {
		// 没有重绘句柄就不走表。
		if (typeof invalidate !== "function") return;
		this.rows.set(toolCallId, invalidate);
		this.reschedule();
	}

	unwatch(toolCallId: string): void {
		this.rows.delete(toolCallId);
		this.reschedule();
	}

	/** 会话结束或重载时清空，不留指向旧界面的定时器。 */
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
				// 行已销毁：后续 unwatch/dispose 会清掉。
			}
		}
	}

	private stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

/** 模块级单例：定时器数量与行数无关。 */
export const ticker = new Ticker();

interface SingleTaskOptions {
	task: TaskProgress;
	text: string;
	expanded: boolean;
	isPartial: boolean;
	theme: Theme;
}

/** 单任务卡片：标题给出 agent，结果区只画进度、状态说明与回答。 */
class SingleTaskComponent implements Component {
	constructor(private readonly options: SingleTaskOptions) {}

	render(width: number): string[] {
		return buildSingleLines(this.options, width);
	}

	/** 没有需要失效的缓存（Pi 会重建组件）。 */
	invalidate(): void {}
}

function buildSingleLines(options: SingleTaskOptions, width: number): string[] {
	const { task, text, expanded, isPartial, theme } = options;
	// 明细只在完成后生效：进度文本不是回答。
	const detail = expanded && !isPartial;
	// 一次渲染固定一帧，动画与耗时同相位。
	const at = Date.now();
	const terminal = TERMINAL_MARKS[task.state];
	const lines: string[] = [];

	// 执行中给一行进度；完成后只给回答。
	if (isPartial) {
		lines.push(clipToWidth(progressLine(task, theme, at), width));
	} else if (terminal?.label) {
		// 只有失败/超时/取消写状态行，与普通工具结果一致。
		lines.push(clipToWidth(statusLine(task, theme, at), width));
	}
	// 截断提示保留完整文件路径，是查看完整回答的入口。
	if (!isPartial && task.truncated) {
		const path = task.fullOutputPath ? theme.fg("dim", ` · ${task.fullOutputPath}`) : "";
		lines.push(clipToWidth(theme.fg("warning", "结果已截断") + path, width));
	}

	// 执行期间 content 就是进度文本，不再重复追加。
	if (isPartial) return lines;
	const body = text.replace(TRUNCATION_NOTICE, "").trim();
	if (!body) return lines;
	if (detail) {
		if (lines.length > 0) lines.push("");
		lines.push(...new Markdown(body, 0, 0, getMarkdownTheme()).render(width));
		return lines;
	}
	lines.push(...previewLines(body, theme, width));
	return lines;
}

/** 执行中的进度行：动画圈 + 最近工具 + 耗时。 */
function progressLine(task: TaskProgress, theme: Theme, at: number): string {
	const parts = [markGlyph(task, theme, at)];
	if (task.lastTool) parts.push(theme.fg("muted", `· ${task.lastTool}`));
	const elapsed = elapsedText(task);
	if (elapsed) parts.push(theme.fg("dim", `· ${elapsed}`));
	return parts.join(" ");
}

/** 终态行：失败、超时与取消，附耗时。 */
function statusLine(task: TaskProgress, theme: Theme, at: number): string {
	const parts = [markGlyph(task, theme, at), ...terminalLabel(task, theme)];
	const elapsed = elapsedText(task);
	if (elapsed) parts.push(theme.fg("dim", `· ${elapsed}`));
	return parts.join(" ");
}

/** 折叠态预览：前几行 + 展开提示。 */
function previewLines(body: string, theme: Theme, width: number): string[] {
	const lines = body.split("\n");
	if (lines.length <= FALLBACK_LINES) {
		return lines.map((line) => clipToWidth(theme.fg("toolOutput", line), width));
	}
	const hidden = lines.length - FALLBACK_LINES;
	const preview = lines.slice(0, FALLBACK_LINES)
		.map((line) => clipToWidth(theme.fg("toolOutput", line), width));
	const hint = theme.fg("muted", `... 另有 ${hidden} 行 `) + keyHint("app.tools.expand", "展开完整回答");
	preview.push(clipToWidth(hint, width));
	return preview;
}

interface TaskListOptions {
	tasks: TaskProgress[];
	text: string;
	expanded: boolean;
	isPartial: boolean;
	theme: Theme;
}

/** 旧会话多任务树：只服务历史记录里的多任务 details。 */
class TaskListComponent implements Component {
	constructor(private readonly options: TaskListOptions) {}

	render(width: number): string[] {
		return buildLines(this.options, width);
	}

	/** 没有需要失效的缓存（Pi 会重建组件）。 */
	invalidate(): void {}
}

function buildLines(options: TaskListOptions, width: number): string[] {
	const { tasks, text, expanded, isPartial, theme } = options;
	const multi = tasks.length > 1;
	// 明细只在完成后生效：进度文本不是回答。
	const detail = expanded && !isPartial;
	// 一次渲染固定一帧，全部任务与工具同相位。
	const at = Date.now();
	const lines: string[] = [clipToWidth(summaryLine(tasks, isPartial, theme), width)];
	for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index] as TaskProgress;
		lines.push(...taskLines(
			task, theme, multi, detail, isPartial, at, index === tasks.length - 1,
		).map((line) => clipToWidth(line, width)));
	}
	// 执行期间 content 就是进度文本，不再重复追加。
	if (isPartial) return lines;
	// 截断提示已由任务节点给出，正文不再重复。
	const body = text.replace(TRUNCATION_NOTICE, "").trim();
	const report = body.replace(REPORT_SUMMARY, "").trim();
	if (detail) {
		if (report) {
			lines.push("", clipToWidth(theme.fg("muted", "完整回答"), width));
			lines.push(...new Markdown(report, 0, 0, getMarkdownTheme()).render(width));
		}
		return lines;
	}
	// 折叠态只给树与展开提示。
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

/** 进行中给动画圈，终态给标记。 */
function markGlyph(task: TaskProgress, theme: Theme, at: number): string {
	const terminal = TERMINAL_MARKS[task.state];
	return terminal ? theme.fg(terminal.color, terminal.glyph) : activeMark(task.state, theme, at);
}

/** 终态说明：只有失败/超时/取消写原因。 */
function terminalLabel(task: TaskProgress, theme: Theme): string[] {
	const terminal = TERMINAL_MARKS[task.state];
	if (!terminal?.label) return [];
	return [theme.fg("muted", "·"), theme.fg(terminal.color, terminal.label)];
}

/** 工具计数；没有记录时退回最近工具名。 */
function toolFacts(task: TaskProgress, theme: Theme): string[] {
	const toolCount = (task.omittedTools ?? 0) + (task.tools?.length ?? 0);
	if (toolCount > 0) return [theme.fg("muted", `· ${toolCount} 个工具`)];
	return task.lastTool ? [theme.fg("muted", `· ${task.lastTool}`)] : [];
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
	const label = `${multi ? `#${task.index} ` : ""}${task.agent}`;
	const parts = [connector, markGlyph(task, theme, at), theme.fg("toolTitle", label), ...terminalLabel(task, theme)];
	parts.push(...toolFacts(task, theme));
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
 * 不能用 pi-tui 的 truncateToWidth：它在省略号两侧插全量重置，会把 Pi 工具卡片
 * 由外层 Box 铺的底色一起清掉（省略号及右侧回落成终端默认底色）。
 */
function clipToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	// 极窄宽度下省略号自己也要裁，否则会超宽。
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
