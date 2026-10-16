import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
    type AskUserQuestionMode,
    type AskUserQuestionResultDetails,
    buildResult,
    cancelledResult,
    normalizeOptions,
    unavailableResult,
} from "./src/core.ts";
import {
    askMultiChoice,
    askSingleChoice,
    getOtherLabel,
} from "./src/ui.ts";

const OptionSchema = Type.Object({
    label: Type.String({
        description:
            'Display label for the option. Do not prefix it with a list number (e.g. "1. "); the UI adds its own selection markers. If you recommend an option, place it first and append "(Recommended)" to the label.',
    }),
    value: Type.Optional(
        Type.String({
            description:
                "Optional machine-readable value returned for the option. Defaults to the label.",
        }),
    ),
    description: Type.Optional(
        Type.String({
            description: "Optional extra detail shown below the option.",
        }),
    ),
});

const AskUserQuestionParams = Type.Object({
    question: Type.String({
        description:
            "The single question to ask the user. Ask exactly one question per tool call.",
    }),
    details: Type.Optional(
        Type.String({
            description:
                "Optional extra context or instructions shown under the question.",
        }),
    ),
    options: Type.Optional(
        Type.Array(OptionSchema, {
            description:
                "Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
        }),
    ),
    multiSelect: Type.Optional(
        Type.Boolean({
            description:
                "Set to true to allow multiple answers to be selected for a question.",
        }),
    ),
});

export default function askUserQuestion(pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user_question",
        label: "ask_user_question",
        description:
            "Ask the user one focused question and wait for a response. Use when clarification or a user decision is needed before proceeding, or when explicit confirmation is required. Supports free-form text, single-select, and multi-select answers.",
        promptSnippet:
            "Ask the user one question for clarification, a decision, or confirmation.",
        promptGuidelines: [
            "Ask only when unresolved requirements or user choices materially affect the next action, or explicit confirmation is required. Check available context first; do not re-ask settled matters.",
            "Ask one focused question at a time, starting with the most blocking. Wait for its answer and reassess before generating the next question.",
            "Treat cancellation, unavailability, or an empty response as unresolved. Do not infer an answer or consent, or proceed with actions that depend on the missing answer.",
        ],
        parameters: AskUserQuestionParams,
        // User interaction must stay directly available, even in codemode-only mode.
        // Scripts and other tools must not trigger blocking prompts indirectly.
        exposure: "model-only",
        // Blocking prompts must not overlap with sibling tool calls.
        executionMode: "sequential",

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const options = normalizeOptions(params.options);
            const context = params.details?.trim() || undefined;
            const mode: AskUserQuestionMode =
                options.length === 0
                    ? "text"
                    : params.multiSelect
                      ? "multi-select"
                      : "single-select";

            if (signal?.aborted) {
                return cancelledResult(params.question, mode, context);
            }

            if (!ctx.hasUI) {
                return unavailableResult(
                    params.question,
                    mode,
                    "ask_user_question requires interactive mode UI",
                    context,
                );
            }

            if (mode !== "text" && ctx.mode !== "tui") {
                return unavailableResult(
                    params.question,
                    mode,
                    "ask_user_question option selection requires TUI mode",
                    context,
                );
            }

            if (mode === "text") {
                const editorTitle = context
                    ? `${params.question}\n\n${context}`
                    : params.question;
                const answer = await ctx.ui.editor(editorTitle);
                if (answer === undefined) {
                    return cancelledResult(params.question, mode, context);
                }
                return buildResult(params.question, context, mode, [
                    {
                        type: "text",
                        label: answer.trim(),
                        value: answer.trim(),
                    },
                ]);
            }

            if (mode === "single-select") {
                const answer = await askSingleChoice(
                    ctx,
                    params.question,
                    context,
                    options,
                );
                if (!answer) {
                    return cancelledResult(params.question, mode, context);
                }
                return buildResult(params.question, context, mode, [answer]);
            }

            const answers = await askMultiChoice(
                ctx,
                params.question,
                context,
                options,
            );
            if (!answers) {
                return cancelledResult(params.question, mode, context);
            }
            return buildResult(params.question, context, mode, answers);
        },

        renderCall(args, theme) {
            const options = normalizeOptions(
                args.options as
                    | Array<{
                          label: string;
                          value?: string;
                          description?: string;
                      }>
                    | undefined,
            );
            let text =
                theme.fg("toolTitle", theme.bold("ask_user_question ")) +
                theme.fg("muted", args.question);
            if (args.multiSelect) {
                text += theme.fg("dim", " [multi-select]");
            }
            if (options.length > 0) {
                const labels = [
                    ...options.map((option) => option.label),
                    getOtherLabel(options),
                ].join(", ");
                text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
            }
            return new Text(text, 0, 0);
        },

        renderResult(result, _options, theme) {
            const details = result.details as
                | AskUserQuestionResultDetails
                | undefined;
            if (!details) {
                const first = result.content[0];
                return new Text(first?.type === "text" ? first.text : "", 0, 0);
            }

            if (details.status === "cancelled") {
                return new Text(
                    theme.fg("warning", details.message || "Cancelled"),
                    0,
                    0,
                );
            }

            if (details.status === "unavailable") {
                return new Text(
                    theme.fg(
                        "warning",
                        details.message || "ask_user_question unavailable",
                    ),
                    0,
                    0,
                );
            }

            const lines = details.answers.map((answer) => {
                switch (answer.type) {
                    case "text":
                        return theme.fg(
                            "accent",
                            answer.label || "(empty response)",
                        );
                    case "other":
                        return `${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
                    case "option":
                        return theme.fg(
                            "accent",
                            `${answer.index}. ${answer.label}`,
                        );
                }
            });
            return new Text(lines.join("\n"), 0, 0);
        },
    });
}
