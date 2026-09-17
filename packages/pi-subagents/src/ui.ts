import { getMarkdownTheme, keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, sliceByColumn, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ParallelProgress, TaskProgress } from "./progress.ts";
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

/** 工具行标题：单任务只给 Agent 名，并行只给任务数；任务内容一律不进调用行。 */
export function renderSubagentCall(args: SubagentCallArgs | undefined, theme: Theme): Component {
	const taskCount = Array.isArray(args?.tasks) ? args.tasks.length : 0;
	const subject = taskCount > 0 ? `parallel ${taskCount}` : agentName(args?.agent);
	return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", subject), 0, 0);
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
 * 结果视图：单任务与并行走同一形态——执行中只给状态行，完成后折叠态追加展开提示，展开态追加任务明细与完整回答。
 *
 * 布局只取决于 tasks.length，不依赖并发上限、调度策略或任务数量，因此并行落地时无需改动。
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
	// 一次渲染固定一帧，同一行里所有任务用同一个动画相位。
	const at = Date.now();
	const lines: string[] = [];
	for (const task of tasks) {
		lines.push(...taskLines(task, theme, multi, detail, at).map((line) => clipToWidth(line, width)));
	}
	// 执行期间的 content 就是那行进度文本：只给状态，不追加明细或提示（detail 已为假）。
	if (isPartial) return lines;
	// 单任务截断时，提示文字已在上面用结构化形式给出，正文里不再重复一遍。
	const body = (tasks.length === 1 && tasks[0]?.truncated ? text.replace(TRUNCATION_NOTICE, "") : text).trim();
	if (detail) {
		if (body) lines.push("", ...new Markdown(body, 0, 0, getMarkdownTheme()).render(width));
		return lines;
	}
	// 折叠态一律只给状态与展开提示：单任务也不再截取回答预览，两种模式保持同一形态。
	if (body) lines.push(keyHint("app.tools.expand", "展开完整回答"));
	return lines;
}

function taskLines(task: TaskProgress, theme: Theme, multi: boolean, detail: boolean, at: number): string[] {
	const terminal = TERMINAL_MARKS[task.state];
	const parts = [terminal ? theme.fg(terminal.color, terminal.glyph) : activeMark(task.state, theme, at)];
	const label = `${multi ? `#${task.index} ` : ""}${task.agent}`;
	parts.push(theme.fg("toolTitle", label));
	// 进行中不写状态词，只有终态需要说明原因（失败/已超时/已取消）。
	if (terminal?.label) parts.push(theme.fg("muted", "·"), theme.fg(terminal.color, terminal.label));
	if (task.lastTool) parts.push(theme.fg("muted", `· ${task.lastTool}`));
	const elapsed = elapsedText(task);
	if (elapsed) parts.push(theme.fg("dim", `· ${elapsed}`));
	if (task.truncated && !detail) parts.push(theme.fg("warning", "· 结果已截断"));
	const lines = [parts.join(" ")];
	if (!detail) return lines;
	if (task.truncated) {
		lines.push(theme.fg("warning", "  [结果已截断]"));
		if (task.fullOutputPath) lines.push(theme.fg("dim", `  完整结果：${task.fullOutputPath}`));
	}
	return lines;
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

function agentName(value: unknown): string {
	return typeof value === "string" && value.trim() ? value.trim() : "（未指定 Agent）";
}

function stateLabel(state: RunState): string {
	return STATE_LABELS[state] ?? state;
}

function elapsedText(task: TaskProgress): string | undefined {
	if (task.startedAt === undefined) return undefined;
	return formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
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
