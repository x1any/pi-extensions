import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	DefaultPackageManager,
	type ExtensionAPI,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * 只解析已经存在的东西：本地路径必须存在，包来源必须已安装并在配置中启用。
 * 解析过程不安装、不下载、不写入任何文件，也不改变用户配置。
 */
export interface ExtensionResolution {
	/** 交给子会话 additionalExtensionPaths 的路径：包来源是扩展入口文件，本地来源保持原样。 */
	paths: string[];
	/** 声明来源随包提供的 skill 路径（已启用，遵守 settings 里的包过滤器），交给子会话 additionalSkillPaths。 */
	skillPaths: string[];
	/** 无法解析的来源（未安装、未启用、路径不存在），由调用方拒绝启动。 */
	missing: string[];
}

const NON_LOCAL_PREFIXES = ["npm:", "git:", "github:", "http:", "https:", "ssh:"];

function isLocalSource(source: string): boolean {
	const trimmed = source.trim();
	return !NON_LOCAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** 本地来源按父会话 cwd 解析；目录会被 Pi 当作包根读取 package.json 的 pi.extensions。 */
function localSourcePath(source: string, cwd: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return resolve(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function existsAsFileOrDirectory(path: string): boolean {
	try {
		const stats = statSync(path);
		return stats.isFile() || stats.isDirectory();
	} catch {
		return false;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** 比较本地路径：忽略斜杠方向、大小写与末尾分隔符的写法差异。 */
function sameLocalPath(a: string, b: string): boolean {
	const normalize = (value: string) => value.trim().replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
	return normalize(a) === normalize(b);
}

/**
 * 解析只在 frontmatter 里声明的本地目录扩展随包的 skills。
 * 目录不在 settings 里，没有需要遵守的包过滤器；传入的是本机绝对路径，parseSource 判为 local，
 * 不会安装或下载。Pi 在 `noSkills` 下仍会加载显式传入的 skill 路径。
 */
async function resolveLocalDirectorySkills(manager: DefaultPackageManager, root: string): Promise<string[]> {
	const resources = await manager.resolveExtensionSources([root], { temporary: true });
	return resources.skills.filter((skill) => skill.enabled).map((skill) => skill.path);
}

/** 比较声明的来源与配置里的来源：忽略 npm: 前缀和版本号，其余要求一致。 */
export function normalizeSource(value: string): string {
	let text = value.trim();
	if (text.startsWith("npm:")) {
		text = text.slice(4);
		// 只对 npm 来源剥版本号，否则 `ssh://git@host/repo` 会被截成 `ssh://git` 而误判同源。
		// 作用域包从作用域名之后找版本分隔符，即 `@scope/name@1.0.0`。
		const slash = text.indexOf("/");
		const at = text.indexOf("@", slash < 0 ? 0 : slash + 1);
		if (at > 0) text = text.slice(0, at);
	}
	return text.toLowerCase();
}

function sameSource(declared: string, configured: string): boolean {
	return declared.trim() === configured.trim() || normalizeSource(declared) === normalizeSource(configured);
}

/** 从父会话实际注册的工具入口反查启用的包来源；无法归属包的本地入口只加载该文件。 */
export async function inferLoadedToolSources(
	tools: ReturnType<ExtensionAPI["getAllTools"]>,
	options: { cwd: string; agentDir: string; settingsManager: SettingsManager },
): Promise<Map<string, string>> {
	// 只有扩展注册的工具指向磁盘上的入口文件：内置、SDK 和内联工具用 `<builtin:x>`、`<sdk:x>` 这类合成路径。
	// 包来源的工具入口同样在磁盘上，其 source 是包来源串（`git:`/`npm:`）而不是 `local`，不能按 source 过滤。
	const candidates = tools.filter((tool) => isAbsolute(tool.sourceInfo.path)
		&& existsAsFileOrDirectory(tool.sourceInfo.path));
	if (candidates.length === 0) return new Map();
	const manager = new DefaultPackageManager(options);
	const resolved = await manager.resolve(async () => "skip");
	const sources = new Map<string, string>();
	for (const tool of candidates) {
		const path = tool.sourceInfo.path;
		const matches = resolved.extensions.filter((entry) => sameLocalPath(entry.path, path));
		const enabled = matches.find((entry) => entry.enabled);
		// 包入口已被配置禁用时，不用本地文件路径绕过过滤器。
		if (matches.length > 0 && !enabled) continue;
		const source = enabled?.metadata.origin === "package" && !isLocalSource(enabled.metadata.source)
			? enabled.metadata.source
			: path;
		sources.set(tool.name, source);
	}
	return sources;
}

export async function resolveAgentExtensions(
	sources: string[],
	options: { cwd: string; agentDir: string; settingsManager: SettingsManager },
): Promise<ExtensionResolution> {
	if (sources.length === 0) return { paths: [], skillPaths: [], missing: [] };
	const manager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
	});
	// onMissing 返回 skip：缺失的包只记录，绝不安装。
	const resolved = await manager.resolve(async () => "skip");
	const installed = resolved.extensions.map((resource) => ({
		source: resource.metadata.source,
		path: resource.path,
		enabled: resource.enabled,
	}));
	// 随包 skills 只取主 resolve 的结果：只有它遵守 settings 里的对象式包过滤器（可单独关闭某个包的
	// skills、也能用 autoload 做增量），再按包根解析一次会把用户显式禁用的 skills 重新带进子会话。
	// origin 为 "package" 排除自动发现（source 为 "auto"）与 settings 顶层条目。
	const enabledSkills = resolved.skills.filter((skill) => skill.enabled && skill.metadata.origin === "package");
	const configuredSources = manager.listConfiguredPackages().map((entry) => entry.source);
	const isConfiguredSource = (source: string, localPath: string) => configuredSources.some((entry) =>
		sameSource(source, entry) || sameLocalPath(localPath, entry));
	const paths: string[] = [];
	const skillPaths = new Set<string>();
	const collectSkills = (source: string, localPath?: string) => {
		for (const skill of enabledSkills) {
			const from = skill.metadata.source;
			if (sameSource(source, from) || (localPath !== undefined && sameLocalPath(localPath, from))) {
				skillPaths.add(skill.path);
			}
		}
	};
	const missing: string[] = [];
	for (const source of sources) {
		if (isLocalSource(source)) {
			const path = localSourcePath(source, options.cwd);
			if (!path || !existsAsFileOrDirectory(path)) {
				missing.push(source);
				continue;
			}
			paths.push(path);
			collectSkills(source, path);
			// settings 里没有的本地目录，主 resolve 看不到它随包的 skills，单独按包根解析一次。
			// 声明路径与 settings 里的写法差到 sameLocalPath 也认不出时才会走到这里，此时等于不遵守该包的过滤器。
			if (isDirectory(path) && !isConfiguredSource(source, path)) {
				for (const skill of await resolveLocalDirectorySkills(manager, path)) skillPaths.add(skill);
			}
			continue;
		}
		const matches = installed.filter((entry) => entry.enabled && sameSource(source, entry.source));
		if (matches.length === 0) {
			missing.push(source);
			continue;
		}
		for (const match of matches) paths.push(match.path);
		collectSkills(source);
	}
	return { paths: [...new Set(paths)], skillPaths: [...skillPaths], missing };
}
