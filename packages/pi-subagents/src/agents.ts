import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionContext,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { normalizeSource } from "./extensions.ts";

export type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set([...READ_ONLY_TOOLS, "edit", "write", "powershell", "bash"]);

/**
 * 已知只读的扩展来源：来源 → 省略 `tools` 时自动启用的只读工具。
 * 只读的含义是不改动工作目录。
 *
 * - git:github.com/x1any/pi-extensions：pi-exa 的 `web_search`/`web_fetch`，以及
 *   pi-deepwiki 的 `deepwiki_read_wiki_structure`/`deepwiki_read_wiki_contents`/`deepwiki_ask_question`。
 * - context7（`@upstash/context7-pi`）：`resolve-library-id`/`query-docs`（默认工具名，只查询远端文档）。
 *
 * pi-fff 不登记在这里：它按全局 `pi-fff.json` 的 `override` 模式运行，检索工具名就是内置只读名
 * `grep`/`find`（同名覆盖内置实现）；只有 `PI_FFF_MULTIGREP=1` 时多出一个 `multi_grep`，需要时在
 * tools 里显式列出。
 *
 * pi-exa 和 pi-deepwiki 只在输出截断时写系统临时目录，不改工作目录；context7 只发远端查询。
 * 这里只按工具名判定，不检查扩展实现；自动启用仅适用于下列默认来源名，
 * 本地路径等其他来源需要在 Agent 的 tools 中显式列出工具名。
 * 来源未加载或没有注册同名工具时，自动启用的名字由子会话忽略。
 * 名单外的扩展工具无法静态判断是否写盘：既不会自动启用，也按未验证处理（独占调度）。
 */
const TRUSTED_READ_ONLY_SOURCES: Record<string, string[]> = {
	"git:github.com/x1any/pi-extensions": [
		"web_search", "web_fetch",
		"deepwiki_read_wiki_structure", "deepwiki_read_wiki_contents", "deepwiki_ask_question",
	],
	"@upstash/context7-pi": ["resolve-library-id", "query-docs"],
};
const READ_ONLY_EXTENSION_TOOLS = [...new Set(Object.values(TRUSTED_READ_ONLY_SOURCES).flat())];
const READ_ONLY_TOOL_SET = new Set([...READ_ONLY_TOOLS, ...READ_ONLY_EXTENSION_TOOLS]);
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FIELDS = new Set(["name", "description", "tools", "extensions", "model", "thinking"]);

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	/**
	 * 必须在子会话工具注册表中存在的名字：frontmatter 显式写出的工具，或是省略 tools 时的内置只读工具。
	 * 省略 tools 时自动展开的扩展工具不在此列：来源没注册同名工具时只是不启用该名字，不拒绝启动。
	 */
	requiredTools: string[];
	/** 只在本 Agent 子会话中显式加载的扩展来源：本地路径或已安装的 npm/git 来源；来源随包提供的 skills 一并加载。 */
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
 * （pi-exa 搜索/抓取、pi-deepwiki 仓库文档、context7 文档查询）。
 *
 * 其余含 edit、write、powershell、bash 或名单外扩展工具名时无法静态判断是否写盘，一律视为未验证，
 * 由调度器按独占处理。判定只影响调度，不拒绝调用，因此现有 Agent 定义无需修改。
 * 省略 tools 时自动包含可信来源的只读工具，展开结果全在只读集合内，这类 Agent 仍然是只读 Agent。
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

/**
 * 省略 tools 时的默认白名单：内置只读工具 + 已声明可信来源的只读工具。
 * 只读判定发生在建子会话之前（取并发槽时），所以这里只认静态来源表，不查扩展注册表。
 * 展开出的扩展工具只作可选启用：来源没注册同名工具时由子会话静默忽略，也不参与启动校验。
 */
function defaultTools(extensions: string[]): string[] {
	const tools = new Set(READ_ONLY_TOOLS);
	for (const source of extensions) {
		for (const tool of TRUSTED_READ_ONLY_SOURCES[normalizeSource(source)] ?? []) tools.add(tool);
	}
	return [...tools];
}

function parseTools(value: unknown, extensions: string[]): Pick<AgentConfig, "tools" | "requiredTools"> {
	// 省略 tools：内置只读工具必然注册，仍按硬要求校验；扩展工具按来源实际注册情况生效。
	if (value === undefined) return { tools: defaultTools(extensions), requiredTools: [...READ_ONLY_TOOLS] };
	const items: unknown[] = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	if (typeof value !== "string" && !Array.isArray(value)) {
		throw new Error("tools 必须是逗号分隔的字符串或 YAML 列表；禁用全部工具请使用 tools: []。");
	}
	const tools = items.map((item) => requiredString(item, "tools 中的工具名称"));
	for (const tool of tools) {
		if (tool.toLowerCase() === "auto") {
			throw new Error("tools 不需要写 auto：省略 tools 时会自动包含已声明可信来源的只读工具；要精确控制就逐名列出。");
		}
		if (/[\s\u0000-\u001f\u007f]/u.test(tool)) {
			throw new Error(`工具名称 ${JSON.stringify(tool)} 不能包含空白或控制字符。`);
		}
		if (tool === "powershell" && process.platform !== "win32") {
			throw new Error("Pi 0.85.1 的 powershell 工具仅支持 Windows。");
		}
	}
	if (new Set(tools).size !== tools.length) throw new Error("tools 中存在重复名称。");
	// 非内置名称视为扩展/自定义工具：名字只做白名单，不加载注册它的扩展。
	// 显式写出的名字由子会话启动前对照其工具注册表校验，缺一个就拒绝启动。
	return { tools, requiredTools: [...tools] };
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
			const extensions = parseExtensions(frontmatter.extensions);
			// 默认工具名单依赖声明的来源，所以 extensions 先解析。
			const { tools, requiredTools } = parseTools(frontmatter.tools, extensions);
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
				name, description, tools, requiredTools, extensions, model, thinking: thinking as ThinkingLevel | undefined,
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
		"必填 frontmatter 为 name、description；省略 tools 时启用 read, grep, find, ls，若声明了可信只读来源还包含该来源的只读工具。扩展不会自动创建配置。",
		"子会话默认加载 pi-fff（缺失时跳过并回退内置 grep/find）；其他扩展工具需要在 extensions 中声明已安装的来源；省略 tools 时会自动包含该来源的只读工具（按来源实际注册情况生效），其余扩展工具需逐名列出。不会自动安装或下载缺失的扩展，来源不可用时跳过该来源继续。",
	].join("");
}
