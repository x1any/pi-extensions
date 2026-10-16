/** herdr 0.9.5 CLI adapter: native argv, JSON responses, no mutation retries. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HandoffDestination } from "./options.ts";

const execFileAsync = promisify(execFile);
export const INIT_FLAG = "pi-handoff-init";
export const STORE_FLAG = "pi-handoff-store";
const START_TIMEOUT_MS = 60_000;

export interface HerdrEnvironment {
	executable: string;
	workspaceId: string;
	paneId: string;
}

export function herdrEnvironment(env: NodeJS.ProcessEnv = process.env): HerdrEnvironment {
	if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) {
		throw new Error("This destination requires a herdr-managed pane. Use /handoff --here explicitly for an in-place handoff.");
	}
	return {
		executable: env.HERDR_BIN_PATH || "herdr",
		workspaceId: env.HERDR_WORKSPACE_ID,
		paneId: env.HERDR_PANE_ID,
	};
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid herdr JSON response");
	return value as Record<string, unknown>;
}

function field(value: Record<string, unknown>, name: string): string {
	const result = value[name];
	if (typeof result !== "string" || !result || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`herdr response is missing ${name}`);
	return result;
}

export function parseHerdrResponse(output: string): Record<string, unknown> {
	let raw: Record<string, unknown>;
	try { raw = object(JSON.parse(output)); }
	catch { throw new Error("herdr returned invalid JSON; inspect the layout before retrying"); }
	if (raw.error !== undefined) {
		const error = object(raw.error);
		throw new Error(`herdr ${field(error, "code")}: ${field(error, "message")}`);
	}
	return object(raw.result);
}

export type HerdrRunner = (args: string[], timeoutMs: number, signal: AbortSignal) => Promise<Record<string, unknown>>;

export interface HerdrTarget {
	paneId: string;
	terminalId: string;
	name: string;
}

export class HerdrClient {
	private readonly run: HerdrRunner;
	readonly environment: HerdrEnvironment;

	constructor(environment: HerdrEnvironment, runner?: HerdrRunner) {
		this.environment = environment;
		this.run = runner ?? (async (args, timeoutMs, signal) => {
			try {
				const { stdout } = await execFileAsync(environment.executable, args, {
					windowsHide: true, timeout: timeoutMs, signal, maxBuffer: 1024 * 1024,
				});
				return parseHerdrResponse(stdout);
			} catch (error) {
				if (error instanceof Error && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim().startsWith("{")) {
					parseHerdrResponse(error.stderr);
				}
				// Do not expose execFile's command line or retry a potentially applied mutation.
				throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed or timed out; it may already have taken effect. Inspect herdr before retrying.`, { cause: error });
			}
		});
	}

	async create(destination: Exclude<HandoffDestination, "here">, cwd: string, id: string, signal: AbortSignal): Promise<HerdrTarget> {
		const result = destination === "tab"
			? await this.run(["tab", "create", "--workspace", this.environment.workspaceId, "--cwd", cwd, "--label", "Pi handoff", "--no-focus"], 15_000, signal)
			: await this.run(["pane", "split", "--pane", this.environment.paneId, "--direction", destination, "--cwd", cwd, "--no-focus"], 15_000, signal);
		if (destination === "tab") field(object(result.tab), "tab_id");
		const pane = object(destination === "tab" ? result.root_pane : result.pane);
		const paneId = field(pane, "pane_id");
		if (pane.workspace_id !== this.environment.workspaceId || paneId === this.environment.paneId) {
			throw new Error("herdr created an unexpected destination; inspect the layout before retrying");
		}
		return { paneId, terminalId: field(pane, "terminal_id"), name: `handoff-${id.slice(0, 24)}` };
	}

	async start(target: HerdrTarget, id: string, store: string, extension: string, signal: AbortSignal): Promise<void> {
		// Deliberately NO initial message: a missing/broken extension must never turn
		// an unrecognized initialization slash command into a provider request.
		const result = await this.run([
			"agent", "start", target.name, "--kind", "pi", "--pane", target.paneId, "--timeout", String(START_TIMEOUT_MS),
			"--", "--extension", extension, `--${INIT_FLAG}`, id, `--${STORE_FLAG}`, store,
		], START_TIMEOUT_MS + 10_000, signal);
		this.validateAgent(object(result.agent), target);
	}

	private validateAgent(agent: Record<string, unknown>, target: HerdrTarget): void {
		if (agent.pane_id !== target.paneId || agent.terminal_id !== target.terminalId || agent.name !== target.name || agent.agent !== "pi") {
			throw new Error("herdr target agent identity changed; not focusing it");
		}
	}

	async focus(target: HerdrTarget, signal: AbortSignal, expected: { sessionId: string; sessionFile?: string }): Promise<void> {
		const result = await this.run(["agent", "get", target.name], 10_000, signal);
		const agent = object(result.agent);
		this.validateAgent(agent, target);
		// Integration v9 already reports session_start before withSession runs.
		// A ready receipt must not focus a Pi that has since switched sessions.
		const session = object(agent.agent_session);
		if (session.value !== expected.sessionId && (!expected.sessionFile || session.value !== expected.sessionFile)) {
			throw new Error("herdr target Pi session changed after initialization; not focusing it");
		}
		await this.run(["agent", "focus", target.name], 10_000, signal);
	}
}
