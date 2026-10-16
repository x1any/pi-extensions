import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerHandoffInitialization, INITIALIZE_COMMAND } from "../src/init.ts";
import { openHandoffSession } from "../src/session.ts";
import { INIT_FLAG, STORE_FLAG } from "../src/herdr.ts";
import { fakeSession, payload, withStore } from "./fixtures.ts";

function fakePi(ctx: ExtensionCommandContext, flags: Record<string, string> = {}) {
	const events = new Map<string, ((event: unknown, ctx: ExtensionCommandContext) => unknown)[]>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const sent: { content: string; options: unknown }[] = [];
	let task: Promise<void> | undefined;
	const pi = {
		registerFlag: () => {},
		getFlag: (name: string) => flags[name],
		on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => { commands.set(name, command); },
		getCommands: () => [...commands.keys()].map((name) => ({ name })),
		sendUserMessage: (content: string, options: unknown) => {
			sent.push({ content, options });
			// Model dispatch is deliberately unavailable: only this registered command
			// can run; any draft routed here fails the test.
			assert.equal(content, `/${INITIALIZE_COMMAND}`);
			assert.deepEqual(options, { expandPromptTemplates: true });
			task = commands.get(INITIALIZE_COMMAND)!.handler("", ctx);
		},
	} as unknown as ExtensionAPI;
	registerHandoffInitialization(pi);
	return {
		sent, commands,
		emit: async (name: string, event: unknown) => { for (const handler of events.get(name) ?? []) await handler(event, ctx); },
		flush: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); await task; },
	};
}

test("shared session initializer writes name, parent and provenance through setup, draft only through fresh context", async () => {
	const { ctx, state } = fakeSession();
	const data = payload();
	data.record.source.file = process.cwd() + "/source.jsonl";
	const result = await openHandoffSession(ctx, data);
	assert.equal(result.sessionId, "target-session");
	assert.equal(state.name, data.goal);
	assert.equal(state.parent, data.record.source.file);
	assert.deepEqual(state.entries, [{ type: "pi-handoff", data: data.record }]);
	assert.equal(state.text, data.prompt);
	assert.equal(state.original, "", "does not write through the stale original UI");
});

test("cancelled --here switch leaves no metadata; invalid replacement cannot claim success", async () => {
	const cancelled = fakeSession(true);
	assert.deepEqual(await openHandoffSession(cancelled.ctx, payload()), { cancelled: true, sessionId: undefined });
	assert.deepEqual(cancelled.state.entries, []);
	const replaced = fakeSession();
	replaced.replacement.sessionManager.getSessionId = () => "unrelated-session";
	// setup and withSession share this mock manager, so use the explicit liveness guard.
	await assert.rejects(openHandoffSession(replaced.ctx, payload(), { canPopulate: () => false }), /session changed/);
	assert.equal(replaced.state.text, "");
});

test("target flag bootstrap dispatches only after lifecycle callback; consumes once and acknowledges complete draft", async () => {
	await withStore(async (store) => {
		const ticket = await store.create(payload());
		const pane = process.env.HERDR_PANE_ID;
		const enabled = process.env.HERDR_ENV;
		process.env.HERDR_PANE_ID = "w1:p2";
		process.env.HERDR_ENV = "1";
		try {
			await ticket.bind("w1:p2");
			const { ctx, state } = fakeSession();
			const pi = fakePi(ctx, { [INIT_FLAG]: ticket.id, [STORE_FLAG]: store.root });
			await pi.emit("session_start", { reason: "startup" });
			assert.equal(state.switches, 0);
			await pi.emit("resources_discover", { reason: "startup" });
			assert.equal(state.switches, 0, "never calls newSession from a lifecycle handler");
			await pi.flush();
			assert.equal(state.text, payload().prompt);
			assert.equal(state.switches, 1);
			assert.equal((await ticket.receipt())?.status, "ready");
			assert.equal(pi.sent.length, 1);
			await pi.emit("resources_discover", { reason: "startup" });
			await pi.flush();
			assert.equal(pi.sent.length, 1);
			await pi.commands.get(INITIALIZE_COMMAND)!.handler("", ctx);
			assert.equal(state.switches, 1);
			assert.equal((await ticket.receipt())?.status, "ready", "duplicate does not overwrite success");
		} finally {
			if (pane === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = pane;
			if (enabled === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = enabled;
		}
	});
});

test("ordinary startup, replacement/reload, and shutdown do not bootstrap a message", async () => {
	const ordinary = fakePi(fakeSession().ctx);
	await ordinary.emit("session_start", { reason: "startup" });
	await ordinary.emit("resources_discover", { reason: "startup" });
	await ordinary.flush();
	assert.deepEqual(ordinary.sent, []);
	for (const reason of ["new", "reload", "resume", "fork"]) {
		const pi = fakePi(fakeSession().ctx, { [INIT_FLAG]: "test" });
		await pi.emit("session_start", { reason });
		await pi.emit("resources_discover", { reason: "startup" });
		await pi.flush();
		assert.deepEqual(pi.sent, []);
	}
	const shutdown = fakePi(fakeSession().ctx, { [INIT_FLAG]: "test" });
	await shutdown.emit("session_start", { reason: "startup" });
	await shutdown.emit("resources_discover", { reason: "startup" });
	await shutdown.emit("session_shutdown", { reason: "quit" });
	await shutdown.flush();
	assert.deepEqual(shutdown.sent, []);
});
