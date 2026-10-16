/** Destination flags are parsed only before the goal; -- ends option parsing. */
export type HandoffDestination = "tab" | "right" | "down" | "here";

export const HANDOFF_USAGE = "Usage: /handoff [--tab | --split right|down | --here] [--] <goal>";

export function parseHandoffArgs(args: string): { destination: HandoffDestination; goal: string } {
	let rest = args.trim();
	let destination: HandoffDestination = "tab";
	let selected = false;
	while (rest.startsWith("--")) {
		const match = /^(\S+)(?:\s+|$)/.exec(rest)!;
		const flag = match[1];
		rest = rest.slice(match[0].length).trimStart();
		if (flag === "--") break;
		if (selected) throw new Error(`Choose only one handoff destination. ${HANDOFF_USAGE}`);
		if (flag === "--tab") destination = "tab";
		else if (flag === "--here") destination = "here";
		else if (flag === "--split") {
			const direction = /^(right|down)(?:\s+|$)/.exec(rest);
			if (!direction) throw new Error(HANDOFF_USAGE);
			destination = direction[1] as "right" | "down";
			rest = rest.slice(direction[0].length).trimStart();
		} else throw new Error(`Unknown option: ${flag}. ${HANDOFF_USAGE}`);
		selected = true;
	}
	const goal = rest.trim();
	if (!goal) throw new Error(HANDOFF_USAGE);
	return { destination, goal };
}
