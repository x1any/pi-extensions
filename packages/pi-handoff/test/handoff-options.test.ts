import assert from "node:assert/strict";
import test from "node:test";
import { parseHandoffArgs } from "../src/options.ts";

test("default tab, explicit tab/here and both split directions", () => {
	assert.deepEqual(parseHandoffArgs("  继续工作  "), { destination: "tab", goal: "继续工作" });
	assert.deepEqual(parseHandoffArgs("--tab 继续"), { destination: "tab", goal: "继续" });
	assert.deepEqual(parseHandoffArgs("--here 继续"), { destination: "here", goal: "继续" });
	for (const direction of ["right", "down"]) {
		assert.deepEqual(parseHandoffArgs(`--split ${direction} 多行\n目标`), { destination: direction, goal: "多行\n目标" });
	}
});

test("reject ambiguous/unknown flags and missing goals; -- preserves a literal goal", () => {
	for (const input of ["", "--tab", "--split goal", "--split left goal", "--here --tab goal", "--oops goal"]) {
		assert.throws(() => parseHandoffArgs(input));
	}
	assert.deepEqual(parseHandoffArgs("--here -- --tab as a goal"), { destination: "here", goal: "--tab as a goal" });
	assert.equal(parseHandoffArgs("goal --here").destination, "tab");
});
