import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionContext,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set([...READ_ONLY_TOOLS, "edit", "write", "powershell", "bash"]);

/**
 * 已知只读的扩展工具：只读的含义是不改动工作目录。
 *
 * - pi-fff（`@ff-labs/pi-fff`）：`ffgrep`/`fffind`/`fff-multi-grep`；`override` 模式下第三个工具叫
 *   `multi_grep`（`grep`/`find` 已被内置只读名单覆盖）。
 * - pi-web-access：`web_search`/`source_check`/`fetch_content`/`get_search_content`（默认工具名）。
 * - context7（`@upstash/context7-pi`）：`resolve-library-id`/`query-docs`（默认工具名，只查询远端文档）。
 *
 * pi-fff 与 pi-web-access 的写入都在扩展自己的状态目录与临时目录（pi-fff 的索引与 frecency/history 库，
 * pi-web-access 的 web-search-cache、GitHub 克隆、PDF 产物），不在工作目录里，父会话用同一批工具时也在写；
 * context7 只发远端查询，扩展内没有落盘代码。
 * 这里只按工具名判定，不检查扩展实现；这些扩展都允许在配置里改工具名，改过名的工具不在名单里。
 */
const READ_ONLY_EXTENSION_TOOLS = [
	// pi-fff
	"ffgrep", "fffind", "fff-multi-grep", "multi_grep",
	// pi-web-access（默认工具名）：网络搜索与抓取，不落盘到工作目录
	"web_search", "source_check", "fetch_content", "get_search_content",
	// context7（默认工具名）：远端文档查询，无本地写入
	"resolve-library-id", "query-docs",
];
const READ_ONLY_TOOL_SET = new Set([...READ_ONLY_TOOLS, ...READ_ONLY_EXTENSION_TOOLS]);
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FIELDS = new Set(["name", "description", "tools", "extensions", "model", "thinking"]);

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	/** 只在本 Agent 子会话中显式加载的扩展来源：本地路径或已安装的 npm/git 来源。 */
	extensions: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export function isBuiltinToolName(name: string): boolean {
	return BUILTIN_TOOLS.has(name);
}

/**
 * 只读 Agent：工具白名单全部命中内置只读工具，或命中已知只读的扩展工具
 * （pi-fff 搜索工具、pi-web-access 搜索/抓取工具）。
 *
 * 其余含 edit、write、powershell、bash 或名单外扩展工具名时无法静态判断是否写盘，一律视为未验证，
 * 由调度器按独占处理。判定只影响调度，不拒绝调用，因此现有 Agent 定义无需修改。
 */
export function isReadOnlyAgent(agent: AgentConfig): boolean {
	return agent.tools.every((tool) => READ_ONLY_TOOL_SET.has(tool));
}

export interface AgentDiscovery {
	agents: AgentConfig[];
	userDir: string;
	projectDir: string;
	projectTrusted: boolean;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} 必须是非空字符串。`);
	}
	return value.trim();
}

function parseTools(value: unknown): string[] {
	if (value === undefined) return [...READ_ONLY_TOOLS];
	const items: unknown[] = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	if (typeof value !== "string" && !Array.isArray(value)) {
		throw new Error("tools 必须是逗号分隔的字符串或 YAML 列表；禁用全部工具请使用 tools: []。");
	}
	const tools = items.map((item) => requiredString(item, "tools 中的工具名称"));
	for (const tool of tools) {
		if (/[\s\u0000-\u001f\u007f]/u.test(tool)) {
			throw new Error(`工具名称 ${JSON.stringify(tool)} 不能包含空白或控制字符。`);
		}
		if (tool === "powershell" && process.platform !== "win32") {
			throw new Error("Pi 0.85.1 的 powershell 工具仅支持 Windows。");
		}
	}
	if (new Set(tools).size !== tools.length) throw new Error("tools 中存在重复名称。");
	// 非内置名称视为扩展/自定义工具：名字只做白名单，不加载注册它的扩展。
	// 实际是否存在由子会话启动前对照其工具注册表校验，缺一个就拒绝启动。
	return tools;
}

function parseExtensions(value: unknown): string[] {
	if (value === undefined) return [];
	const items: unknown[] = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	if (typeof value !== "string" && !Array.isArray(value)) {
		throw new Error("extensions 必须是逗号分隔的字符串或 YAML 列表。");
	}
	const sources = items.map((item) => requiredString(item, "extensions 中的扩展来源"));
	for (const source of sources) {
		if (/[\u0000-\u001f\u007f]/u.test(source)) {
			throw new Error(`扩展来源 ${JSON.stringify(source)} 不能包含控制字符。`);
		}
	}
	if (new Set(sources).size !== sources.length) throw new Error("extensions 中存在重复来源。");
	return sources;
}

function loadDirectory(dir: string, source: AgentConfig["source"]): Map<string, AgentConfig> {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw new Error(`无法读取 Agent 目录 ${dir}: ${String(error)}`);
	}

	const agents = new Map<string, AgentConfig>();
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = join(dir, entry.name);
		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(filePath, "utf8"));
			if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
				throw new Error("frontmatter 必须是 YAML 对象。");
			}
			for (const field of Object.keys(frontmatter)) {
				if (!FIELDS.has(field)) throw new Error(`不支持的 frontmatter 字段：${field}。`);
			}
			const name = requiredString(frontmatter.name, "name");
			if (/[\u0000-\u001f\u007f]/u.test(name)) throw new Error("name 不能包含控制字符或换行。");
			const description = requiredString(frontmatter.description, "description");
			const tools = parseTools(frontmatter.tools);
			const extensions = parseExtensions(frontmatter.extensions);
			const model = frontmatter.model === undefined ? undefined : requiredString(frontmatter.model, "model");
			if (model !== undefined && !/^[^/\s]+\/[^\s]+$/u.test(model)) {
				throw new Error("model 必须使用完整 provider/model 标识；thinking 请单独配置。");
			}
			const thinking = frontmatter.thinking === undefined
				? undefined
				: requiredString(frontmatter.thinking, "thinking");
			if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
				throw new Error(`thinking 必须是 ${THINKING_LEVELS.join(", ")} 之一。`);
			}
			const duplicate = agents.get(name);
			if (duplicate) throw new Error(`同一目录内 Agent ${JSON.stringify(name)} 重名，另一文件：${duplicate.filePath}。`);
			agents.set(name, {
				name, description, tools, extensions, model, thinking: thinking as ThinkingLevel | undefined,
				systemPrompt: body, source, filePath,
			});
		} catch (error) {
			throw new Error(`Agent 配置错误 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return agents;
}

export function discoverAgents(cwd: string, projectTrusted: boolean): AgentDiscovery {
	const userDir = join(getAgentDir(), "agents");
	const projectDir = join(cwd, CONFIG_DIR_NAME, "agents");
	// 覆盖顺序为用户级 → 受信任的项目级；同名定义整体替换，不做字段合并。
	const agents = loadDirectory(userDir, "user");
	// 未受信任的项目目录连配置都不读取；无效项目覆盖也不能回退到用户定义。
	if (projectTrusted) {
		for (const [name, agent] of loadDirectory(projectDir, "project")) agents.set(name, agent);
	}
	return { agents: [...agents.values()], userDir, projectDir, projectTrusted };
}

export function configurationHint(cwd: string): string {
	return [
		`请在 ${join(getAgentDir(), "agents")} 或受信任项目的 ${join(cwd, CONFIG_DIR_NAME, "agents")} 中创建 Agent Markdown 文件，然后 /reload。`,
		"必填 frontmatter 为 name、description；省略 tools 时仅启用 read, grep, find, ls。扩展不会自动创建配置。",
		"扩展工具需要在 tools 中列出名字，并在 extensions 中声明已安装的扩展来源；不会自动安装缺失的扩展。",
	].join("");
}
