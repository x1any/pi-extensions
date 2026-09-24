import { randomUUID } from "node:crypto";

const ENDPOINT = "https://mcp.exa.ai/mcp";
const PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 120_000;

type ExaTool = "web_search_exa" | "web_fetch_exa";

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preview(value: string): string {
	const key = process.env.EXA_API_KEY;
	const safe = key ? value.replaceAll(key, "[redacted]") : value;
	return safe.trim().slice(0, 500);
}

function parseMessages(body: string, contentType: string): unknown[] {
	if (!body.trim()) return [];
	if (contentType.includes("text/event-stream") || /^\s*(?:event|data):/u.test(body)) {
		const messages: unknown[] = [];
		for (const event of body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split(/\n\n+/u)) {
			const data = event.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /u, ""))
				.join("\n");
			if (data && data !== "[DONE]") {
				const message: unknown = JSON.parse(data);
				messages.push(...(Array.isArray(message) ? message : [message]));
			}
		}
		return messages;
	}
	const message: unknown = JSON.parse(body);
	return Array.isArray(message) ? message : [message];
}

function toolText(result: unknown): string {
	if (!isRecord(result)) throw new Error("Exa MCP returned an invalid tool result.");
	const parts: string[] = [];
	if (Array.isArray(result.content)) {
		for (const item of result.content) {
			if (!isRecord(item)) continue;
			if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
			else if (item.type === "resource" && isRecord(item.resource) && typeof item.resource.text === "string") {
				parts.push(`Resource: ${String(item.resource.uri)}\n\n${item.resource.text}`);
			} else if (item.type === "resource_link" && typeof item.uri === "string") {
				parts.push(`Resource link: ${item.uri}`);
			} else {
				parts.push(`[Unsupported Exa MCP content type: ${String(item.type)}]`);
			}
		}
	}
	const text = parts.join("\n\n") || (result.structuredContent === undefined
		? ""
		: JSON.stringify(result.structuredContent, null, 2));
	if (result.isError === true) throw new Error(`Exa MCP tool failed: ${preview(text) || "no error details"}`);
	if (!text) throw new Error("Exa MCP returned no readable content.");
	return text;
}

/** Small, Exa-only Streamable HTTP client; no general MCP server discovery. */
export class ExaClient {
	private sessionId?: string;
	private protocolVersion = PROTOCOL_VERSION;
	private initializing?: Promise<void>;
	private initController?: AbortController;

	private headers(withSession: boolean): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"MCP-Protocol-Version": this.protocolVersion,
		};
		if (withSession && this.sessionId) headers["MCP-Session-Id"] = this.sessionId;
		if (process.env.EXA_API_KEY) headers["x-api-key"] = process.env.EXA_API_KEY;
		return headers;
	}

	private async post(payload: unknown, signal?: AbortSignal, withSession = true) {
		const response = await fetch(ENDPOINT, {
			method: "POST",
			headers: this.headers(withSession),
			body: JSON.stringify(payload),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await response.text();
		if (!response.ok) throw new HttpError(response.status, `Exa MCP HTTP ${response.status}: ${preview(body)}`);
		return { body, contentType: response.headers.get("content-type") ?? "", sessionId: response.headers.get("mcp-session-id") ?? undefined };
	}

	private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, withSession = true) {
		const id = randomUUID();
		const { body, contentType, sessionId } = await this.post({ jsonrpc: "2.0", id, method, params }, signal, withSession);
		const message = parseMessages(body, contentType).find((item) => isRecord(item) && item.id === id);
		if (!isRecord(message)) throw new Error(`Exa MCP ${method} response has no matching JSON-RPC id.`);
		if (message.error !== undefined) {
			throw new Error(`Exa MCP ${method} error: ${preview(JSON.stringify(message.error) ?? String(message.error))}`);
		}
		if (!("result" in message)) throw new Error(`Exa MCP ${method} response has no result.`);
		return { result: message.result, sessionId };
	}

	private async initialize(signal: AbortSignal): Promise<void> {
		const { result, sessionId } = await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "pi-exa", version: "0.1.0" },
		}, signal, false);
		if (!isRecord(result) || typeof result.protocolVersion !== "string") {
			throw new Error("Exa MCP initialize returned an invalid protocol version.");
		}
		this.protocolVersion = result.protocolVersion;
		this.sessionId = sessionId;
		await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
	}

	private async ready(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason ?? new Error("Exa request cancelled.");
		if (!this.initializing) {
			const controller = new AbortController();
			this.initController = controller;
			const initializing = this.initialize(controller.signal);
			this.initializing = initializing;
			void initializing.catch(() => {
				if (this.initializing === initializing) {
					this.initializing = undefined;
					this.sessionId = undefined;
					this.protocolVersion = PROTOCOL_VERSION;
				}
			});
		}
		if (!signal) return this.initializing;
		let onAbort: () => void = () => {};
		try {
			await Promise.race([
				this.initializing,
				new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(signal.reason ?? new Error("Exa request cancelled."));
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				}),
			]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async callTool(tool: ExaTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		await this.ready(signal);
		const sessionId = this.sessionId;
		let response: { result: unknown; sessionId?: string };
		try {
			response = await this.request("tools/call", { name: tool, arguments: args }, signal);
		} catch (error) {
			// A 404 for a session-bearing request means the MCP session expired.
			// Search/fetch are read-only, so reconnecting and retrying once is safe.
			if (!(error instanceof HttpError && error.status === 404 && sessionId)) throw error;
			if (this.sessionId === sessionId) {
				this.initializing = undefined;
				this.sessionId = undefined;
				this.protocolVersion = PROTOCOL_VERSION;
			}
			await this.ready(signal);
			response = await this.request("tools/call", { name: tool, arguments: args }, signal);
		}
		return toolText(response.result);
	}

	async close(): Promise<void> {
		this.initController?.abort();
		await this.initializing?.catch(() => undefined);
		const sessionId = this.sessionId;
		this.sessionId = undefined;
		this.initializing = undefined;
		if (!sessionId) return;
		try {
			await fetch(ENDPOINT, {
				method: "DELETE",
				headers: { ...this.headers(false), "MCP-Session-Id": sessionId },
				signal: AbortSignal.timeout(5_000),
			});
		} catch {
			// Session cleanup is best effort.
		}
	}
}
