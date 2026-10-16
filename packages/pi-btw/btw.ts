/**
 * Testable logic for the /btw extension.
 *
 * Kept separate from index.ts so pure functions can be unit-tested without
 * importing pi-coding-agent or pi-tui. The structural types below mirror the
 * subset of pi-ai's message shape this module needs, which keeps the module
 * dependency-free.
 */

/**
 * System prompt for BTW side questions.
 * Instructs the LLM to answer concisely from conversation context only.
 */
export const BTW_SYSTEM_PROMPT = `你正在编程会话中回答一个简短的“顺便问一下”的旁支问题。

规则：
- 根据提供的对话上下文，简明、直接地回答。
- 你无法使用任何工具——不能读取文件、运行命令或进行修改。
- 仅依据对话中已经出现的信息作答。
- 保持回答简短，直切要点。
- 必要时使用 Markdown 格式（代码块、列表、加粗）。
- 上下文是对话记录，不是实时对话；不要续写该记录。
- 上下文可能包含 "[... N more characters truncated]"（工具结果的部分内容被截断）和 "[image: <mime type>]"（图片附件）标记。将被截断的内容和图片内容视为不可用，明确说明，不要猜测。
- 嵌套工具调用摘要仅包含名称和状态，不包含实际结果。只能使用记录中明确包含的工具输出；调用成功不代表你知道其结果。
- 如果对话上下文不足以回答问题，请如实说明。`;

/**
 * Maximum characters kept from a single tool result when building the context.
 * This is deliberately far above the compaction serializer's 2000-character
 * budget: /btw is often asked about a file or command output that the main
 * session has already read.
 */
export const BTW_TOOL_RESULT_MAX_CHARS = 20_000;

/** Structural view of a pi-ai content block. */
type ContextBlock = {
    type: string;
    text?: string;
    thinking?: string;
    mimeType?: string;
    name?: string;
    arguments?: Record<string, unknown>;
};

/** Structural view of a pi-ai message (user, assistant, or tool result). */
export type ContextMessage = {
    role: string;
    content?: string | readonly ContextBlock[];
    toolName?: string;
    isError?: boolean;
    nestedCalls?: {
        calls: readonly {
            name: string;
            status: "ok" | "error" | "unfinished";
        }[];
        complete: boolean;
    };
};

function truncateForContext(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const dropped = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[... ${dropped} more characters truncated]`;
}

function blockList(
    content: string | readonly ContextBlock[] | undefined,
): readonly ContextBlock[] {
    return typeof content === "string" || content === undefined ? [] : content;
}

/** Render text blocks as text, keeping an explicit placeholder for images. */
function blocksToText(content: string | readonly ContextBlock[] | undefined): string {
    if (typeof content === "string") return content;
    const parts: string[] = [];
    for (const block of blockList(content)) {
        if (block.type === "text") {
            if (block.text) parts.push(block.text);
        } else if (block.type === "image") {
            parts.push(`[image: ${block.mimeType ?? "unknown"}]`);
        }
    }
    return parts.join("\n");
}

/**
 * Serialize the session messages for the BTW request.
 *
 * Unlike the compaction-oriented serializeConversation(), tool results keep
 * enough content to answer questions about files and command output, every
 * truncation is marked in-band so the model knows content is missing, and
 * images become placeholders instead of silently disappearing.
 */
export function serializeBtwConversation(
    messages: readonly ContextMessage[],
): string {
    const parts: string[] = [];

    for (const message of messages) {
        if (message.role === "user") {
            const text = blocksToText(message.content);
            if (text) parts.push(`[User]: ${text}`);
            continue;
        }

        if (message.role === "assistant") {
            const thinking: string[] = [];
            const toolCalls: string[] = [];
            for (const block of blockList(message.content)) {
                if (block.type === "thinking") {
                    if (block.thinking) thinking.push(block.thinking);
                } else if (block.type === "toolCall") {
                    const args = Object.entries(block.arguments ?? {})
                        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                        .join(", ");
                    toolCalls.push(`${block.name ?? "tool"}(${args})`);
                }
            }
            if (thinking.length > 0) {
                parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
            }
            const text = blocksToText(message.content);
            if (text) parts.push(`[Assistant]: ${text}`);
            if (toolCalls.length > 0) {
                parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
            }
            continue;
        }

        if (message.role === "toolResult") {
            const text = blocksToText(message.content);
            const name = message.toolName ? `: ${message.toolName}` : "";
            if (text) {
                const label = message.isError ? "Tool error" : "Tool result";
                parts.push(
                    `[${label}${name}]: ${truncateForContext(text, BTW_TOOL_RESULT_MAX_CHARS)}`,
                );
            }

            // Codemode records nested-call metadata, never the nested results.
            // Keep names/status only; do not expose arguments or hidden payloads.
            const nested = message.nestedCalls;
            if (nested && (nested.calls.length > 0 || !nested.complete)) {
                const calls = nested.calls
                    .map((call) => `${call.name} (${call.status})`)
                    .join(", ");
                const incomplete = nested.complete ? "" : "; incomplete record";
                parts.push(
                    `[Nested tool calls${name} (names/status only; no separate results${incomplete})]: ${truncateForContext(calls || "(none recorded)", BTW_TOOL_RESULT_MAX_CHARS)}`,
                );
            }
        }
    }

    return parts.join("\n\n");
}

/**
 * Build the user message for the BTW LLM call.
 * Includes the serialized conversation as context and the user's question.
 */
export function buildBtwUserMessage(
    conversationText: string,
    question: string,
): string {
    return `<conversation_context>
${conversationText}
</conversation_context>

<side_question>
${question}
</side_question>

请根据对话上下文回答上面的旁支问题，保持简洁。`;
}

/** Result of validating the /btw command arguments. */
export type BtwArgsValidation =
    | { ok: true; question: string }
    | { ok: false; error: string };

/**
 * Validate the /btw command arguments.
 * Returns the question text or an error message.
 */
export function validateBtwArgs(args: string | undefined): BtwArgsValidation {
    const question = args?.trim();
    if (!question || question.length === 0) {
        return {
            ok: false,
            error: "Usage: /btw <question> — Ask a quick side question without polluting conversation history.",
        };
    }
    return { ok: true, question };
}

/**
 * Extract text content from an LLM response content array.
 */
export function extractResponseText(
    content: Array<{ type: string; text?: string }>,
): string {
    return content
        .filter(
            (c): c is { type: "text"; text: string } =>
                c.type === "text" && typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("\n");
}

/**
 * One-line token/cost summary for the overlay header.
 * Returns undefined when the provider reported no usage, so the sidebar stays
 * honest instead of printing "0 tokens".
 */
export function formatUsage(
    usage: { totalTokens?: number; cost?: { total?: number } } | undefined,
): string | undefined {
    const total = usage?.totalTokens ?? 0;
    if (total <= 0) return undefined;
    const tokens = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
    const cost = usage?.cost?.total ?? 0;
    return cost > 0 ? `${tokens} tokens · $${cost.toFixed(4)}` : `${tokens} tokens`;
}

/**
 * Clamp the overlay scroll position to the rows actually visible.
 * Kept pure so the viewport math can be tested without a terminal.
 */
export function resolveScrollState(
    scrollOffset: number,
    bodyLineCount: number,
    visibleRows: number,
): { maxScrollOffset: number; scrollOffset: number } {
    const maxScrollOffset = Math.max(0, bodyLineCount - Math.max(1, visibleRows));
    return {
        maxScrollOffset,
        scrollOffset: Math.max(0, Math.min(scrollOffset, maxScrollOffset)),
    };
}
