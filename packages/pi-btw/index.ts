/**
 * BTW Extension
 *
 * Provides a `/btw` command for quick side questions that do not pollute the
 * conversation history. The answer appears in a temporary bottom panel and is
 * fully ephemeral — nothing is persisted to the session.
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
    DynamicBorder,
} from "@earendil-works/pi-coding-agent";
import {
    type Component,
    Container,
    Key,
    matchesKey,
    Spacer,
    Text,
    truncateToWidth,
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

/** Height cap for the bottom panel, leaving room for Pi's surrounding UI. */
const PANEL_MAX_HEIGHT_PERCENT = 92;
/** Minimum rows reserved for surrounding UI, such as Pi's footer. */
const PANEL_RESERVED_ROWS = 2;
/** Rows always used by the panel: top rule, title, footer, bottom rule. */
const PANEL_CHROME_ROWS = 4;
/** Blank rows between panel sections when the terminal has room. */
const PANEL_MAX_SPACERS = 2;

/** Maximum panel rows within the terminal height minus the reserved rows. */
function panelRowBudget(termRows: number): number {
    const capped = Math.floor((termRows * PANEL_MAX_HEIGHT_PERCENT) / 100);
    const available = Math.max(1, termRows - PANEL_RESERVED_ROWS);
    return Math.max(1, Math.min(capped, available));
}

/** Body rows and spacer rows that fit inside the panel budget. */
function panelLayout(termRows: number): { bodyRows: number; spacers: number } {
    const budget = panelRowBudget(termRows);
    // Keep at least one body row, then compress blank separator rows before
    // the footer or the body content is hidden.
    const spacers = Math.max(
        0,
        Math.min(PANEL_MAX_SPACERS, budget - PANEL_CHROME_ROWS - 1),
    );
    return {
        bodyRows: Math.max(0, budget - PANEL_CHROME_ROWS - spacers),
        spacers,
    };
}

/** Scrollable body rows available in the bottom panel. */
function panelBodyRowBudget(termRows: number): number {
    return panelLayout(termRows).bodyRows;
}

/** Fixed lines produced by an already-laid-out viewport. */
class LinesComponent implements Component {
    private readonly lines: string[];

    constructor(lines: string[]) {
        this.lines = lines;
    }

    invalidate(): void {
        // No cached state; the owner rebuilds this component every render.
    }

    render(_width: number): string[] {
        return this.lines;
    }
}

/**
 * Bottom panel that displays the BTW question and answer.
 * The full page scrolls together so large input and output remain usable.
 */
class BtwPanel implements Component {
    private readonly tui: TUI;
    private readonly theme: Theme;
    private readonly question: string;
    private readonly answer: string;
    private readonly meta: string;
    private readonly onDone: () => void;
    private scrollOffset = 0;
    private cachedWidth?: number;
    private cachedRows?: number;
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

        const pageStep = Math.max(1, panelBodyRowBudget(this.tui.terminal.rows ?? 24) - 1);

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
        this.cachedRows = undefined;
        this.cachedLines = undefined;
    }

    /** Question and answer wrap together as one scrollable body. */
    private buildBodyLines(width: number, padding: number): string[] {
        const body = new Container();
        body.addChild(
            new Text(
                `${this.theme.fg("muted", "› ")}${this.question}`,
                padding,
                0,
            ),
        );
        body.addChild(new Spacer(1));
        body.addChild(new Text(this.answer, padding, 0));
        return body.render(width);
    }

    /** Key hints on the left, scroll position on the right. */
    private buildFooter(
        width: number,
        padding: number,
        scrollInfo: string,
    ): string {
        const contentWidth = Math.max(0, width - padding * 2);
        const hint =
            this.theme.fg("dim", "esc") +
            this.theme.fg("muted", " dismiss · ") +
            this.theme.fg("dim", "↑↓") +
            this.theme.fg("muted", " scroll");
        if (!scrollInfo) {
            return truncateToWidth(hint, contentWidth);
        }
        const info = this.theme.fg("muted", scrollInfo);
        const infoWidth = visibleWidth(info);
        const left = truncateToWidth(
            hint,
            Math.max(0, contentWidth - infoWidth - 2),
        );
        const gap = " ".repeat(
            Math.max(1, contentWidth - visibleWidth(left) - infoWidth),
        );
        return left + gap + info;
    }

    render(width: number): string[] {
        const rows = this.tui.terminal.rows ?? 24;
        if (
            this.cachedLines &&
            this.cachedWidth === width &&
            this.cachedRows === rows
        ) {
            return this.cachedLines;
        }

        const theme = this.theme;
        const renderWidth = Math.max(1, width);
        const padding = Math.min(
            1,
            Math.max(0, Math.floor((renderWidth - 1) / 2)),
        );
        const layout = panelLayout(rows);

        const bodyLines = this.buildBodyLines(renderWidth, padding);
        const visibleRows = layout.bodyRows;
        const scroll = resolveScrollState(
            this.scrollOffset,
            bodyLines.length,
            Math.max(1, visibleRows),
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
                : "";
        const title = truncateToWidth(
            `${theme.fg("accent", theme.bold("BTW"))}${theme.fg(
                "muted",
                ` · ${this.meta}`,
            )}`,
            Math.max(0, renderWidth - padding * 2),
        );

        const borderColor = (s: string) => theme.fg("border", s);
        const panel = new Container();
        panel.addChild(new DynamicBorder(borderColor));
        panel.addChild(new Text(title, padding, 0));
        // Blank separators are the first rows dropped on short terminals.
        if (layout.spacers === PANEL_MAX_SPACERS) panel.addChild(new Spacer(1));
        panel.addChild(new LinesComponent(visibleBodyLines));
        if (layout.spacers >= 1) panel.addChild(new Spacer(1));
        panel.addChild(
            new Text(
                this.buildFooter(renderWidth, padding, scrollInfo),
                padding,
                0,
            ),
        );
        panel.addChild(new DynamicBorder(borderColor));

        const lines = panel.render(renderWidth);
        // Extremely short terminals cannot fit the chrome: keep the footer and
        // the bottom rule instead of letting the overlay clip them.
        const budget = panelRowBudget(rows);
        if (lines.length > budget) {
            lines.splice(0, lines.length - budget);
        }

        this.cachedWidth = width;
        this.cachedRows = rows;
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
    },
    {
        overlay: true,
        overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            // Keep Pi's bottom rows visible below the panel.
            margin: { bottom: PANEL_RESERVED_ROWS },
        },
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
            return new BtwPanel(
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
                anchor: "bottom-center",
                width: "100%",
                // Keep Pi's bottom rows visible below the panel.
                margin: { bottom: PANEL_RESERVED_ROWS },
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
