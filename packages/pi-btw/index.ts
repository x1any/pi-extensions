/**
 * BTW Extension
 *
 * Provides a `/btw` command for quick side questions that do not pollute the
 * conversation history. The answer appears in a temporary overlay and is fully
 * ephemeral — nothing is persisted to the session.
 *
 * Adapted from:
 * https://github.com/jayshah5696/pi-agent-extensions/tree/main/extensions/btw
 */

import type { Usage, UserMessage } from "@earendil-works/pi-ai/compat";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    Theme,
} from "@earendil-works/pi-coding-agent";
import {
    BorderedLoader,
    buildSessionContext,
    convertToLlm,
} from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Key,
    matchesKey,
    truncateToWidth,
    wrapTextWithAnsi,
    visibleWidth,
    type TUI,
} from "@earendil-works/pi-tui";

import {
    BTW_SYSTEM_PROMPT,
    buildBtwUserMessage,
    extractResponseText,
    formatUsage,
    resolveScrollState,
    serializeBtwConversation,
    validateBtwArgs,
} from "./btw.js";

type BtwQueryResult =
    | { status: "ok"; answer: string; usage?: Usage }
    | { status: "cancelled" }
    | { status: "error"; message: string };

/**
 * Upper bound for a single /btw request. Providers that support it abort the
 * underlying HTTP request; interactive cancel stays available regardless.
 */
const BTW_REQUEST_TIMEOUT_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "Unknown error";
}

async function queryBtwAnswer(
    ctx: ExtensionCommandContext,
    model: NonNullable<ExtensionCommandContext["model"]>,
    userMessage: UserMessage,
    signal?: AbortSignal,
): Promise<BtwQueryResult> {
    try {
        // Route through the registry so auth (apiKey/headers/baseUrl/env) and
        // provider request transforms match regular session calls, and auth
        // failures surface as errors instead of silently falling back.
        const response = await ctx.modelRegistry.complete(
            model,
            { systemPrompt: BTW_SYSTEM_PROMPT, messages: [userMessage] },
            { signal, timeoutMs: BTW_REQUEST_TIMEOUT_MS },
        );

        if (response.stopReason === "aborted") {
            return { status: "cancelled" };
        }

        if (response.stopReason === "error") {
            return {
                status: "error",
                message: response.errorMessage ?? "LLM error",
            };
        }

        return {
            status: "ok",
            answer: extractResponseText(response.content),
            usage: response.usage,
        };
    } catch (error) {
        if (signal?.aborted) return { status: "cancelled" };
        return { status: "error", message: errorMessage(error) };
    }
}

/**
 * Overlay height cap in percent of the terminal height. Must stay in sync with
 * the `maxHeight` passed to ctx.ui.custom below.
 */
const OVERLAY_MAX_HEIGHT_PERCENT = 92;
const OVERLAY_MAX_HEIGHT = `${OVERLAY_MAX_HEIGHT_PERCENT}%`;
/** Vertical overlay margin in rows, matched by the `margin` option below. */
const OVERLAY_MARGIN_ROWS = 1;
/**
 * Rows the overlay spends on borders and headers/footer: top border, title,
 * subtitle, separator, separator, footer, bottom border.
 */
const OVERLAY_CHROME_ROWS = 7;

/**
 * Rows the overlay may occupy, mirroring pi-tui's overlay layout: the percentage
 * maxHeight clamped to the terminal height minus the vertical margins. pi-tui
 * trims overlays from the bottom, so budgeting more rows than this would hide
 * the footer and the tail of the answer.
 */
function overlayRowBudget(termRows: number): number {
    const capped = Math.floor((termRows * OVERLAY_MAX_HEIGHT_PERCENT) / 100);
    const available = Math.max(1, termRows - OVERLAY_MARGIN_ROWS * 2);
    return Math.max(1, Math.min(capped, available));
}

/** Scrollable body rows the overlay can actually show. */
function overlayBodyRowBudget(termRows: number): number {
    return Math.max(1, overlayRowBudget(termRows) - OVERLAY_CHROME_ROWS);
}

/**
 * Overlay component that displays the BTW question and answer.
 * The full page scrolls together so large input and output remain usable.
 */
class BtwOverlay implements Component {
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly question: string;
    private readonly answer: string;
    private readonly meta: string;
    private readonly onDone: () => void;
    private scrollOffset = 0;
    private cachedWidth?: number;
    private cachedLines?: string[];
    private maxScrollOffset = 0;

    constructor(
        tui: TUI,
        theme: Theme,
        question: string,
        answer: string,
        meta: string,
        onDone: () => void,
    ) {
        this.tui = tui;
        this.theme = theme;
        this.question = question;
        this.answer = answer;
        this.meta = meta;
        this.onDone = onDone;
    }

    handleInput(data: string): void {
        if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.ctrl("c")) ||
            matchesKey(data, Key.space) ||
            data.toLowerCase() === "q"
        ) {
            this.onDone();
            return;
        }

        const pageStep = Math.max(1, overlayBodyRowBudget(this.tui.terminal.rows ?? 24) - 1);

        if (matchesKey(data, Key.up) || data === "k") {
            if (this.scrollOffset > 0) {
                this.scrollOffset--;
                this.invalidate();
                this.tui.requestRender();
            }
            return;
        }

        if (matchesKey(data, Key.down) || data === "j") {
            if (this.scrollOffset < this.maxScrollOffset) {
                this.scrollOffset++;
                this.invalidate();
                this.tui.requestRender();
            }
            return;
        }

        if (matchesKey(data, Key.pageUp)) {
            this.scrollOffset = Math.max(0, this.scrollOffset - pageStep);
            this.invalidate();
            this.tui.requestRender();
            return;
        }

        if (matchesKey(data, Key.pageDown)) {
            this.scrollOffset = Math.min(
                this.maxScrollOffset,
                this.scrollOffset + pageStep,
            );
            this.invalidate();
            this.tui.requestRender();
        }
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedWidth === width) {
            return this.cachedLines;
        }

        const theme = this.theme;
        const boxWidth = Math.max(4, Math.min(Math.max(4, width), 144));
        const contentWidth = Math.max(12, boxWidth - 8);

        const horizontalLine = (count: number) => "─".repeat(count);
        const meter = (value: number, total: number, size: number) => {
            if (total <= 0) return "░".repeat(size);
            const filled = Math.max(
                1,
                Math.min(size, Math.round((value / total) * size)),
            );
            return "█".repeat(filled) + "░".repeat(Math.max(0, size - filled));
        };

        const fitInline = (text: string, targetWidth: number): string => {
            if (targetWidth <= 0) return "";
            const wrapped = wrapTextWithAnsi(text, targetWidth);
            const firstLine = wrapped[0] ?? "";
            return truncateToWidth(firstLine, targetWidth);
        };

        const boxLine = (content: string, leftPad = 2): string => {
            const paddedContent =
                " ".repeat(leftPad) +
                fitInline(content, Math.max(0, boxWidth - leftPad - 3));
            const contentLen = visibleWidth(paddedContent);
            const rightPad = Math.max(0, boxWidth - contentLen - 2);
            return (
                theme.fg("border", "│") +
                paddedContent +
                " ".repeat(rightPad) +
                theme.fg("border", "│")
            );
        };

        const emptyBoxLine = (): string => {
            return (
                theme.fg("border", "│") +
                " ".repeat(boxWidth - 2) +
                theme.fg("border", "│")
            );
        };

        const padToWidth = (line: string): string => {
            const len = visibleWidth(line);
            return line + " ".repeat(Math.max(0, width - len));
        };

        const sectionTitle = (label: string, meta: string) => {
            const text = `${theme.fg("accent", theme.bold(label))}${theme.fg(
                "muted",
                ` · ${meta}`,
            )}`;
            return boxLine(text, 2);
        };

        const pushWrappedSection = (
            bodyLines: string[],
            label: string,
            meta: string,
            text: string,
            prefix: string,
        ) => {
            bodyLines.push(sectionTitle(label, meta));
            bodyLines.push(emptyBoxLine());
            for (const paragraph of text.split("\n")) {
                if (paragraph.trim() === "") {
                    bodyLines.push(boxLine("", 2));
                    continue;
                }
                const wrapped = wrapTextWithAnsi(
                    paragraph,
                    Math.max(12, contentWidth - visibleWidth(prefix)),
                );
                for (const line of wrapped) {
                    bodyLines.push(boxLine(`${prefix}${line}`, 2));
                }
            }
        };

        const questionWords = this.question.trim().split(/\s+/).filter(Boolean).length;
        const answerParagraphs = this.answer
            .split("\n")
            .filter((line) => line.trim() !== "").length;

        const bodyLines: string[] = [];
        pushWrappedSection(
            bodyLines,
            "Question",
            `${questionWords} words`,
            this.question,
            theme.fg("muted", "› "),
        );
        bodyLines.push(emptyBoxLine());
        bodyLines.push(
            boxLine(theme.fg("border", horizontalLine(Math.max(10, contentWidth - 6))), 3),
        );
        bodyLines.push(emptyBoxLine());
        pushWrappedSection(
            bodyLines,
            "Answer",
            `${answerParagraphs} paragraphs`,
            this.answer,
            "",
        );

        const visibleRows = overlayBodyRowBudget(this.tui.terminal.rows ?? 24);
        const scroll = resolveScrollState(
            this.scrollOffset,
            bodyLines.length,
            visibleRows,
        );
        this.maxScrollOffset = scroll.maxScrollOffset;
        this.scrollOffset = scroll.scrollOffset;

        const visibleBodyLines = bodyLines.slice(
            this.scrollOffset,
            this.scrollOffset + visibleRows,
        );

        const scrollCurrent = Math.min(
            bodyLines.length,
            this.scrollOffset + visibleRows,
        );
        const scrollInfo =
            this.maxScrollOffset > 0
                ? `${this.scrollOffset + 1}-${scrollCurrent}/${bodyLines.length}`
                : "full";
        const progress = meter(scrollCurrent, Math.max(bodyLines.length, 1), 10);

        const lines: string[] = [];
        lines.push(
            padToWidth(theme.fg("accent", "╭" + horizontalLine(boxWidth - 2) + "╮")),
        );
        lines.push(
            padToWidth(
                boxLine(
                    `${theme.fg("accent", theme.bold("BTW"))}${theme.fg(
                        "muted",
                        " · side question",
                    )}`,
                    2,
                ),
            ),
        );
        lines.push(
            padToWidth(boxLine(theme.fg("dim", this.meta), 2)),
        );
        lines.push(
            padToWidth(theme.fg("accent", "├" + horizontalLine(boxWidth - 2) + "┤")),
        );
        lines.push(...visibleBodyLines.map(padToWidth));
        lines.push(
            padToWidth(theme.fg("accent", "├" + horizontalLine(boxWidth - 2) + "┤")),
        );
        lines.push(
            padToWidth(
                boxLine(
                    `${theme.fg("accent", progress)} ${theme.fg(
                        "muted",
                        scrollInfo,
                    )}${theme.fg(
                        "dim",
                        "  ·  Esc dismiss  ·  ↑↓ / j k  ·  PgUp PgDn",
                    )}`,
                    2,
                ),
            ),
        );
        lines.push(
            padToWidth(theme.fg("accent", "╰" + horizontalLine(boxWidth - 2) + "╯")),
        );

        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }
}

function reportMessage(
    ctx: ExtensionCommandContext,
    message: string,
    level: "info" | "warning" | "error" = "info",
): void {
    if (ctx.hasUI) {
        ctx.ui.notify(message, level);
    } else if (level === "error" || ctx.mode === "json") {
        console.error(message);
    } else {
        console.log(message);
    }
}

async function runBtwCommand(
    args: string | undefined,
    ctx: ExtensionCommandContext,
): Promise<void> {
    const validation = validateBtwArgs(args);
    if (!validation.ok) {
        reportMessage(ctx, validation.error, "error");
        return;
    }
    const question = validation.question;

    if (!ctx.model) {
        reportMessage(ctx, "No model selected. Use /model to select a model first.", "error");
        return;
    }

    const sessionContext = buildSessionContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
    );
    const messages = sessionContext.messages;

    let conversationText = "";
    if (messages.length > 0) {
        const llmMessages = convertToLlm(messages);
        conversationText = serializeBtwConversation(llmMessages);
    }

    const btwModel = ctx.model;
    const userMessage: UserMessage = {
        role: "user",
        content: [{ type: "text", text: buildBtwUserMessage(conversationText, question) }],
        timestamp: Date.now(),
    };

    if (ctx.mode !== "tui") {
        const result = await queryBtwAnswer(ctx, btwModel, userMessage);
        if (result.status === "ok") {
            if (ctx.mode === "print") {
                console.log(`\n> btw: ${question}\n`);
                console.log(result.answer);
            } else {
                reportMessage(ctx, `btw: ${question}\n\n${result.answer}`, "info");
            }
            return;
        }
        reportMessage(
            ctx,
            result.status === "cancelled" ? "Cancelled" : result.message,
            result.status === "cancelled" ? "info" : "error",
        );
        return;
    }

    const answerResult = await ctx.ui.custom<BtwQueryResult>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, `Thinking (${btwModel.id})...`);
        loader.onAbort = () => done({ status: "cancelled" });

        queryBtwAnswer(ctx, btwModel, userMessage, loader.signal)
            .then(done)
            .catch((error) => {
                done({ status: "error", message: errorMessage(error) });
            });

        return loader;
    });

    if (!answerResult || answerResult.status === "cancelled") {
        ctx.ui.notify("Cancelled", "info");
        return;
    }

    if (answerResult.status === "error") {
        ctx.ui.notify(`BTW query failed: ${answerResult.message}`, "error");
        return;
    }

    if (answerResult.answer.trim() === "") {
        ctx.ui.notify("No answer received", "warning");
        return;
    }

    const usageText = formatUsage(answerResult.usage);
    const overlayMeta = usageText ? `${btwModel.id} · ${usageText}` : btwModel.id;

    await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
            return new BtwOverlay(
                tui,
                theme,
                question,
                answerResult.answer,
                overlayMeta,
                done,
            );
        },
        {
            overlay: true,
            overlayOptions: {
                anchor: "center",
                width: "92%",
                maxHeight: OVERLAY_MAX_HEIGHT,
                margin: {
                    top: OVERLAY_MARGIN_ROWS,
                    bottom: OVERLAY_MARGIN_ROWS,
                    left: 1,
                    right: 1,
                },
            },
        },
    );
}

export default function btwExtension(pi: ExtensionAPI) {
    pi.registerCommand("btw", {
        description: "Ask a quick side question without polluting conversation history",
        handler: async (args, ctx) => {
            await runBtwCommand(args, ctx);
        },
    });
}
