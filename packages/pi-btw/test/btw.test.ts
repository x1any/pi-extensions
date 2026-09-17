import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
    BTW_TOOL_RESULT_MAX_CHARS,
    buildBtwUserMessage,
    extractResponseText,
    formatUsage,
    resolveScrollState,
    serializeBtwConversation,
    validateBtwArgs,
} from "../btw.ts";

test("validateBtwArgs rejects empty input", () => {
    for (const args of [undefined, "", "   ", "\n\t"]) {
        const result = validateBtwArgs(args);
        assert.equal(result.ok, false);
        assert.ok(!result.ok);
        assert.match(result.error, /Usage: \/btw/);
    }
});

test("validateBtwArgs trims and returns the question", () => {
    assert.deepEqual(validateBtwArgs("  what does this flag do?  "), {
        ok: true,
        question: "what does this flag do?",
    });
});

test("buildBtwUserMessage embeds context and question", () => {
    const message = buildBtwUserMessage("[User]: hi", "why?");
    assert.match(message, /<conversation_context>\n\[User\]: hi\n<\/conversation_context>/);
    assert.match(message, /<side_question>\nwhy\?\n<\/side_question>/);
});

test("extractResponseText keeps only text blocks", () => {
    const text = extractResponseText([
        { type: "text", text: "hello" },
        { type: "thinking" },
        { type: "text", text: "world" },
    ]);
    assert.equal(text, "hello\nworld");
});

test("serializeBtwConversation keeps tool results above the compaction limit", () => {
    const body = "x".repeat(5000);
    const text = serializeBtwConversation([
        {
            role: "toolResult",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: body }],
        },
    ]);
    assert.equal(text, `[Tool result: read]: ${body}`);
});

test("serializeBtwConversation marks truncated tool results", () => {
    const body = "y".repeat(BTW_TOOL_RESULT_MAX_CHARS + 250);
    const text = serializeBtwConversation([
        {
            role: "toolResult",
            toolName: "bash",
            isError: false,
            content: [{ type: "text", text: body }],
        },
    ]);
    assert.ok(text.includes("250 more characters truncated"));
    assert.ok(text.length < body.length);
});

test("serializeBtwConversation labels tool errors", () => {
    const text = serializeBtwConversation([
        {
            role: "toolResult",
            toolName: "bash",
            isError: true,
            content: [{ type: "text", text: "boom" }],
        },
    ]);
    assert.equal(text, "[Tool error: bash]: boom");
});

test("serializeBtwConversation keeps image placeholders", () => {
    const text = serializeBtwConversation([
        {
            role: "user",
            content: [
                { type: "text", text: "look at this" },
                { type: "image", mimeType: "image/png" },
            ],
        },
    ]);
    assert.equal(text, "[User]: look at this\n[image: image/png]");
});

test("serializeBtwConversation keeps thinking and tool calls", () => {
    const text = serializeBtwConversation([
        {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "hmm" },
                { type: "text", text: "done" },
                { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
            ],
        },
    ]);
    assert.match(text, /\[Assistant thinking\]: hmm/);
    assert.match(text, /\[Assistant\]: done/);
    assert.match(text, /\[Assistant tool calls\]: read\(path="a\.ts"\)/);
});

test("serializeBtwConversation skips empty messages", () => {
    assert.equal(
        serializeBtwConversation([
            { role: "user", content: "" },
            { role: "toolResult", toolName: "read", content: [] },
        ]),
        "",
    );
});

test("formatUsage formats tokens and cost", () => {
    assert.equal(formatUsage(undefined), undefined);
    assert.equal(formatUsage({ totalTokens: 0 }), undefined);
    assert.equal(formatUsage({ totalTokens: 640 }), "640 tokens");
    assert.equal(
        formatUsage({ totalTokens: 12345, cost: { total: 0.01234 } }),
        "12.3k tokens · $0.0123",
    );
});

test("resolveScrollState clamps offsets to the visible rows", () => {
    assert.deepEqual(resolveScrollState(0, 10, 4), {
        maxScrollOffset: 6,
        scrollOffset: 0,
    });
    assert.deepEqual(resolveScrollState(99, 10, 4), {
        maxScrollOffset: 6,
        scrollOffset: 6,
    });
    assert.deepEqual(resolveScrollState(-5, 10, 4), {
        maxScrollOffset: 6,
        scrollOffset: 0,
    });
    assert.deepEqual(resolveScrollState(3, 2, 10), {
        maxScrollOffset: 0,
        scrollOffset: 0,
    });
});
