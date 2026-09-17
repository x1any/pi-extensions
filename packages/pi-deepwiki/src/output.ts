import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export interface BoundedOutput {
	text: string;
	truncated: boolean;
	outputBytes: number;
	outputLines: number;
	totalBytes: number;
	totalLines: number;
	fullOutputPath?: string;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function safeFilePart(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
	return safe || "output";
}

export class DeepWikiOutputStore {
	private directoryPromise?: Promise<string>;

	private directory(): Promise<string> {
		if (!this.directoryPromise) {
			const creating = mkdtemp(join(tmpdir(), "pi-deepwiki-"));
			this.directoryPromise = creating;
			creating.catch(() => {
				if (this.directoryPromise === creating) this.directoryPromise = undefined;
			});
		}
		return this.directoryPromise;
	}

	async bound(text: string, fileHint: string, signal?: AbortSignal): Promise<BoundedOutput> {
		const truncation = truncateHead(text, {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		if (!truncation.truncated) {
			return {
				text,
				truncated: false,
				outputBytes: truncation.outputBytes,
				outputLines: truncation.outputLines,
				totalBytes: truncation.totalBytes,
				totalLines: truncation.totalLines,
			};
		}

		let fullOutputPath: string | undefined;
		let saveError: string | undefined;
		try {
			if (signal?.aborted) throw signal.reason ?? new Error("请求已取消");
			const directory = await this.directory();
			fullOutputPath = join(directory, `${safeFilePart(fileHint)}-${randomUUID()}.md`);
			await withFileMutationQueue(fullOutputPath, () => writeFile(fullOutputPath!, text, { encoding: "utf8", signal }));
		} catch (error) {
			if (signal?.aborted) throw error;
			fullOutputPath = undefined;
			saveError = errorMessage(error);
		}

		const omittedLines = truncation.totalLines - truncation.outputLines;
		const omittedBytes = truncation.totalBytes - truncation.outputBytes;
		const notice = [
			`[DeepWiki 输出已截断：显示 ${truncation.outputLines}/${truncation.totalLines} 行（${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}），省略 ${omittedLines} 行（${formatSize(omittedBytes)}）。`,
			fullOutputPath ? `完整输出：${fullOutputPath}]` : `完整输出保存失败：${saveError ?? "未知错误"}]`,
		].join(" ");

		return {
			text: `${truncation.content}\n\n${notice}`,
			truncated: true,
			outputBytes: truncation.outputBytes,
			outputLines: truncation.outputLines,
			totalBytes: truncation.totalBytes,
			totalLines: truncation.totalLines,
			fullOutputPath,
		};
	}

	async cleanup(): Promise<void> {
		const directoryPromise = this.directoryPromise;
		this.directoryPromise = undefined;
		if (!directoryPromise) return;
		const directory = await directoryPromise.catch(() => undefined);
		if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}
