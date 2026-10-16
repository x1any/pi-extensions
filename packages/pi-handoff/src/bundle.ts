/** Private, bounded, one-shot transport. No conversation content enters CLI arguments. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { HandoffRecordData } from "./record.ts";

const execFileAsync = promisify(execFile);
const ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
export const INITIALIZATION_TIMEOUT_MS = 120_000;
/** Crash leftovers are removed on the next source handoff, not by a resident timer. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface HandoffPayload {
	prompt: string;
	goal: string;
	record: HandoffRecordData;
	cwd: string;
	/** New processes use their own Pi defaults, never the source's runtime overrides. */
	configuration: "target-defaults";
}

interface Envelope extends HandoffPayload {
	version: 1;
	id: string;
	createdAt: number;
	expiresAt: number;
}

export type HandoffReceipt =
	| { version: 1; id: string; status: "ready"; paneId: string; sessionId: string; sessionFile?: string }
	| { version: 1; id: string; status: "failed" };

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid handoff data");
	return value as Record<string, unknown>;
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function validateEnvelope(value: unknown, id: string): Envelope {
	const raw = object(value);
	const record = object(raw.record);
	const source = object(record.source);
	if (raw.version !== 1 || raw.id !== id || !text(raw.prompt) || !text(raw.goal) ||
		!text(raw.cwd) || !isAbsolute(raw.cwd) || raw.configuration !== "target-defaults" ||
		!Number.isFinite(raw.createdAt) || !Number.isFinite(raw.expiresAt) ||
		(raw.expiresAt as number) <= (raw.createdAt as number) ||
		(raw.expiresAt as number) - (raw.createdAt as number) > INITIALIZATION_TIMEOUT_MS ||
		record.goal !== raw.goal || !Number.isFinite(record.createdAt) || !text(source.id) ||
		(source.name !== undefined && !text(source.name)) ||
		(source.file !== undefined && (!text(source.file) || !isAbsolute(source.file))) ||
		!Array.isArray(record.chain) || record.chain.length > 16) {
		throw new Error("Invalid handoff package");
	}
	for (const value of record.chain) {
		const link = object(value);
		if (!text(link.id) || (link.name !== undefined && !text(link.name))) throw new Error("Invalid handoff chain");
	}
	return raw as unknown as Envelope;
}

/** chmod does not enforce privacy on Windows: install a current-user-only DACL. */
async function secureDirectory(path: string): Promise<void> {
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Handoff directory must not be a link");
	if (process.platform !== "win32") {
		if (stat.uid !== process.getuid?.()) throw new Error("Handoff directory has a different owner");
		await chmod(path, 0o700);
		return;
	}
	const literal = `'${path.replaceAll("'", "''")}'`;
	const script = `$ErrorActionPreference='Stop';
$path=${literal};
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object System.Security.AccessControl.DirectorySecurity;
$acl.SetOwner($sid);
$acl.SetAccessRuleProtection($true,$false);
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
$acl.AddAccessRule($rule);
# Use .NET directly: PowerShell 7's inherited PSModulePath can break PS 5.1 Set-Acl.
[System.IO.Directory]::SetAccessControl($path,$acl);
$actual=[System.IO.Directory]::GetAccessControl($path);
$rules=$actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]);
if (!$actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'Handoff directory ACL verification failed' }`;
	await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
		windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
	});
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
	const file = await open(path, "wx", 0o600);
	try { await file.writeFile(JSON.stringify(value), "utf8"); }
	finally { await file.close(); }
}

async function readJson(path: string): Promise<unknown> {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PACKAGE_BYTES || before.nlink !== 1) {
		throw new Error("Unsafe handoff file");
	}
	const file = await open(path, "r");
	try {
		const stat = await file.stat();
		if (stat.ino !== before.ino || stat.dev !== before.dev ||
			(process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
			throw new Error("Unsafe handoff file permissions");
		}
		const contents = await file.readFile("utf8");
		try { return JSON.parse(contents) as unknown; }
		catch (error) { throw new Error("Invalid handoff JSON", { cause: error }); }
	} finally { await file.close(); }
}

export class HandoffPackage {
	readonly id: string;
	readonly directory: string;
	readonly expiresAt: number;

	constructor(id: string, directory: string, expiresAt: number) {
		this.id = id;
		this.directory = directory;
		this.expiresAt = expiresAt;
	}

	async bind(paneId: string): Promise<void> {
		await writeExclusive(join(this.directory, "destination.json"), { paneId });
	}

	async assertActive(): Promise<void> {
		if (Date.now() >= this.expiresAt) throw new Error("Handoff initialization expired");
		try {
			await lstat(join(this.directory, "cancelled"));
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
			// Removal of the package also revokes a target that has already read it.
			await lstat(join(this.directory, "package.json"));
			return;
		}
		throw new Error("Handoff initialization was cancelled");
	}

	async acknowledge(result: Omit<Extract<HandoffReceipt, { status: "ready" }>, "version" | "id"> | { status: "failed" }): Promise<void> {
		// Rename makes the receipt visible in full, never as partially written JSON.
		const temporary = join(this.directory, `receipt-${randomBytes(8).toString("hex")}.tmp`);
		await writeExclusive(temporary, { version: 1, id: this.id, ...result });
		await rename(temporary, join(this.directory, "receipt.json"));
	}

	async receipt(): Promise<HandoffReceipt | undefined> {
		let value: unknown;
		try { value = await readJson(join(this.directory, "receipt.json")); }
		catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
		const raw = object(value);
		if (raw.version !== 1 || raw.id !== this.id ||
			(raw.status !== "failed" && (raw.status !== "ready" || !text(raw.paneId) || !text(raw.sessionId) ||
				(raw.sessionFile !== undefined && (!text(raw.sessionFile) || !isAbsolute(raw.sessionFile)))))) {
			throw new Error("Invalid handoff receipt");
		}
		return raw as unknown as HandoffReceipt;
	}

	async waitForReceipt(paneId: string, signal: AbortSignal): Promise<Extract<HandoffReceipt, { status: "ready" }>> {
		while (true) {
			signal.throwIfAborted();
			await this.assertActive();
			const receipt = await this.receipt();
			if (receipt?.status === "failed") throw new Error("Target Pi initialization failed; inspect the new pane");
			if (receipt?.status === "ready") {
				if (receipt.paneId !== paneId) throw new Error("Handoff receipt came from a different pane");
				return receipt;
			}
			await delay(Math.min(100, Math.max(1, this.expiresAt - Date.now())), undefined, { signal });
		}
	}

	async cancel(): Promise<void> {
		try { await writeExclusive(join(this.directory, "cancelled"), true); }
		catch (error) { if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOENT")) throw error; }
	}

	/** Caller must already have the reviewed draft in an editor (or a ready receipt). */
	async dispose(): Promise<void> {
		await this.cancel();
		await rm(this.directory, { recursive: true, force: true });
	}
}

export class HandoffStore {
	readonly root: string;

	constructor(root: string) {
		if (!isAbsolute(root)) throw new Error("Handoff store requires an absolute path");
		this.root = root;
	}

	async prepare(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await secureDirectory(this.root);
	}

	async prune(): Promise<void> {
		await this.prepare();
		for (const entry of await readdir(this.root, { withFileTypes: true })) {
			if (!ID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
			const directory = join(this.root, entry.name);
			const stat = await lstat(directory);
			if (!stat.isSymbolicLink() && Date.now() - stat.mtimeMs > RETENTION_MS) {
				await rm(directory, { recursive: true });
			}
		}
	}

	async create(payload: HandoffPayload, ttlMs = INITIALIZATION_TIMEOUT_MS): Promise<HandoffPackage> {
		await this.prune();
		const id = randomBytes(32).toString("hex");
		const createdAt = Date.now();
		const envelope = validateEnvelope({ ...payload, version: 1, id, createdAt, expiresAt: createdAt + ttlMs }, id);
		if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_PACKAGE_BYTES) throw new Error("Handoff package exceeds 4 MiB");
		const directory = join(this.root, id);
		await mkdir(directory, { mode: 0o700 });
		try { await writeExclusive(join(directory, "package.json"), envelope); }
		catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
		return new HandoffPackage(id, directory, envelope.expiresAt);
	}

	async claim(id: string, cwd: string, paneId: string): Promise<{ ticket: HandoffPackage; payload: HandoffPayload }> {
		if (!ID_PATTERN.test(id)) throw new Error("Invalid handoff ID");
		await this.prepare();
		const directory = join(this.root, id);
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe handoff directory");
		try { await writeExclusive(join(directory, "claimed"), true); }
		catch (error) {
			if (hasCode(error, "EEXIST")) throw new Error("Handoff package was already claimed; it cannot be consumed twice");
			throw error;
		}
		let ticket = new HandoffPackage(id, directory, 0);
		try {
			const payload = validateEnvelope(await readJson(join(directory, "package.json")), id);
			ticket = new HandoffPackage(id, directory, payload.expiresAt);
			await ticket.assertActive();
			const destination = object(await readJson(join(directory, "destination.json")));
			if (destination.paneId !== paneId) throw new Error("Handoff package belongs to a different pane");
			if (await realpath(payload.cwd) !== await realpath(cwd)) throw new Error("Handoff working directory does not match target Pi");
			return { ticket, payload };
		} catch (error) {
			await ticket.acknowledge({ status: "failed" });
			throw error;
		}
	}
}
