export interface AskOption {
    label: string;
    value: string;
    description?: string;
}

interface TextAnswer {
    type: "text";
    label: string;
    value: string;
}

interface OptionAnswer {
    type: "option";
    label: string;
    value: string;
    index: number;
}

interface OtherAnswer {
    type: "other";
    label: string;
    value: string;
}

export type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
export type AskUserQuestionMode = "text" | "single-select" | "multi-select";

export interface AskUserQuestionResultDetails {
    status: AskUserQuestionStatus;
    question: string;
    context?: string;
    mode: AskUserQuestionMode;
    answers: AskAnswer[];
    message?: string;
}

export function normalizeOptions(
    options:
        | Array<{ label: string; value?: string; description?: string }>
        | undefined,
): AskOption[] {
    return (options || [])
        .map((option) => ({
            label: option.label.trim(),
            value: option.value?.trim() || option.label.trim(),
            description: option.description?.trim() || undefined,
        }))
        .filter((option) => option.label.length > 0);
}

function formatAnswerForModel(answer: AskAnswer): string {
    switch (answer.type) {
        case "text":
            return answer.label;
        case "other":
            return `Other: ${answer.label}`;
        case "option":
            return `${answer.index}. ${answer.label}`;
    }
}

function answerSortRank(answer: AskAnswer): number {
    switch (answer.type) {
        case "option":
            return answer.index;
        case "other":
            return Number.MAX_SAFE_INTEGER - 1;
        case "text":
            return Number.MAX_SAFE_INTEGER;
    }
}

export function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
    return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
    status: AskUserQuestionStatus,
    question: string,
    mode: AskUserQuestionMode,
    answers: AskAnswer[],
    context?: string,
    message?: string,
) {
    return {
        status,
        question,
        context,
        mode,
        answers,
        message,
    } as AskUserQuestionResultDetails;
}

export function cancelledResult(
    question: string,
    mode: AskUserQuestionMode,
    context?: string,
) {
    const message = "User cancelled the question";
    return {
        content: [{ type: "text" as const, text: message }],
        details: buildStructuredResult(
            "cancelled",
            question,
            mode,
            [],
            context,
            message,
        ),
    };
}

export function unavailableResult(
    question: string,
    mode: AskUserQuestionMode,
    message: string,
    context?: string,
) {
    return {
        content: [{ type: "text" as const, text: message }],
        details: buildStructuredResult(
            "unavailable",
            question,
            mode,
            [],
            context,
            message,
        ),
    };
}

export function buildResult(
    question: string,
    context: string | undefined,
    mode: AskUserQuestionMode,
    answers: AskAnswer[],
) {
    let text: string;
    if (mode === "text") {
        const answer = answers[0];
        text =
            answer.label.trim().length > 0
                ? `User answered: ${answer.label}`
                : "User submitted an empty response";
    } else if (mode === "single-select") {
        text = `User selected: ${formatAnswerForModel(answers[0])}`;
    } else {
        text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
    }

    return {
        content: [{ type: "text" as const, text }],
        details: buildStructuredResult(
            "answered",
            question,
            mode,
            answers,
            context,
        ),
    };
}
