import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	DefaultPackageManager,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * 只解析已经存在的东西：本地路径必须存在，包来源必须已安装并在配置中启用。
 * 解析过程不安装、不下载、不写入任何文件，也不改变用户配置。
 */
export interface ExtensionResolution {
	/** 交给子会话 additionalExtensionPaths 的路径：包来源是扩展入口文件，本地来源保持原样。 */
	paths: string[];
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

/** 比较声明的来源与配置里的来源：忽略 npm: 前缀和版本号，其余要求一致。 */
function normalizeSource(value: string): string {
	let text = value.trim();
	if (text.startsWith("npm:")) text = text.slice(4);
	const at = text.lastIndexOf("@");
	if (at > 0) text = text.slice(0, at);
	return text.toLowerCase();
}

function sameSource(declared: string, configured: string): boolean {
	return declared.trim() === configured.trim() || normalizeSource(declared) === normalizeSource(configured);
}

export async function resolveAgentExtensions(
	sources: string[],
	options: { cwd: string; agentDir: string; settingsManager: SettingsManager },
): Promise<ExtensionResolution> {
	if (sources.length === 0) return { paths: [], missing: [] };
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
	const paths: string[] = [];
	const missing: string[] = [];
	for (const source of sources) {
		if (isLocalSource(source)) {
			const path = localSourcePath(source, options.cwd);
			if (path && existsAsFileOrDirectory(path)) paths.push(path);
			else missing.push(source);
			continue;
		}
		const matches = installed.filter((entry) => entry.enabled && sameSource(source, entry.source));
		if (matches.length === 0) {
			missing.push(source);
			continue;
		}
		for (const match of matches) paths.push(match.path);
	}
	return { paths: [...new Set(paths)], missing };
}
