import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Editor,
    type EditorTheme,
    Key,
    matchesKey,
    Spacer,
    Text,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AskAnswer, type AskOption, sortAnswers } from "./core.ts";

interface DisplayOption extends AskOption {
    id: string;
}

export function getOtherLabel(options: AskOption[]): string {
    return options.some((option) => option.label.toLowerCase() === "other")
        ? "Other (custom)"
        : "Other";
}

function createEditorTheme(theme: Theme): EditorTheme {
    return {
        // The editor sits inside the frame, so keep its border quieter than the
        // outer rule and the accent-colored focus row.
        borderColor: (s) => theme.fg("borderMuted", s),
        selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
        },
    };
}

// Shared layout grid: every rendered row starts at one of these columns so the
// question, choices, descriptions, editor, and hints line up on the same guides.
const CONTENT_INDENT = 1;
const EDITOR_INDENT = 2;

const FOCUS_PREFIX = "→ ";
// Must equal the visible width of FOCUS_PREFIX.
const FOCUS_PREFIX_WIDTH = 2;
const CHECKED_MARKER = "[x] ";
const UNCHECKED_MARKER = "[ ] ";

/** Height cap for an inline bottom panel, leaving room for Pi's surrounding UI. */
const PANEL_MAX_HEIGHT_PERCENT = 92;
/** Rows reserved outside the panel for Pi's footer and surrounding UI. */
const PANEL_RESERVED_ROWS = 2;

/** Maximum panel rows within the terminal height minus the reserved rows. */
function panelRowBudget(termRows: number): number {
    const capped = Math.floor((termRows * PANEL_MAX_HEIGHT_PERCENT) / 100);
    const available = Math.max(1, termRows - PANEL_RESERVED_ROWS);
    return Math.max(1, Math.min(capped, available));
}

interface ChoiceRow {
    id: string;
    label: string;
    description?: string;
    /** Text appended after the label once a custom answer is saved. */
    suffix?: string;
    /**
     * Static marker rendered before the label, e.g. "1. " for single-choice
     * numbering or "[x] " / "[ ] " for multi-choice checkboxes. Kept separate
     * from the label so descriptions can align with the label text.
     */
    marker?: string;
    /** Action rows such as Submit stay outside the scrollable choice list. */
    pinned?: boolean;
}

interface FrameConfig {
    question: string;
    context?: string;
    choices: ChoiceRow[];
    focusedIndex: number;
    editor?: { label?: string; component: Editor };
    /** Fully styled key hint: keys dim, descriptions muted. */
    hint: string;
    /** Shown above the hint, e.g. while nothing is selected yet. */
    warning?: string;
}

/** Scroll state kept across renders so the viewport follows the focused row. */
interface ViewportState {
    offset: number;
    initialized: boolean;
    focusIndex: number;
    bodyBudget: number;
}

/** Keys use dim and descriptions muted, matching Pi's built-in hints. */
function formatHint(
    theme: Theme,
    parts: Array<{ key: string; description?: string }>,
): string {
    return parts
        .map(
            ({ key, description }) =>
                theme.fg("dim", key) +
                (description ? theme.fg("muted", ` ${description}`) : ""),
        )
        .join(theme.fg("muted", " · "));
}

function pushWrapped(
    lines: string[],
    text: string,
    width: number,
    indent = "",
): void {
    const contentWidth = Math.max(1, width - visibleWidth(indent));
    for (const line of wrapTextWithAnsi(text, contentWidth)) {
        lines.push(truncateToWidth(`${indent}${line}`, width));
    }
}

/**
 * Renders one thin choice row: optional marker, label, custom-answer suffix,
 * a full-row focus background, and a description indented under the label.
 */
function renderChoiceRow(
    theme: Theme,
    width: number,
    row: ChoiceRow,
    focused: boolean,
): string[] {
    const lines: string[] = [];
    const filled = Boolean(row.suffix);
    const marker = row.marker ?? "";
    const label = `${marker}${row.label}${row.suffix ?? ""}`;
    const prefix = focused
        ? theme.fg("accent", FOCUS_PREFIX)
        : " ".repeat(FOCUS_PREFIX_WIDTH);
    const fg = focused || filled ? "accent" : "text";

    const content = truncateToWidth(`${prefix}${theme.fg(fg, label)}`, width);
    if (focused) {
        // Highlight the whole row so the cursor is legible on any theme.
        const padding = " ".repeat(Math.max(0, width - visibleWidth(content)));
        lines.push(
            theme.style(`${content}${padding}`, {
                fg,
                bg: "selectedBg",
            }),
        );
    } else {
        lines.push(content);
    }

    if (row.description) {
        pushWrapped(
            lines,
            theme.fg("muted", row.description),
            width,
            // Line descriptions up with this row's label text (after the
            // marker), so they stay flush for both numbering and checkboxes.
            " ".repeat(FOCUS_PREFIX_WIDTH + visibleWidth(marker)),
        );
    }
    return lines;
}

interface ChoiceBlock {
    row: ChoiceRow;
    /** Index of the row in FrameConfig.choices. */
    index: number;
    lines: string[];
}

interface BodyLayout {
    lines: string[];
    focusedSpans: Map<number, { start: number; end: number }>;
}

/**
 * Flattens the question and scrollable choice rows, remembering which lines
 * belong to each choice so the viewport can keep the focused row visible.
 */
function layoutBody(
    headerLines: string[],
    blocks: ChoiceBlock[],
    includeBlank: boolean,
): BodyLayout {
    const lines = [...headerLines];
    const focusedSpans = new Map<number, { start: number; end: number }>();
    if (includeBlank) lines.push("");
    for (const block of blocks) {
        const start = lines.length;
        lines.push(...block.lines);
        focusedSpans.set(block.index, { start, end: lines.length });
    }
    return { lines, focusedSpans };
}

/** Right-aligns muted scroll position text on the last hint line. */
function withScrollInfo(
    lines: string[],
    info: string,
    width: number,
    indent: number,
): string[] {
    if (lines.length === 0) return lines;
    const result = [...lines];
    const index = result.length - 1;
    const infoWidth = visibleWidth(info);
    const left = truncateToWidth(
        result[index] ?? "",
        Math.max(0, width - indent - infoWidth - 1),
        "",
    );
    const gap = Math.max(1, width - visibleWidth(left) - infoWidth - indent);
    result[index] =
        left +
        " ".repeat(gap) +
        info +
        " ".repeat(Math.max(0, width - visibleWidth(left) - gap - infoWidth));
    return result;
}

type BottomSegment =
    | { kind: "blank" }
    | { kind: "lines"; lines: string[]; droppable: boolean };

/**
 * Renders one interactive question screen for both choice modes: border-colored
 * outer rules, a shared indentation grid, accent only on the focused row, a
 * selectedBg highlight for the row the cursor is on, and a bounded viewport
 * that keeps the focused row, the pinned action row, the hint, and the inline
 * editor visible within the panel's height budget.
 */
function renderFrame(
    theme: Theme,
    width: number,
    maxHeight: number,
    config: FrameConfig,
    viewport: ViewportState,
): string[] {
    const renderWidth = Math.max(1, width);
    const borderColor = (s: string) => theme.fg("border", s);

    const header = new Container();
    header.addChild(
        new Text(
            theme.bold(theme.fg("accent", config.question)),
            CONTENT_INDENT,
            0,
        ),
    );
    if (config.context) {
        header.addChild(new Spacer(1));
        header.addChild(
            new Text(theme.fg("muted", config.context), CONTENT_INDENT, 0),
        );
    }

    const blocks: ChoiceBlock[] = config.choices.map((row, index) => ({
        row,
        index,
        lines: renderChoiceRow(
            theme,
            renderWidth,
            row,
            index === config.focusedIndex,
        ),
    }));
    const scrollableBlocks = blocks.filter((block) => !block.row.pinned);
    const pinnedLines = blocks
        .filter((block) => block.row.pinned)
        .flatMap((block) => block.lines);
    // Keep one blank row between the scrollable choices and fixed action rows.
    let pinnedSeparator = pinnedLines.length > 0;

    // Rows that must stay visible: the outer rules, pinned action rows such as
    // Submit, the warning, the hint, and the inline editor. Short terminals
    // drop blank rows and the warning before they hide a choice.
    const bottomSegments: BottomSegment[] = [];
    if (config.editor) {
        bottomSegments.push({ kind: "blank" });
        if (config.editor.label) {
            bottomSegments.push({
                kind: "lines",
                lines: new Text(
                    theme.fg("muted", config.editor.label),
                    EDITOR_INDENT,
                    0,
                ).render(renderWidth),
                droppable: false,
            });
        }
        const editorLines = config.editor.component
            .render(Math.max(1, renderWidth - EDITOR_INDENT))
            .map((line) => `${" ".repeat(EDITOR_INDENT)}${line}`);
        bottomSegments.push({
            kind: "lines",
            lines: editorLines,
            droppable: false,
        });
    }
    bottomSegments.push({ kind: "blank" });
    if (config.warning) {
        bottomSegments.push({
            kind: "lines",
            lines: new Text(
                theme.fg("warning", config.warning),
                CONTENT_INDENT,
                0,
            ).render(renderWidth),
            droppable: true,
        });
    }
    bottomSegments.push({
        kind: "lines",
        lines: new Text(config.hint, CONTENT_INDENT, 0).render(renderWidth),
        droppable: false,
    });

    const flattenBottom = (): string[] =>
        bottomSegments.flatMap((segment) =>
            segment.kind === "blank" ? [""] : segment.lines,
        );
    let bottomLines = flattenBottom();
    let fixedRows = 2 + pinnedLines.length + (pinnedSeparator ? 1 : 0);
    while (fixedRows + 1 + bottomLines.length > maxHeight) {
        // Compress the action-row separator before hiding content.
        if (pinnedSeparator) {
            pinnedSeparator = false;
            fixedRows -= 1;
            continue;
        }
        let removed = false;
        for (let i = bottomSegments.length - 1; i >= 0 && !removed; i--) {
            const segment = bottomSegments[i];
            if (segment && (segment.kind === "blank" || segment.droppable)) {
                bottomSegments.splice(i, 1);
                removed = true;
            }
        }
        if (!removed) break;
        bottomLines = flattenBottom();
    }
    const bodyBudget = Math.max(0, maxHeight - fixedRows - bottomLines.length);

    let body = layoutBody(header.render(renderWidth), scrollableBlocks, true);
    if (body.lines.length > bodyBudget) {
        // Compress the separator blank before scrolling the body.
        body = layoutBody(header.render(renderWidth), scrollableBlocks, false);
    }

    let visibleBody = body.lines;
    let scrollInfo: string | undefined;
    if (body.lines.length > bodyBudget) {
        const maxOffset = Math.max(0, body.lines.length - bodyBudget);
        let offset = Math.max(0, Math.min(viewport.offset, maxOffset));
        const span = body.focusedSpans.get(config.focusedIndex);
        const focusHidden =
            span !== undefined &&
            (span.start < offset || span.end > offset + bodyBudget);
        if (
            viewport.initialized &&
            (viewport.focusIndex !== config.focusedIndex ||
                viewport.bodyBudget !== bodyBudget ||
                focusHidden)
        ) {
            if (span) {
                if (span.start < offset) offset = span.start;
                else if (span.end > offset + bodyBudget)
                    offset = span.end - bodyBudget;
            }
            offset = Math.max(0, Math.min(offset, maxOffset));
        }
        viewport.offset = offset;
        visibleBody = body.lines.slice(offset, offset + bodyBudget);
        if (bodyBudget > 0) {
            scrollInfo = `${offset + 1}-${offset + bodyBudget}/${body.lines.length}`;
        }
    } else {
        viewport.offset = 0;
    }
    viewport.initialized = true;
    viewport.focusIndex = config.focusedIndex;
    viewport.bodyBudget = bodyBudget;

    if (scrollInfo) {
        const hint = bottomSegments[bottomSegments.length - 1];
        if (hint && hint.kind === "lines") {
            hint.lines = withScrollInfo(
                hint.lines,
                theme.fg("muted", scrollInfo),
                renderWidth,
                CONTENT_INDENT,
            );
            bottomLines = flattenBottom();
        }
    }

    const lines = [
        ...new DynamicBorder(borderColor).render(renderWidth),
        ...visibleBody,
        ...(pinnedSeparator ? [""] : []),
        ...pinnedLines,
        ...bottomLines,
        ...new DynamicBorder(borderColor).render(renderWidth),
    ];
    // Never render past the panel height: keep the bottom rows (hint,
    // editor, pinned action rows) and clip from the top instead.
    if (lines.length > maxHeight) {
        return lines.slice(lines.length - maxHeight);
    }
    return lines;
}

export async function askSingleChoice(
    ctx: ExtensionContext,
    question: string,
    context: string | undefined,
    options: AskOption[],
): Promise<AskAnswer | null> {
    const otherLabel = getOtherLabel(options);

    return ctx.ui.custom<AskAnswer | null>(
        (tui, theme, _keybindings, done) => {
            let optionIndex = 0;
            let editMode = false;
            let cachedWidth: number | undefined;
            let cachedRows: number | undefined;
            let cachedLines: string[] | undefined;
            const viewport: ViewportState = {
                offset: 0,
                initialized: false,
                focusIndex: -1,
                bodyBudget: -1,
            };
            const editor = new Editor(tui, createEditorTheme(theme));

            editor.onSubmit = (value) => {
                const trimmed = value.trim();
                if (!trimmed) return;
                done({ type: "other", label: trimmed, value: trimmed });
            };

            function refresh() {
                cachedLines = undefined;
                tui.requestRender();
            }

            function handleInput(data: string) {
                if (editMode) {
                    if (matchesKey(data, Key.escape)) {
                        editMode = false;
                        editor.setText("");
                        refresh();
                        return;
                    }
                    editor.handleInput(data);
                    refresh();
                    return;
                }

                if (matchesKey(data, Key.up)) {
                    optionIndex = Math.max(0, optionIndex - 1);
                    refresh();
                    return;
                }
                if (matchesKey(data, Key.down)) {
                    optionIndex = Math.min(options.length, optionIndex + 1);
                    refresh();
                    return;
                }
                if (matchesKey(data, Key.enter)) {
                    if (optionIndex === options.length) {
                        editMode = true;
                        editor.setText("");
                        refresh();
                        return;
                    }
                    const option = options[optionIndex];
                    done({
                        type: "option",
                        label: option.label,
                        value: option.value,
                        index: optionIndex + 1,
                    });
                    return;
                }
                if (matchesKey(data, Key.escape)) {
                    done(null);
                }
            }

            function render(width: number): string[] {
                const renderWidth = Math.max(1, width);
                const rows = tui.terminal.rows ?? 24;
                if (
                    cachedLines &&
                    cachedWidth === renderWidth &&
                    cachedRows === rows
                ) {
                    return cachedLines;
                }

                const typed = editor.getText().trim();

                cachedLines = renderFrame(
                    theme,
                    renderWidth,
                    panelRowBudget(rows),
                    {
                        question,
                        context,
                        choices: [
                            ...options.map((option, index) => ({
                                id: `option:${index}`,
                                label: option.label,
                                marker: `${index + 1}. `,
                                description: option.description,
                            })),
                            {
                                id: "other",
                                label: otherLabel,
                                // Live preview of the custom answer while typing.
                                suffix:
                                    editMode && typed
                                        ? ` — ${typed}`
                                        : undefined,
                            },
                        ],
                        focusedIndex: optionIndex,
                        editor: editMode
                            ? {
                                  label: "Write your custom answer:",
                                  component: editor,
                              }
                            : undefined,
                        hint: editMode
                            ? formatHint(theme, [
                                  { key: "enter", description: "submit" },
                                  { key: "esc", description: "back" },
                              ])
                            : formatHint(theme, [
                                  { key: "↑↓" },
                                  { key: "enter" },
                                  { key: "esc" },
                              ]),
                    },
                    viewport,
                );
                cachedWidth = renderWidth;
                cachedRows = rows;
                return cachedLines;
            }

            return {
                // Propagate focus for IME cursor positioning in the editor.
                get focused() {
                    return editor.focused;
                },
                set focused(value: boolean) {
                    editor.focused = value;
                    cachedLines = undefined;
                },
                render,
                invalidate: () => {
                    cachedWidth = undefined;
                    cachedRows = undefined;
                    cachedLines = undefined;
                    editor.invalidate();
                },
                handleInput,
            };
        },
    );
}

export async function askMultiChoice(
    ctx: ExtensionContext,
    question: string,
    context: string | undefined,
    options: AskOption[],
): Promise<AskAnswer[] | null> {
    const otherLabel = getOtherLabel(options);
    const choiceItems: DisplayOption[] = options.map((option, index) => ({
        ...option,
        id: `option:${index}`,
    }));
    const submitIndex = choiceItems.length + 1;

    return ctx.ui.custom<AskAnswer[] | null>(
        (tui, theme, _keybindings, done) => {
            let optionIndex = 0;
            let editMode = false;
            let cachedWidth: number | undefined;
            let cachedRows: number | undefined;
            let cachedLines: string[] | undefined;
            const viewport: ViewportState = {
                offset: 0,
                initialized: false,
                focusIndex: -1,
                bodyBudget: -1,
            };
            // Set while editing an Other row that already holds an answer, so an
            // empty submit clears the answer instead of being ignored.
            let otherHadAnswer = false;
            const selected = new Map<string, AskAnswer>();
            const editor = new Editor(tui, createEditorTheme(theme));

            editor.onSubmit = (value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                    // Empty submit on a filled Other row removes that answer.
                    if (otherHadAnswer) {
                        selected.delete("other");
                        otherHadAnswer = false;
                        editMode = false;
                        refresh();
                    }
                    return;
                }
                selected.set("other", {
                    type: "other",
                    label: trimmed,
                    value: trimmed,
                });
                otherHadAnswer = false;
                editMode = false;
                refresh();
            };

            function refresh() {
                cachedLines = undefined;
                tui.requestRender();
            }

            function toggleOption(index: number) {
                const item = choiceItems[index];
                if (selected.has(item.id)) {
                    selected.delete(item.id);
                } else {
                    selected.set(item.id, {
                        type: "option",
                        label: item.label,
                        value: item.value,
                        index: index + 1,
                    });
                }
                refresh();
            }

            // Rows are positional: choices, then the Other row, then Submit.
            const otherIndex = choiceItems.length;

            function handleInput(data: string) {
                if (editMode) {
                    if (matchesKey(data, Key.escape)) {
                        editMode = false;
                        otherHadAnswer = false;
                        editor.setText(selected.get("other")?.label || "");
                        refresh();
                        return;
                    }
                    // Tracked here so every way of opening the editor behaves alike.
                    otherHadAnswer = selected.has("other");
                    editor.handleInput(data);
                    refresh();
                    return;
                }

                if (matchesKey(data, Key.up)) {
                    optionIndex = Math.max(0, optionIndex - 1);
                    refresh();
                    return;
                }
                if (matchesKey(data, Key.down)) {
                    optionIndex = Math.min(submitIndex, optionIndex + 1);
                    refresh();
                    return;
                }

                if (matchesKey(data, Key.space)) {
                    if (optionIndex === submitIndex) return;
                    if (optionIndex === otherIndex) {
                        // Open (or re-open) the editor. Pressing Space on the Other
                        // row must never silently discard a saved custom answer.
                        editMode = true;
                        editor.setText(selected.get("other")?.label || "");
                        refresh();
                        return;
                    }
                    toggleOption(optionIndex);
                    return;
                }

                if (matchesKey(data, Key.enter)) {
                    if (optionIndex === submitIndex) {
                        if (selected.size > 0) {
                            done(sortAnswers(Array.from(selected.values())));
                        }
                        return;
                    }
                    if (optionIndex === otherIndex) {
                        editMode = true;
                        editor.setText(selected.get("other")?.label || "");
                        refresh();
                        return;
                    }
                    toggleOption(optionIndex);
                    return;
                }

                if (matchesKey(data, Key.escape)) {
                    done(null);
                }
            }

            function render(width: number): string[] {
                const renderWidth = Math.max(1, width);
                const rows = tui.terminal.rows ?? 24;
                if (
                    cachedLines &&
                    cachedWidth === renderWidth &&
                    cachedRows === rows
                ) {
                    return cachedLines;
                }

                const choices: ChoiceRow[] = choiceItems.map((item) => ({
                    id: item.id,
                    label: item.label,
                    description: item.description,
                    marker: selected.has(item.id)
                        ? CHECKED_MARKER
                        : UNCHECKED_MARKER,
                }));
                const other = selected.get("other");
                choices.push({
                    id: "other",
                    label: otherLabel,
                    suffix: other ? ` — ${other.label}` : undefined,
                    // A saved custom answer is a selection like any other.
                    marker: other ? CHECKED_MARKER : UNCHECKED_MARKER,
                });
                choices.push({
                    id: "submit",
                    label:
                        selected.size > 0
                            ? `Submit (${selected.size} selected)`
                            : "Submit",
                    // Keep the submit action visible while the choices scroll.
                    pinned: true,
                });

                cachedLines = renderFrame(
                    theme,
                    renderWidth,
                    panelRowBudget(rows),
                    {
                        question,
                        context,
                        choices,
                        focusedIndex: optionIndex,
                        editor: editMode
                            ? {
                                  label: "Write your custom answer:",
                                  component: editor,
                              }
                            : undefined,
                        warning:
                            !editMode && selected.size === 0
                                ? "Select at least one answer before submitting."
                                : undefined,
                        hint: editMode
                            ? formatHint(theme, [
                                  { key: "enter", description: "save" },
                                  { key: "esc", description: "back" },
                              ])
                            : formatHint(theme, [
                                  { key: "↑↓" },
                                  { key: "space" },
                                  { key: "enter" },
                                  { key: "esc" },
                              ]),
                    },
                    viewport,
                );
                cachedWidth = renderWidth;
                cachedRows = rows;
                return cachedLines;
            }

            return {
                // Propagate focus for IME cursor positioning in the editor.
                get focused() {
                    return editor.focused;
                },
                set focused(value: boolean) {
                    editor.focused = value;
                    cachedLines = undefined;
                },
                render,
                invalidate: () => {
                    cachedWidth = undefined;
                    cachedRows = undefined;
                    cachedLines = undefined;
                    editor.invalidate();
                },
                handleInput,
            };
        },
    );
}
