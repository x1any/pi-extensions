import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ExaClient } from "./src/client.ts";

const SearchParameters = Type.Object({
	query: Type.String({ minLength: 1, description: "Natural-language web search query." }),
	numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Results to return (Exa default: 10)." })),
}, { additionalProperties: false });

const FetchParameters = Type.Object({
	urls: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: 10,
		description: "HTTP(S) URLs to fetch; batch up to 10 pages per call.",
	}),
	maxCharacters: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum characters per page (Exa default: 3000)." })),
}, { additionalProperties: false });

interface ExaDetails {
	remoteTool: "web_search_exa" | "web_fetch_exa";
	truncated: boolean;
	fullOutputPath?: string;
}

class OutputStore {
	private directoryPromise?: Promise<string>;

	async bound(text: string, hint: string, signal?: AbortSignal): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
		// Leave room for the truncation notice while staying within Pi's tool-output limits.
		const output = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 1024, maxLines: DEFAULT_MAX_LINES - 2 });
		if (!output.truncated) return { text, truncated: false };
		if (signal?.aborted) throw signal.reason ?? new Error("Exa request cancelled.");
		if (!this.directoryPromise) {
			const creating = mkdtemp(join(tmpdir(), "pi-exa-"));
			this.directoryPromise = creating;
			void creating.catch(() => {
				if (this.directoryPromise === creating) this.directoryPromise = undefined;
			});
		}
		const path = join(await this.directoryPromise, `${hint}-${randomUUID()}.md`);
		await withFileMutationQueue(path, () => writeFile(path, text, { encoding: "utf8", signal }));
		return {
			text: `${output.content}\n\n[Exa output truncated: ${output.outputLines}/${output.totalLines} lines, ${formatSize(output.outputBytes)}/${formatSize(output.totalBytes)}. Full output: ${path} (available until session shutdown).]`,
			truncated: true,
			fullOutputPath: path,
		};
	}

	async cleanup(): Promise<void> {
		const directory = this.directoryPromise;
		this.directoryPromise = undefined;
		const path = await directory?.catch(() => undefined);
		if (path) await rm(path, { recursive: true, force: true }).catch(() => undefined);
	}
}

function httpUrls(urls: string[]): string[] {
	return urls.map((value) => {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error("web_fetch requires valid HTTP(S) URLs.");
		}
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
			throw new Error("web_fetch only accepts HTTP(S) URLs without embedded credentials.");
		}
		return value;
	});
}

export default function (pi: ExtensionAPI): void {
	const client = new ExaClient();
	const outputs = new OutputStore();

	pi.registerTool<typeof SearchParameters, ExaDetails>({
		name: "web_search",
		label: "Exa Web Search",
		description: "Search the web with Exa MCP web_search_exa for current information and source URLs. Output is bounded to 50 KiB / 2000 lines; if truncated, the full result is saved to a temporary file.",
		promptSnippet: "Search the web for current information with Exa.",
		parameters: SearchParameters,
		async execute(_id, params, signal) {
			const query = params.query.trim();
			if (!query) throw new Error("query must not be blank.");
			const text = await client.callTool("web_search_exa", {
				query,
				...(params.numResults === undefined ? {} : { numResults: params.numResults }),
			}, signal);
			const output = await outputs.bound(text, "search", signal);
			return {
				content: [{ type: "text" as const, text: output.text }],
				details: { remoteTool: "web_search_exa", truncated: output.truncated, fullOutputPath: output.fullOutputPath },
			};
		},
	});

	pi.registerTool<typeof FetchParameters, ExaDetails>({
		name: "web_fetch",
		label: "Exa Web Fetch",
		description: "Fetch clean page content from known HTTP(S) URLs with Exa MCP web_fetch_exa. Output is bounded to 50 KiB / 2000 lines; if truncated, the full result is saved to a temporary file.",
		promptSnippet: "Read web pages from URLs with Exa.",
		parameters: FetchParameters,
		async execute(_id, params, signal) {
			const urls = httpUrls(params.urls);
			const text = await client.callTool("web_fetch_exa", {
				urls,
				...(params.maxCharacters === undefined ? {} : { maxCharacters: params.maxCharacters }),
			}, signal);
			const output = await outputs.bound(text, "fetch", signal);
			return {
				content: [{ type: "text" as const, text: output.text }],
				details: { remoteTool: "web_fetch_exa", truncated: output.truncated, fullOutputPath: output.fullOutputPath },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled([client.close(), outputs.cleanup()]);
	});
}
