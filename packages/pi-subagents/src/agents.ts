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
const READ_ONLY_TOOL_SET = new Set(READ_ONLY_TOOLS);
const BUILTIN_TOOLS = new Set([...READ_ONLY_TOOLS, "edit", "write", "powershell", "bash"]);
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FIELDS = new Set(["name", "description", "tools", "extensions", "model", "thinking"]);

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	/** frontmatter 显式列出的工具，或省略 tools 时的内置只读工具；启动前必须存在。 */
	requiredTools: string[];
	/** 子会话额外加载的来源：显式声明，或从父会话已加载的工具推导。 */
	extensions: string[];
	/** 仅省略 extensions 时推导；显式 [] 表示只加载默认来源。 */
	inferExtensions: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export function isBuiltinToolName(name: string): boolean {
	return BUILTIN_TOOLS.has(name);
}

/** 扩展工具没有可靠的只读元数据；只让纯内置只读工具的 Agent 共享并发槽。 */
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

function parseTools(value: unknown): Pick<AgentConfig, "tools" | "requiredTools"> {
	// 不自动开放扩展工具；省略 tools 时只启用内置只读工具。
	if (value === undefined) return { tools: [...READ_ONLY_TOOLS], requiredTools: [...READ_ONLY_TOOLS] };
	const items: unknown[] = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	if (typeof value !== "string" && !Array.isArray(value)) {
		throw new Error("tools 必须是逗号分隔的字符串或 YAML 列表；禁用全部工具请使用 tools: []。");
	}
	const tools = items.map((item) => requiredString(item, "tools 中的工具名称"));
	for (const tool of tools) {
		if (tool.toLowerCase() === "auto") {
			throw new Error("tools 不需要写 auto：省略 tools 时只启用内置只读工具；扩展工具请逐名列出。");
		}
		if (/[\s\u0000-\u001f\u007f]/u.test(tool)) {
			throw new Error(`工具名称 ${JSON.stringify(tool)} 不能包含空白或控制字符。`);
		}
		if (tool === "powershell" && process.platform !== "win32") {
			throw new Error("Pi 0.85.1 的 powershell 工具仅支持 Windows。");
		}
	}
	if (new Set(tools).size !== tools.length) throw new Error("tools 中存在重复名称。");
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
			const { tools, requiredTools } = parseTools(frontmatter.tools);
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
				name, description, tools, requiredTools, extensions,
				inferExtensions: frontmatter.extensions === undefined, model, thinking: thinking as ThinkingLevel | undefined,
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
		"必填 frontmatter 为 name、description；省略 tools 时只启用 read, grep, find, ls，扩展工具须逐名列出。扩展不会自动创建配置。",
		"子会话默认加载 pi-fff（缺失时回退内置 grep/find）；省略 extensions 时可从父会话已加载工具推导来源，无法推导的来源须显式声明。不会自动安装或下载缺失的扩展。",
	].join("");
}
