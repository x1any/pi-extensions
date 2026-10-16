/** Source-side orchestration; the caller keeps an editor backup throughout. */
import type { HandoffDestination } from "./options.ts";
import { HandoffStore, type HandoffPayload } from "./bundle.ts";
import { HerdrClient, type HerdrTarget } from "./herdr.ts";

export async function deliverHandoff(options: {
	payload: HandoffPayload;
	destination: Exclude<HandoffDestination, "here">;
	store: HandoffStore;
	herdr: HerdrClient;
	extension: string;
	signal: AbortSignal;
	/** False after source shutdown: retain the revoked private package for recovery. */
	hasDraftBackup: () => boolean;
}): Promise<HerdrTarget> {
	options.signal.throwIfAborted();
	const ticket = await options.store.create(options.payload);
	let target: HerdrTarget | undefined;
	try {
		options.signal.throwIfAborted();
		target = await options.herdr.create(options.destination, options.payload.cwd, ticket.id, options.signal);
		await ticket.bind(target.paneId);
		await options.herdr.start(target, ticket.id, options.store.root, options.extension, options.signal);
		const receipt = await ticket.waitForReceipt(target.paneId, options.signal);
		options.signal.throwIfAborted();
		// The target owns its draft now. Remove sensitive transport data before focus.
		await ticket.dispose();
		await options.herdr.focus(target, options.signal, receipt);
		return target;
	} catch (error) {
		const failures: unknown[] = [error];
		try {
			await ticket.cancel();
			if (options.hasDraftBackup()) await ticket.dispose();
		} catch (cleanupError) { failures.push(cleanupError); }
		const location = target ? ` Destination pane: ${target.paneId} (left open for inspection).` : " Layout creation may have taken effect; inspect herdr.";
		const recovery = options.hasDraftBackup() ? " Reviewed draft retained in the source editor." : ` Revoked package retained for recovery: ${ticket.directory}`;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${detail}${location}${recovery}${failures.length > 1 ? " Package cleanup also failed; inspect the private store." : ""}`, {
			cause: failures.length > 1 ? new AggregateError(failures) : error,
		});
	}
}
