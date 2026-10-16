import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { deliverHandoff } from "../src/delivery.ts";
import { HandoffStore, type HandoffPayload } from "../src/bundle.ts";
import { HerdrClient, herdrEnvironment, INIT_FLAG, parseHerdrResponse, STORE_FLAG, type HerdrRunner } from "../src/herdr.ts";
import { payload, withStore } from "./fixtures.ts";

const environment = { executable: "not-executed", workspaceId: "w1", paneId: "w1:p1" };
const pane = { pane_id: "w1:p42", terminal_id: "actual-terminal", workspace_id: "w1" };

function fakeHerdr(store: HandoffStore, mode: "ready" | "failed" | "startup-error" | "no-receipt" | "focus-error" = "ready") {
	const calls: string[][] = [];
	const runner: HerdrRunner = async (args) => {
		calls.push(args);
		if (args[0] === "tab") return { tab: { tab_id: "opaque-tab" }, root_pane: pane };
		if (args[0] === "pane") return { pane };
		const agent = { ...pane, name: calls.find((call) => call[1] === "start")?.[2], agent: "pi", agent_session: { value: "initialized-session" } };
		if (args[1] === "start") {
			if (mode === "startup-error") throw new Error("agent_not_ready");
			const id = args[args.indexOf(`--${INIT_FLAG}`) + 1];
			assert.equal(args[args.indexOf(`--${STORE_FLAG}`) + 1], store.root);
			if (mode !== "no-receipt") {
				const claimed = await store.claim(id, process.cwd(), pane.pane_id);
				assert.equal(claimed.payload.prompt, payload().prompt);
				await claimed.ticket.acknowledge(mode === "failed" ? { status: "failed" } : {
					status: "ready", paneId: pane.pane_id, sessionId: "initialized-session",
				});
			}
		}
		if (args[1] === "focus" && mode === "focus-error") throw new Error("focus failed");
		if (args[1] === "focus") assert.deepEqual(await readdir(store.root), [], "transport is cleaned before focus");
		return { agent };
	};
	return { client: new HerdrClient(environment, runner), calls };
}

test("JSON envelope parsing and herdr environment fail closed", () => {
	assert.deepEqual(parseHerdrResponse('{"result":{"ok":true}}'), { ok: true });
	assert.throws(() => parseHerdrResponse("not json"), /invalid JSON/);
	assert.throws(() => parseHerdrResponse('{"error":{"code":"agent_not_ready","message":"blocked"}}'), /agent_not_ready/);
	assert.throws(() => herdrEnvironment({}), /--here explicitly/);
	assert.deepEqual(herdrEnvironment({
		HERDR_ENV: "1", HERDR_SOCKET_PATH: "socket", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "binary",
	}), { executable: "binary", workspaceId: "w1", paneId: "w1:p1" });
});

test("default-tab delivery waits for initialization, cleans data, then focuses; never sends draft bytes", async () => {
	await withStore(async (store) => {
		const { client, calls } = fakeHerdr(store);
		const result = await deliverHandoff({
			payload: payload(), destination: "tab", store, herdr: client, extension: "E:/with space/entry.ts",
			signal: new AbortController().signal, hasDraftBackup: () => true,
		});
		assert.equal(result.paneId, pane.pane_id);
		assert.deepEqual(calls.map((call) => call.slice(0, 2).join(" ")), ["tab create", "agent start", "agent get", "agent focus"]);
		assert.ok(calls[0].includes("--no-focus"));
		assert.equal(calls[0][calls[0].indexOf("--cwd") + 1], process.cwd());
		const agentArgs = calls[1].slice(calls[1].indexOf("--") + 1);
		assert.equal(agentArgs.length, 6, "only explicit extension and two flags; no initialMessage");
		assert.equal(agentArgs[1], "E:/with space/entry.ts");
		for (const call of calls) {
			assert.ok(!call.includes(payload().prompt));
			assert.ok(!call.includes(payload().goal));
			assert.ok(!["prompt", "send-text", "send-keys", "run", "close"].includes(call[1]));
		}
	});
});

test("split uses caller pane and returned ID, with no focus during creation", async () => {
	await withStore(async (store) => {
		const { client, calls } = fakeHerdr(store);
		await deliverHandoff({
			payload: payload(), destination: "down", store, herdr: client, extension: "entry.ts",
			signal: new AbortController().signal, hasDraftBackup: () => true,
		});
		assert.deepEqual(calls[0].slice(0, 6), ["pane", "split", "--pane", "w1:p1", "--direction", "down"]);
		assert.equal(calls[1][calls[1].indexOf("--pane") + 1], "w1:p42");
	});
});

for (const mode of ["failed", "startup-error", "focus-error"] as const) {
	test(`${mode}: report failure, do not retry or close the created pane, remove package when source has backup`, async () => {
		await withStore(async (store) => {
			const { client, calls } = fakeHerdr(store, mode);
			await assert.rejects(deliverHandoff({
				payload: payload(), destination: "tab", store, herdr: client, extension: "entry.ts",
				signal: new AbortController().signal, hasDraftBackup: () => true,
			}), /Reviewed draft retained/);
			assert.equal(calls.filter((call) => call[1] === "start").length, 1);
			assert.ok(!calls.some((call) => call[1] === "close"));
			if (mode !== "focus-error") assert.ok(!calls.some((call) => call[1] === "focus"));
			assert.deepEqual(await readdir(store.root), []);
		});
	});
}

test("timeout without target receipt never focuses or retries", async () => {
	await withStore(async (base) => {
		class ShortStore extends HandoffStore {
			override create(data: HandoffPayload) { return super.create(data, 20); }
		}
		const store = new ShortStore(base.root);
		const { client, calls } = fakeHerdr(store, "no-receipt");
		await assert.rejects(deliverHandoff({
			payload: payload(), destination: "tab", store, herdr: client, extension: "entry.ts",
			signal: new AbortController().signal, hasDraftBackup: () => true,
		}), /expired/);
		assert.ok(!calls.some((call) => call[1] === "focus"));
		assert.equal(calls.filter((call) => call[1] === "start").length, 1);
		assert.deepEqual(await readdir(store.root), []);
	});
});

test("shutdown without editor backup revokes but retains a private recovery package", async () => {
	await withStore(async (store) => {
		const { client, calls } = fakeHerdr(store, "startup-error");
		await assert.rejects(deliverHandoff({
			payload: payload(), destination: "tab", store, herdr: client, extension: "entry.ts",
			signal: new AbortController().signal, hasDraftBackup: () => false,
		}), /retained for recovery/);
		const [id] = await readdir(store.root);
		assert.ok(id);
		assert.equal(JSON.parse(await readFile(join(store.root, id, "package.json"), "utf8")).prompt, payload().prompt);
		await assert.rejects(store.claim(id, process.cwd(), pane.pane_id), /cancelled/);
		assert.ok(!calls.some((call) => call[1] === "focus"));
	});
});

test("abort before delivery creates neither layout nor package", async () => {
	await withStore(async (store) => {
		const { client, calls } = fakeHerdr(store);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(deliverHandoff({
			payload: payload(), destination: "tab", store, herdr: client, extension: "entry.ts",
			signal: controller.signal, hasDraftBackup: () => true,
		}), /abort/i);
		assert.deepEqual(calls, []);
	});
});

test("changed destination agent identity prevents focus", async () => {
	const calls: string[][] = [];
	const client = new HerdrClient(environment, async (args) => {
		calls.push(args);
		return { agent: { ...pane, name: "wrong-occupant", agent: "pi" } };
	});
	await assert.rejects(client.focus({ paneId: pane.pane_id, terminalId: pane.terminal_id, name: "expected" }, new AbortController().signal, { sessionId: "initialized-session" }), /identity changed/);
	assert.equal(calls.length, 1);
});

test("focus checks the official integration session ID/path, not just the pane occupant", async () => {
	const expected = { sessionId: "initialized-session", sessionFile: process.cwd() + "/target.jsonl" };
	for (const value of [expected.sessionId, expected.sessionFile, "another-session"]) {
		const calls: string[][] = [];
		const client = new HerdrClient(environment, async (args) => {
			calls.push(args);
			return { agent: { ...pane, name: "expected", agent: "pi", agent_session: { value } } };
		});
		const focus = client.focus({ paneId: pane.pane_id, terminalId: pane.terminal_id, name: "expected" }, new AbortController().signal, expected);
		if (value === "another-session") {
			await assert.rejects(focus, /session changed/);
			assert.equal(calls.length, 1);
		} else {
			await focus;
			assert.equal(calls.length, 2);
			assert.equal(calls[1][1], "focus");
		}
	}
});
