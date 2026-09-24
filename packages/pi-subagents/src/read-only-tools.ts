/**
 * 只读工具清单：并发判定的唯一来源，决定子 Agent 能否共享并发槽。
 *
 * 判定只比较工具名字符串，不校验工具的实际能力：同名工具被其他扩展注册为该名字时会被一并放行，
 * 因此新增条目必须确认该工具只读取、不写文件，也不改变外部状态。
 *
 * 两份清单用途不同，不要合并：
 * - BUILTIN_READ_ONLY_TOOLS 是 pi 内置工具，同时作为 Agent 省略 tools 时的默认白名单；
 * - EXTENSION_READ_ONLY_TOOLS 是第三方扩展注册的工具，只在 Agent 显式写出工具名时才生效。
 * “是否内置工具”的判断不使用本文件（见 agents.ts 的 isBuiltinToolName），它决定是否从父会话推导扩展来源。
 */

/** pi 内置只读工具：同时是 Agent 省略 tools 时的默认白名单。 */
export const BUILTIN_READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/** 已确认只读的扩展工具，按来源扩展分组。 */
export const EXTENSION_READ_ONLY_TOOLS: readonly string[] = [
	// npm:@ff-labs/pi-fff；override 模式下同族工具注册为 grep / find / multi_grep
	"ffgrep",
	"fffind",
	"fff-multi-grep",
	"multi_grep",
	// npm:@upstash/context7-pi
	"resolve-library-id",
	"query-docs",
	// packages/pi-deepwiki
	"deepwiki_read_wiki_structure",
	"deepwiki_read_wiki_contents",
	"deepwiki_ask_question",
	// packages/pi-exa
	"web_search",
	"web_fetch",
];

/** 全部可共享并发槽的只读工具。 */
export const READ_ONLY_TOOLS: readonly string[] = [...BUILTIN_READ_ONLY_TOOLS, ...EXTENSION_READ_ONLY_TOOLS];

const READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);

/** 工具名是否命中只读清单。 */
export function isReadOnlyTool(name: string): boolean {
	return READ_ONLY_TOOL_SET.has(name);
}
