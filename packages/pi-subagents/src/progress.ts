import type { ConcurrencyView, RunProgress, RunState } from "./runner.ts";

/** 终态：任务不会再有新进度；渲染层与进度合并共用这一份定义。 */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
	"completed",
	"cancelled",
	"timed_out",
	"failed",
]);

/** 非状态变化的合并窗口：并行时 N 个任务的高频事件只触发一次重绘。 */
const COALESCE_MS = 200;

/** 单任务累计用量；由 runner 采集后填入，展示层只读不推导。 */
export interface TaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costTotal: number;
}

/** 单任务状态。index 是唯一的稳定排序键，乱序完成时展示顺序也不变。 */
export interface TaskProgress {
	index: number;
	agent: string;
	model?: string;
	state: RunState;
	lastTool?: string;
	toolCalls?: Array<{ name: string; count: number }>;
	startedAt?: number;
	endedAt?: number;
	usage?: TaskUsage;
	truncated?: boolean;
	fullOutputPath?: string;
}

/** 一次工具调用的完整进度快照：单任务即 tasks.length === 1，并行即 N 个任务。 */
export interface ParallelProgress {
	mode: "single" | "parallel";
	concurrency?: ConcurrencyView;
	tasks: TaskProgress[];
}

/** 任务级进度的汇入点：对每个任务注册一次，输入是 runner 的进度事件。 */
export type TaskSink = (progress: RunProgress) => void;

/**
 * 把任务级进度合并成 ParallelProgress。
 *
 * 与调度解耦：每次 run() 注册一个 task(index)，并行调用只是对每个任务各注册一次，
 * 本模块与渲染层都不需要知道并发上限、队列位置或任务数量。
 * 状态变化立即刷新，只变了最近工具时合并到一个窗口。
 */
export class ProgressHub {
	private readonly tasks = new Map<number, TaskProgress>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	/** flush 只做展示（onUpdate），内部吞掉异常，不得影响子任务执行。 */
	constructor(
		private readonly flush: (progress: ParallelProgress) => void,
		/** 调度视图来源：生成快照时读一次。并行时由 runner 单例给出全局并发量。 */
		private readonly concurrency?: () => ConcurrencyView,
	) {}

	/** 注册任务并返回它的进度汇入点；同一 index 重复注册会重置该任务状态。 */
	task(index: number, agent: string): TaskSink {
		this.tasks.set(index, { index, agent, state: "waiting", toolCalls: [] });
		return (progress) => {
			this.update(index, progress);
		};
	}

	/** 解析出 Agent 与模型后回填展示信息。 */
	describe(index: number, patch: { agent?: string; model?: string }): void {
		const task = this.tasks.get(index);
		if (!task) return;
		if (patch.agent) task.agent = patch.agent;
		if (patch.model) task.model = patch.model;
	}

	/** 写入终态附加信息（截断、临时文件路径），返回最终 details 快照。 */
	complete(index: number, patch: Partial<TaskProgress>): ParallelProgress {
		const task = this.tasks.get(index);
		if (task) {
			Object.assign(task, patch);
			// 终态必须冻结耗时：否则后续重绘（缩放、展开）会让已结束任务的耗时继续增长。
			if (TERMINAL_STATES.has(task.state) && task.endedAt === undefined) task.endedAt = Date.now();
		}
		return this.snapshot();
	}

	/** 当前 details 快照：tasks 按 index 升序，与事件到达顺序无关；并发量现读现填。 */
	snapshot(): ParallelProgress {
		const tasks = [...this.tasks.values()]
			.sort((left, right) => left.index - right.index)
			.map((task) => ({ ...task, toolCalls: task.toolCalls?.map((call) => ({ ...call })) }));
		const concurrency = this.concurrency?.();
		return {
			mode: tasks.length > 1 ? "parallel" : "single",
			...(concurrency ? { concurrency } : {}),
			tasks,
		};
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimer();
	}

	private update(index: number, progress: RunProgress): void {
		if (this.disposed) return;
		const task = this.tasks.get(index);
		if (!task || TERMINAL_STATES.has(task.state)) return;
		const stateChanged = task.state !== progress.state;
		task.state = progress.state;
		const toolChanged = progress.lastTool !== undefined && progress.lastTool !== task.lastTool;
		if (progress.lastTool !== undefined) {
			task.lastTool = progress.lastTool;
			// 只在真正开始一次工具调用时累计轨迹：后续事件会重复带上同一个工具名。
			if (progress.state === "tool") this.countTool(task, progress.lastTool);
		}
		// 排队不计入耗时：只有真正开始执行过的任务才记起点，排队中就被取消或失败的任务没有耗时。
		if (task.startedAt === undefined && progress.state !== "waiting" && !TERMINAL_STATES.has(progress.state)) {
			task.startedAt = Date.now();
		}
		if (TERMINAL_STATES.has(progress.state)) task.endedAt ??= Date.now();
		if (stateChanged) this.flushNow();
		else if (toolChanged) this.scheduleFlush();
		// 状态与工具名都没变的重复事件不重绘。
	}

	private countTool(task: TaskProgress, name: string): void {
		const calls = task.toolCalls ?? (task.toolCalls = []);
		const last = calls[calls.length - 1];
		if (last && last.name === name) last.count += 1;
		else calls.push({ name, count: 1 });
	}

	/** 立即刷新并返回同一份快照。 */
	private flushNow(): ParallelProgress {
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
