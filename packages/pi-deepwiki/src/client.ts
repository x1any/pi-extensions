import { randomUUID } from "node:crypto";

const DEFAULT_ENDPOINT = "https://mcp.deepwiki.com/mcp";
const PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;
const ERROR_PREVIEW_CHARS = 4_000;

export type DeepWikiRemoteTool = "read_wiki_structure" | "read_wiki_contents" | "ask_question";

export type DeepWikiErrorKind = "cancelled" | "timeout" | "transport" | "http" | "protocol" | "remote";

export class DeepWikiError extends Error {
	readonly kind: DeepWikiErrorKind;
	readonly status?: number;

	constructor(kind: DeepWikiErrorKind, message: string, options?: ErrorOptions & { status?: number }) {
		super(`[${kind}] ${message}`, options);
		this.name = "DeepWikiError";
		this.kind = kind;
		this.status = options?.status;
	}
}

interface HttpResponse {
	body: string;
	contentType: string;
	sessionId?: string;
}

interface LinkedSignal {
	signal: AbortSignal;
	didTimeout(): boolean;
	dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return String(error);
}

function preview(value: unknown): string {
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	const normalized = text.trim();
	return normalized.length > ERROR_PREVIEW_CHARS
		? `${normalized.slice(0, ERROR_PREVIEW_CHARS)}…`
		: normalized;
}

function linkedSignal(parent?: AbortSignal): LinkedSignal {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error(`DeepWiki request timed out after ${REQUEST_TIMEOUT_MS}ms`));
	}, REQUEST_TIMEOUT_MS);
	timer.unref();

	const abortFromParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) abortFromParent();
	else parent?.addEventListener("abort", abortFromParent, { once: true });

	return {
		signal: controller.signal,
		didTimeout: () => timedOut,
		dispose() {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

function parseJson(text: string, context: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new DeepWikiError("protocol", `${context} 不是有效 JSON：${errorMessage(error)}。响应片段：${preview(text)}`, {
			cause: error,
		});
	}
}

/** 解析 Streamable HTTP 返回的 SSE；每个 data 事件应承载一个 JSON-RPC 消息。 */
function parseSse(body: string): unknown[] {
	const events = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split(/\n\n+/u);
	const messages: unknown[] = [];
	for (const event of events) {
		const data = event
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /u, ""))
			.join("\n");
		if (!data || data === "[DONE]") continue;
		const parsed = parseJson(data, "DeepWiki SSE data");
		if (Array.isArray(parsed)) messages.push(...parsed);
		else messages.push(parsed);
	}
	return messages;
}

function parseMessages(body: string, contentType: string): unknown[] {
	const trimmed = body.trim();
	if (!trimmed) return [];
	if (contentType.toLowerCase().includes("text/event-stream") || /^\s*(?:event|data):/u.test(body)) {
		const messages = parseSse(body);
		if (messages.length > 0) return messages;
	}
	const parsed = parseJson(trimmed, "DeepWiki response");
	return Array.isArray(parsed) ? parsed : [parsed];
}

function rpcErrorMessage(value: unknown): string {
	if (!isRecord(value)) return preview(value) || "未知 JSON-RPC 错误";
	const code = typeof value.code === "number" ? ` (${value.code})` : "";
	const message = typeof value.message === "string" ? value.message : "未知 JSON-RPC 错误";
	const data = value.data === undefined ? "" : `：${preview(value.data)}`;
	return `${message}${code}${data}`;
}

function extractToolText(result: unknown): string {
	if (!isRecord(result)) {
		throw new DeepWikiError("protocol", `tools/call 返回了无效结果：${preview(result)}`);
	}

	const textParts: string[] = [];
	if (Array.isArray(result.content)) {
		for (const item of result.content) {
			if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
				textParts.push(item.text);
			}
		}
	}

	let text = textParts.join("\n\n");
	if (!text && isRecord(result.structuredContent) && typeof result.structuredContent.result === "string") {
		text = result.structuredContent.result;
	}
	if (!text && result.structuredContent !== undefined) {
		text = JSON.stringify(result.structuredContent, null, 2);
	}

	if (result.isError === true) {
		throw new DeepWikiError("remote", text || "DeepWiki 工具返回错误，但未提供错误文本。");
	}
	if (!text) throw new DeepWikiError("protocol", "DeepWiki 工具成功返回，但响应中没有文本内容。");
	return text;
}

/** 只实现 DeepWiki 所需的 Streamable HTTP 子集，不注册或代理任意 MCP server。 */
export class DeepWikiClient {
	private readonly endpoint: string;
	private sessionId?: string;
	private negotiatedProtocolVersion = PROTOCOL_VERSION;
	private initialization?: Promise<void>;

	constructor(endpoint = DEFAULT_ENDPOINT) {
		this.endpoint = endpoint;
	}

	private async post(payload: unknown, signal: AbortSignal | undefined, includeSession: boolean): Promise<HttpResponse> {
		const linked = linkedSignal(signal);
		try {
			const headers: Record<string, string> = {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"MCP-Protocol-Version": this.negotiatedProtocolVersion,
			};
			if (includeSession && this.sessionId) headers["MCP-Session-Id"] = this.sessionId;

			const response = await fetch(this.endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: linked.signal,
			});
			const body = await response.text();
			if (!response.ok) {
				throw new DeepWikiError(
					"http",
					`DeepWiki MCP 返回 HTTP ${response.status}${body.trim() ? `：${preview(body)}` : ""}`,
					{ status: response.status },
				);
			}
			return {
				body,
				contentType: response.headers.get("content-type") ?? "",
				sessionId: response.headers.get("mcp-session-id") ?? undefined,
			};
		} catch (error) {
			if (error instanceof DeepWikiError) throw error;
			if (signal?.aborted) {
				throw new DeepWikiError("cancelled", "DeepWiki 请求已取消。", { cause: error });
			}
			if (linked.didTimeout()) {
				throw new DeepWikiError("timeout", `DeepWiki 请求超过 ${REQUEST_TIMEOUT_MS / 1000} 秒。`, { cause: error });
			}
			throw new DeepWikiError("transport", `无法连接 DeepWiki MCP：${errorMessage(error)}`, { cause: error });
		} finally {
			linked.dispose();
		}
	}

	private async request(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, includeSession = true): Promise<{ result: unknown; sessionId?: string }> {
		const id = randomUUID();
		const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal, includeSession);
		const message = parseMessages(response.body, response.contentType)
			.find((candidate) => isRecord(candidate) && candidate.id === id);
		if (!message || !isRecord(message)) {
			throw new DeepWikiError("protocol", `DeepWiki MCP 响应中没有请求 ${id} 对应的 JSON-RPC 消息。`);
		}
		if (message.error !== undefined) throw new DeepWikiError("remote", rpcErrorMessage(message.error));
		if (!("result" in message)) throw new DeepWikiError("protocol", "DeepWiki MCP 的 JSON-RPC 响应缺少 result。 ");
		return { result: message.result, sessionId: response.sessionId };
	}

	private async notify(method: string, signal: AbortSignal | undefined): Promise<void> {
		await this.post({ jsonrpc: "2.0", method }, signal, true);
	}

	private async initialize(signal: AbortSignal | undefined): Promise<void> {
		const { result, sessionId } = await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "pi-deepwiki", version: "0.1.0" },
		}, signal, false);
		if (!isRecord(result) || typeof result.protocolVersion !== "string") {
			throw new DeepWikiError("protocol", `initialize 返回了无效结果：${preview(result)}`);
		}
		this.negotiatedProtocolVersion = result.protocolVersion;
		this.sessionId = sessionId;
		await this.notify("notifications/initialized", signal);
	}

	private async ensureInitialized(signal: AbortSignal | undefined): Promise<void> {
		if (signal?.aborted) throw new DeepWikiError("cancelled", "DeepWiki 请求已取消。");
		if (!this.initialization) {
			const initialization = this.initialize(signal);
			this.initialization = initialization;
			initialization.catch(() => {
				if (this.initialization === initialization) {
					this.initialization = undefined;
					this.sessionId = undefined;
					this.negotiatedProtocolVersion = PROTOCOL_VERSION;
				}
			});
		}
		await this.initialization;
	}

	async callTool(tool: DeepWikiRemoteTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		await this.ensureInitialized(signal);
		const { result } = await this.request("tools/call", { name: tool, arguments: args }, signal);
		return extractToolText(result);
	}

	/** DeepWiki 当前是无会话服务；若未来返回 session id，则在会话关闭时按 MCP 规范尽力释放。 */
	async close(): Promise<void> {
		const sessionId = this.sessionId;
		this.initialization = undefined;
		this.sessionId = undefined;
		this.negotiatedProtocolVersion = PROTOCOL_VERSION;
		if (!sessionId) return;
		try {
			await fetch(this.endpoint, {
				method: "DELETE",
				headers: {
					Accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": PROTOCOL_VERSION,
					"MCP-Session-Id": sessionId,
				},
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			// 会话关闭是 best effort，不让远端清理失败阻塞 Pi 退出或 /reload。
		}
	}
}
