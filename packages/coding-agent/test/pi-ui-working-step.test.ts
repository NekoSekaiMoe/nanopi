import { visibleWidth } from "@nanopi/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import type { SweepState } from "../src/extras/pi-ui/src/shimmer.ts";
import { captureTerminalWidth, syncPlanFromToolResult, workingMessage } from "../src/extras/pi-ui/src/working.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** Plain theme: no ANSI wrapping, so the shimmer output is the visible text. */
const theme = {
	getFgAnsi: () => "",
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const sweep: SweepState = { phase: 0, canvas: 0 };

function setPlan(steps: { text: string; status: string }[]): void {
	syncPlanFromToolResult({ toolName: "todo", details: { todos: steps } });
}

function row(elapsedMs = 0): string {
	return stripAnsi(workingMessage(theme, elapsedMs, sweep, 0));
}

describe("pi-ui working row", () => {
	beforeEach(() => {
		captureTerminalWidth(0);
		setPlan([]);
	});

	test("falls back to the plain label without a plan", () => {
		expect(row()).toBe("Working (0s · esc to interrupt)");
	});

	test("shows the current plan step", () => {
		setPlan([
			{ text: "Read AGENTS.md", status: "completed" },
			{ text: "Fix the welcome tip", status: "in_progress" },
		]);
		expect(row()).toContain("1/2 Fix the welcome tip");
	});

	test("folds a long step with a trailing marker instead of cutting the word", () => {
		const step = "Implement the working row folding so long steps keep their tail";
		setPlan([{ text: step, status: "in_progress" }]);
		const text = row();
		expect(text).toContain("(working …)");
		expect(text).not.toMatch(/\w…/);
		expect(text.endsWith("(0s · esc to interrupt)")).toBe(true);
	});

	test("folds the step to the terminal width", () => {
		const step = "Implement the working row folding so long steps keep their tail";
		setPlan([{ text: step, status: "in_progress" }]);
		for (const columns of [120, 80, 60]) {
			captureTerminalWidth(columns);
			// The row lives in the editor border, so it must fit one line.
			expect(visibleWidth(row(90_000))).toBeLessThan(columns);
		}
	});

	test("keeps a short step intact on a narrow terminal", () => {
		setPlan([{ text: "Read AGENTS.md", status: "in_progress" }]);
		captureTerminalWidth(80);
		expect(row()).toContain("0/1 Read AGENTS.md");
	});
});
