import type { RunProgress, RunState, ToolProgressEvent } from "./runner.ts";

/** 终态：任务不会再有新进度；渲染层与进度合并共用这一份定义。 */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
	"completed",
	"cancelled",
	"timed_out",
	"failed",
]);

/** 高频进度事件合并成一次重绘的窗口。 */
const COALESCE_MS = 200;
/** 每个任务只保留最近的终态工具；仍在执行的工具不会为了命中上限而被丢弃。 */
const MAX_TOOL_HISTORY = 20;

export type ToolCallState = "running" | "completed" | "failed" | "interrupted";

/** 子 Agent 的一次工具调用；只保留名称、状态和时刻，不持久化参数或结果。 */
export interface ToolCallProgress {
	id: string;
	name: string;
	state: ToolCallState;
	startedAt: number;
	endedAt?: number;
}

/** 单任务状态。index 是唯一的稳定排序键，乱序完成时展示顺序也不变。 */
export interface TaskProgress {
	index: number;
	agent: string;
	state: RunState;
	lastTool?: string;
	startedAt?: number;
	endedAt?: number;
	truncated?: boolean;
	fullOutputPath?: string;
	/** 可选是为了兼容恢复旧会话时尚未包含工具轨迹的 details。 */
	tools?: ToolCallProgress[];
	omittedTools?: number;
}

/** 一次工具调用的完整进度快照：单项调用即 tasks.length === 1。 */
export interface CallProgress {
	tasks: TaskProgress[];
}

/** 任务级进度的汇入点：对每个任务注册一次，输入是 runner 的进度事件。 */
export type TaskSink = (progress: RunProgress) => void;

function trimToolHistory(task: TaskProgress): void {
	const tools = task.tools ?? [];
	while (tools.length > MAX_TOOL_HISTORY) {
		const removable = tools.findIndex((tool) => tool.state !== "running");
		if (removable < 0) return;
		tools.splice(removable, 1);
		task.omittedTools = (task.omittedTools ?? 0) + 1;
	}
}

/** 工具事件按 id 合并；重复事件幂等，结束事件缺少 start 时也保留一个完整节点。 */
function applyToolEvent(task: TaskProgress, event: ToolProgressEvent, at: number): boolean {
	const tools = task.tools ??= [];
	let matched: ToolCallProgress | undefined;
	for (let index = tools.length - 1; index >= 0; index -= 1) {
		const candidate = tools[index] as ToolCallProgress;
		if (candidate.id === event.id) {
			matched = candidate;
			break;
		}
	}
	if (event.phase === "started") {
		if (matched?.state === "running") return false;
		tools.push({ id: event.id, name: event.name, state: "running", startedAt: at });
		trimToolHistory(task);
		return true;
	}
	if (matched && matched.state !== "running") return false;
	if (!matched) {
		tools.push({
			id: event.id, name: event.name, state: event.isError ? "failed" : "completed",
			startedAt: at, endedAt: at,
		});
	} else {
		matched.name = event.name;
		matched.state = event.isError ? "failed" : "completed";
		matched.endedAt = at;
	}
	trimToolHistory(task);
	return true;
}

/** 任务已终止但工具没有 end 事件时，显式收敛为中断，避免恢复后仍显示动画圈。 */
function interruptOpenTools(task: TaskProgress, at: number): boolean {
	let changed = false;
	for (const tool of task.tools ?? []) {
		if (tool.state !== "running") continue;
		tool.state = "interrupted";
		tool.endedAt = at;
		changed = true;
	}
	trimToolHistory(task);
	return changed;
}

/**
 * 把任务级进度合并成 CallProgress。
 *
 * 每次 run() 注册一个 task(index)；不感知并发上限、队列位置或任务数量。
 * 状态变化立即刷新，只变了最近工具时合并到一个窗口。
 */
export class ProgressHub {
	private readonly tasks = new Map<number, TaskProgress>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	/** flush 只做展示（onUpdate），内部吞掉异常，不得影响子任务执行。 */
	constructor(private readonly flush: (progress: CallProgress) => void) {}

	/** 注册任务并返回它的进度汇入点；同一 index 重复注册会重置该任务状态。 */
	task(index: number, agent: string): TaskSink {
		this.tasks.set(index, { index, agent, state: "waiting", tools: [], omittedTools: 0 });
		return (progress) => {
			this.update(index, progress);
		};
	}

	/** 写入终态附加信息（截断、临时文件路径）。 */
	complete(index: number, patch: Partial<TaskProgress>): void {
		const task = this.tasks.get(index);
		if (task) {
			Object.assign(task, patch);
			// 终态必须冻结耗时：否则后续重绘（缩放、展开）会让已结束任务的耗时继续增长。
			if (TERMINAL_STATES.has(task.state)) {
				const at = Date.now();
				task.endedAt ??= at;
				interruptOpenTools(task, at);
			}
		}
	}

	/** 当前 details 快照：tasks 按 index 升序，与事件到达顺序无关；嵌套工具数组也要复制。 */
	snapshot(): CallProgress {
		const tasks = [...this.tasks.values()]
			.sort((left, right) => left.index - right.index)
			.map((task) => ({
				...task,
				tools: (task.tools ?? []).map((tool) => ({ ...tool })),
			}));
		return { tasks };
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimer();
	}

	private update(index: number, progress: RunProgress): void {
		if (this.disposed) return;
		const task = this.tasks.get(index);
		if (!task || TERMINAL_STATES.has(task.state)) return;
		const at = Date.now();
		let traceChanged = progress.tool ? applyToolEvent(task, progress.tool, at) : false;
		const stateChanged = task.state !== progress.state;
		task.state = progress.state;
		const lastToolChanged = progress.lastTool !== undefined && progress.lastTool !== task.lastTool;
		if (progress.lastTool !== undefined) task.lastTool = progress.lastTool;
		// 排队不计入耗时：只有真正开始执行过的任务才记起点，排队中就被取消或失败的任务没有耗时。
		if (task.startedAt === undefined && progress.state !== "waiting" && !TERMINAL_STATES.has(progress.state)) {
			task.startedAt = at;
		}
		if (TERMINAL_STATES.has(progress.state)) {
			task.endedAt ??= at;
			traceChanged = interruptOpenTools(task, at) || traceChanged;
		}
		if (stateChanged) this.flushNow();
		else if (lastToolChanged || traceChanged) this.scheduleFlush();
		// 历史始终先落入内存；合并窗口只限制重绘频率，不会吞掉中间工具事件。
	}

	/** 立即刷新并返回同一份快照。 */
	private flushNow(): CallProgress {
		this.clearTimer();
		const progress = this.snapshot();
		try {
			this.flush(progress);
		} catch {
			// 展示失败不能中断子任务。
		}
		return progress;
	}

	private scheduleFlush(): void {
		if (this.timer || this.disposed) return;
		const timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.disposed) this.flushNow();
		}, COALESCE_MS);
		unref(timer);
		this.timer = timer;
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}

function unref(timer: ReturnType<typeof setTimeout>): void {
	(timer as { unref?: () => void }).unref?.();
}
