import assert from "node:assert/strict";
import { lstat, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HandoffStore, RETENTION_MS } from "../src/bundle.ts";
import { payload, withStore } from "./fixtures.ts";

test("private package round trip, exact multiline draft, and atomic one-shot claim", async () => {
	await withStore(async (store) => {
		const data = payload();
		const ticket = await store.create(data);
		await ticket.bind("w1:p2");
		const claims = await Promise.allSettled([store.claim(ticket.id, data.cwd, "w1:p2"), store.claim(ticket.id, data.cwd, "w1:p2")]);
		assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
		const claimed = claims.find((result) => result.status === "fulfilled");
		assert.ok(claimed?.status === "fulfilled");
		assert.equal(claimed.value.payload.prompt, data.prompt);
		if (process.platform !== "win32") {
			assert.equal((await lstat(store.root)).mode & 0o777, 0o700);
			assert.equal((await lstat(join(ticket.directory, "package.json"))).mode & 0o777, 0o600);
		}
		await claimed.value.ticket.acknowledge({ status: "ready", paneId: "w1:p2", sessionId: "target" });
		assert.equal((await ticket.waitForReceipt("w1:p2", new AbortController().signal)).sessionId, "target");
		await ticket.dispose();
		assert.deepEqual(await readdir(store.root), []);
	});
});

test("reject traversal and mismatched destination without permitting a second claim", async () => {
	await withStore(async (store) => {
		await assert.rejects(store.claim("../outside", process.cwd(), "w1:p2"), /Invalid handoff ID/);
		const ticket = await store.create(payload());
		await ticket.bind("w1:p2");
		await assert.rejects(store.claim(ticket.id, process.cwd(), "w1:p3"), /different pane/);
		assert.equal((await ticket.receipt())?.status, "failed");
		await assert.rejects(store.claim(ticket.id, process.cwd(), "w1:p2"), /already claimed/);
	});
});

test("cancelled, expired, malformed and oversize packages fail closed", async () => {
	await withStore(async (store) => {
		const cancelled = await store.create(payload());
		await cancelled.bind("w1:p2");
		await cancelled.cancel();
		await assert.rejects(store.claim(cancelled.id, process.cwd(), "w1:p2"), /cancelled/);
		const expired = await store.create(payload(), 1);
		await expired.bind("w1:p2");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await assert.rejects(store.claim(expired.id, process.cwd(), "w1:p2"), /expired/);
		const malformed = await store.create(payload());
		await malformed.bind("w1:p2");
		await writeFile(join(malformed.directory, "package.json"), "{}");
		await assert.rejects(store.claim(malformed.id, process.cwd(), "w1:p2"), /Invalid handoff/);
		await assert.rejects(store.create({ ...payload(), prompt: "a".repeat(4 * 1024 * 1024) }), /4 MiB/);
	});
});

test("cwd mismatch, invalid receipt and wrong-pane acknowledgement are not success", async () => {
	await withStore(async (store) => {
		const data = { ...payload(), cwd: store.root };
		const ticket = await store.create(data);
		await ticket.bind("w1:p2");
		await assert.rejects(store.claim(ticket.id, process.cwd(), "w1:p2"), /working directory/);
		await writeFile(join(ticket.directory, "receipt.json"), JSON.stringify({ version: 99 }));
		await assert.rejects(ticket.receipt(), /Invalid handoff receipt/);
		await ticket.acknowledge({ status: "ready", paneId: "w1:p3", sessionId: "target" });
		await assert.rejects(ticket.waitForReceipt("w1:p2", new AbortController().signal), /different pane/);
	});
});

test("revocation remains observable after claim; receipt waits honour abort", async () => {
	await withStore(async (store) => {
		const ticket = await store.create(payload());
		await ticket.bind("w1:p2");
		const claimed = await store.claim(ticket.id, process.cwd(), "w1:p2");
		await ticket.cancel();
		await assert.rejects(claimed.ticket.assertActive(), /cancelled/);
		const other = await store.create(payload());
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(other.waitForReceipt("w1:p2", controller.signal), /abort/i);
	});
});

test("crash cleanup prunes only stale owned job directories", async () => {
	await withStore(async (store) => {
		const old = await store.create(payload());
		const fresh = await store.create(payload());
		const then = new Date(Date.now() - RETENTION_MS - 60_000);
		await utimes(old.directory, then, then);
		await store.prune();
		await assert.rejects(readFile(join(old.directory, "package.json")), { code: "ENOENT" });
		assert.ok(await readFile(join(fresh.directory, "package.json")));
	});
});

test("symlink/junction store is refused", async () => {
	await withStore(async (store) => {
		await store.prepare();
		const link = join(store.root, "link");
		await symlink(store.root, link, process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(new HandoffStore(link).prepare(), /must not be a link/);
	});
});
