import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DeepWikiClient, type DeepWikiRemoteTool } from "./src/client.ts";
import { type BoundedOutput, DeepWikiOutputStore } from "./src/output.ts";

const MAX_REPOSITORIES = 10;
const OUTPUT_LIMIT = `${formatSize(DEFAULT_MAX_BYTES)} / ${DEFAULT_MAX_LINES} 行`;

const RepositoryName = Type.String({
	minLength: 3,
	description: "公共 GitHub 仓库，格式为 owner/repo，例如 facebook/react。",
});

const SingleRepositoryParameters = Type.Object({
	repoName: RepositoryName,
}, { additionalProperties: false });

const AskQuestionParameters = Type.Object({
	repoName: Type.Optional(Type.String({
		minLength: 3,
		description: "单个公共 GitHub 仓库（owner/repo）；与 repoNames 二选一。",
	})),
	repoNames: Type.Optional(Type.Array(RepositoryName, {
		minItems: 1,
		maxItems: MAX_REPOSITORIES,
		description: `要联合提问的公共 GitHub 仓库列表，最多 ${MAX_REPOSITORIES} 个；与 repoName 二选一。`,
	})),
	question: Type.String({ minLength: 1, description: "要基于仓库代码与 DeepWiki 文档回答的问题。" }),
}, { additionalProperties: false });

interface DeepWikiDetails {
	remoteTool: DeepWikiRemoteTool;
	repositories: string[];
	elapsedMs: number;
	truncated: boolean;
	outputBytes: number;
	outputLines: number;
	totalBytes: number;
	totalLines: number;
	fullOutputPath?: string;
}

function normalizeRepository(value: string, label = "repoName"): string {
	const normalized = value.trim().replace(/\.git$/u, "");
	if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized)) {
		throw new Error(`${label} 必须是 owner/repo 格式，收到 ${JSON.stringify(value)}。`);
	}
	return normalized;
}

function askRepositories(params: { repoName?: string; repoNames?: string[] }): { wireValue: string | string[]; repositories: string[] } {
	if (params.repoName !== undefined && params.repoNames !== undefined) {
		throw new Error("repoName 与 repoNames 互斥，请只提供其中一个。");
	}
	if (params.repoName !== undefined) {
		const repository = normalizeRepository(params.repoName);
		return { wireValue: repository, repositories: [repository] };
	}
	if (!params.repoNames?.length) throw new Error("必须提供 repoName 或非空 repoNames。");
	const repositories = [...new Set(params.repoNames.map((repository, index) =>
		normalizeRepository(repository, `repoNames[${index + 1}]`),
	))];
	if (repositories.length > MAX_REPOSITORIES) {
		throw new Error(`repoNames 去重后最多 ${MAX_REPOSITORIES} 个仓库，收到 ${repositories.length} 个。`);
	}
	return { wireValue: repositories, repositories };
}

function details(tool: DeepWikiRemoteTool, repositories: string[], elapsedMs: number, output: BoundedOutput): DeepWikiDetails {
	return {
		remoteTool: tool,
		repositories,
		elapsedMs,
		truncated: output.truncated,
		outputBytes: output.outputBytes,
		outputLines: output.outputLines,
		totalBytes: output.totalBytes,
		totalLines: output.totalLines,
		fullOutputPath: output.fullOutputPath,
	};
}

export default function (pi: ExtensionAPI): void {
	const client = new DeepWikiClient();
	const outputs = new DeepWikiOutputStore();

	async function execute(
		tool: DeepWikiRemoteTool,
		args: Record<string, unknown>,
		repositories: string[],
		fileHint: string,
		signal?: AbortSignal,
	) {
		const startedAt = Date.now();
		const remoteText = await client.callTool(tool, args, signal);
		const output = await outputs.bound(remoteText, fileHint, signal);
		return {
			content: [{ type: "text" as const, text: output.text }],
			details: details(tool, repositories, Date.now() - startedAt, output),
		};
	}

	pi.registerTool<typeof SingleRepositoryParameters, DeepWikiDetails>({
		name: "deepwiki_read_wiki_structure",
		label: "DeepWiki Structure",
		promptSnippet: "列出公共 GitHub 仓库的 DeepWiki 文档目录",
		description: `调用官方 DeepWiki MCP 的 read_wiki_structure，列出公共 GitHub 仓库的文档主题与层级。输出最多 ${OUTPUT_LIMIT}，超限时完整内容保存到临时 Markdown 文件。`,
		parameters: SingleRepositoryParameters,
		async execute(_toolCallId, params, signal) {
			const repository = normalizeRepository(params.repoName);
			return execute("read_wiki_structure", { repoName: repository }, [repository], `${repository}-structure`, signal);
		},
	});

	pi.registerTool<typeof SingleRepositoryParameters, DeepWikiDetails>({
		name: "deepwiki_read_wiki_contents",
		label: "DeepWiki Contents",
		promptSnippet: "读取公共 GitHub 仓库的完整 DeepWiki 文档",
		description: `调用官方 DeepWiki MCP 的 read_wiki_contents，读取公共 GitHub 仓库的完整生成文档。内容可能很大；若只需回答具体问题，优先使用 deepwiki_ask_question。输出最多 ${OUTPUT_LIMIT}，超限时完整内容保存到临时 Markdown 文件。`,
		parameters: SingleRepositoryParameters,
		async execute(_toolCallId, params, signal) {
			const repository = normalizeRepository(params.repoName);
			return execute("read_wiki_contents", { repoName: repository }, [repository], `${repository}-contents`, signal);
		},
	});

	pi.registerTool<typeof AskQuestionParameters, DeepWikiDetails>({
		name: "deepwiki_ask_question",
		label: "DeepWiki Ask",
		promptSnippet: "基于一个或多个公共 GitHub 仓库向 DeepWiki 提问",
		description: `调用官方 DeepWiki MCP 的 ask_question，基于公共 GitHub 仓库生成有代码上下文的回答。用 repoName 指定单仓库，或用 repoNames 指定最多 ${MAX_REPOSITORIES} 个仓库，两者互斥。输出最多 ${OUTPUT_LIMIT}，超限时完整内容保存到临时 Markdown 文件。`,
		parameters: AskQuestionParameters,
		async execute(_toolCallId, params, signal) {
			const target = askRepositories(params);
			const question = params.question.trim();
			if (!question) throw new Error("question 必须是非空字符串。");
			return execute(
				"ask_question",
				{ repoName: target.wireValue, question },
				target.repositories,
				`${target.repositories.join("-")}-answer`,
				signal,
			);
		},
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled([client.close(), outputs.cleanup()]);
	});
}
