/**
 * Handoff provenance record: session naming, lineage metadata, and the chat card.
 *
 * The /handoff command stores one small record per new session as a custom
 * entry (never part of LLM context) and renders it through an entry renderer.
 * Kept separate from command.ts so the naming, chain, and card rules can be
 * verified without running the command.
 */

import type {
	CustomEntry,
	EntryRenderOptions,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, sliceByColumn, Text, visibleWidth } from "@earendil-works/pi-tui";

/** Custom session entry type used to store handoff provenance. */
export const HANDOFF_ENTRY_TYPE = "pi-handoff";

/** Lineage metadata stays small; links older than this many are dropped. */
export const MAX_HANDOFF_CHAIN_LENGTH = 16;

/** Session names show up in the footer and selector, so keep them short. */
export const MAX_SESSION_NAME_COLUMNS = 48;

/** Collapsed cards keep the goal on one line; expansion reveals it in full. */
const COLLAPSED_GOAL_COLUMNS = 72;

/** Fallback session name when the goal has no usable text. */
const FALLBACK_SESSION_NAME = "交接会话";

/** A session in the handoff lineage. */
export interface HandoffLink {
	/** Session ID. */
	id: string;
	/** Session display name at handoff time, when it had one. */
	name?: string;
}

/** Data stored in the handoff custom entry. */
export interface HandoffRecordData {
	/** Goal passed to /handoff. */
	goal: string;
	/** Direct source session. */
	source: HandoffLink & { file?: string };
	/** Lineage ending with the direct source; never includes the current session. */
	chain: HandoffLink[];
	/** Epoch milliseconds when the handoff session was created. */
	createdAt: number;
}

/** One card line; the renderer owns colors, this module owns content. */
export type HandoffCardLine =
	| { kind: "headline"; text: string }
	| { kind: "labeled"; label: string; text: string };

/** Collapse to one line and drop control characters that could disturb rendering. */
function singleLine(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/**
 * Truncate plain text by display columns. Unlike pi-tui's truncateToWidth this
 * never injects ANSI resets, so the result is safe to persist as a session name.
 */
function truncatePlain(text: string, maxColumns: number, ellipsis = "…"): string {
	if (maxColumns <= 0) return "";
	if (visibleWidth(text) <= maxColumns) return text;
	const budget = Math.max(0, maxColumns - visibleWidth(ellipsis));
	return `${sliceByColumn(text, 0, budget, true)}${ellipsis}`;
}

/** Derive a predictable session name from the handoff goal. */
export function deriveSessionName(goal: string): string {
	const name = truncatePlain(singleLine(goal), MAX_SESSION_NAME_COLUMNS);
	return name || FALLBACK_SESSION_NAME;
}

/** Display label for a session, falling back to a short ID when unnamed. */
export function sessionLabel(link: HandoffLink): string {
	const name = link.name?.trim();
	if (name) return name;
	return link.id.slice(0, 8) || "未命名会话";
}

function normalizeLink(value: unknown): HandoffLink | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as { id?: unknown; name?: unknown };
	if (typeof raw.id !== "string" || !raw.id) return undefined;
	const name = typeof raw.name === "string" ? singleLine(raw.name) : "";
	return name ? { id: raw.id, name } : { id: raw.id };
}

/** Validate stored lineage; keeps the most recent links and drops duplicate IDs. */
export function normalizeHandoffChain(value: unknown): HandoffLink[] {
	if (!Array.isArray(value)) return [];
	const links: HandoffLink[] = [];
	const seen = new Set<string>();
	for (let index = value.length - 1; index >= 0; index--) {
		const link = normalizeLink(value[index]);
		if (!link || seen.has(link.id)) continue;
		links.push(link);
		seen.add(link.id);
	}
	return links.reverse().slice(-MAX_HANDOFF_CHAIN_LENGTH);
}

/**
 * Lineage recorded by the newest handoff entry on the given branch.
 * Callers pass the active branch, so abandoned branches stay out of the chain.
 */
export function readHandoffChain(entries: readonly SessionEntry[]): HandoffLink[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== HANDOFF_ENTRY_TYPE) continue;
		return normalizeHandoffChain((entry.data as { chain?: unknown } | undefined)?.chain);
	}
	return [];
}

/** Build the record stored in the new session. */
export function buildHandoffRecord(options: {
	goal: string;
	source: { id: string; name?: string; file?: string };
	inheritedChain: readonly HandoffLink[];
	createdAt?: number;
}): HandoffRecordData {
	const source: HandoffRecordData["source"] = { id: options.source.id };
	if (options.source.name) source.name = options.source.name;
	if (options.source.file) source.file = options.source.file;
	return {
		goal: options.goal,
		source,
		chain: normalizeHandoffChain([...options.inheritedChain, source]),
		createdAt: options.createdAt ?? Date.now(),
	};
}

/** Tolerate missing or malformed data so an old entry still renders. */
function renderableRecord(value: unknown): HandoffRecordData {
	const raw = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	const sourceRaw =
		typeof raw.source === "object" && raw.source !== null
			? (raw.source as Record<string, unknown>)
			: {};
	const source = normalizeLink(sourceRaw) ?? { id: "未知会话" };
	const file = typeof sourceRaw.file === "string" && sourceRaw.file ? sourceRaw.file : undefined;
	return {
		goal: typeof raw.goal === "string" ? raw.goal : "",
		source: file ? { ...source, file } : source,
		chain: normalizeHandoffChain(raw.chain),
		createdAt:
			typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
	};
}

function formatTimestamp(createdAt: number): string {
	return createdAt > 0 ? new Date(createdAt).toLocaleString() : "未知";
}

/** Lines shown in the handoff card; expansion adds the provenance details. */
export function handoffCardLines(
	data: HandoffRecordData,
	expanded: boolean,
): HandoffCardLine[] {
	const goal = singleLine(data.goal) || "（未记录目标）";
	const lines: HandoffCardLine[] = [
		{
			kind: "headline",
			text: expanded ? goal : truncatePlain(goal, COLLAPSED_GOAL_COLUMNS),
		},
		{ kind: "labeled", label: "来自", text: sessionLabel(data.source) },
	];
	if (!expanded) return lines;

	if (data.chain.length > 1) {
		const lineage = [...data.chain.map(sessionLabel), "当前会话"].join(" → ");
		lines.push({ kind: "labeled", label: "交接链", text: lineage });
	}
	lines.push({
		kind: "labeled",
		label: "直接来源",
		text: data.source.file ?? "（内存会话，未持久化为文件）",
	});
	lines.push({ kind: "labeled", label: "交接时间", text: formatTimestamp(data.createdAt) });
	lines.push({ kind: "labeled", label: "操作", text: "已填入交接草稿，未自动发送" });
	return lines;
}

/** Render the handoff provenance card in the interactive transcript. */
export function renderHandoffCard(
	entry: CustomEntry<HandoffRecordData>,
	options: EntryRenderOptions,
	theme: Theme,
): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	for (const line of handoffCardLines(renderableRecord(entry.data), options.expanded)) {
		if (line.kind === "headline") {
			const label = theme.fg("customMessageLabel", theme.bold("[交接]"));
			box.addChild(new Text(`${label} ${theme.fg("customMessageText", line.text)}`, 0, 0));
		} else {
			const label = theme.fg("dim", `${line.label}：`);
			box.addChild(new Text(`${label}${theme.fg("customMessageText", line.text)}`, 0, 0));
		}
	}
	return box;
}
