import { visibleWidth } from "@nanopi/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import type { SweepState } from "../src/modules/pi-ui/src/shimmer.ts";
import {
	captureTerminalWidth,
	statusRowRenderer,
	syncPlanFromToolResult,
	workingMessage,
} from "../src/modules/pi-ui/src/working.ts";
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

	test("shimmers the retry status row with the same band as working", () => {
		const ansiTheme = {
			getFgAnsi: (color: string) => (color === "accent" ? "\x1b[35m" : "\x1b[90m"),
			fg: (_color: string, text: string) => text,
		} as unknown as Theme;
		const message = "Retrying (1/3) in 2s... (esc to cancel)";
		const base = {
			dtMs: 50,
			message,
			placement: "statusRow",
			columns: 0,
			kind: "retry",
		} as const;

		const first = statusRowRenderer({ ...base, elapsedMs: 0 }, ansiTheme)!;
		expect(stripAnsi(first.text)).toBe(message);

		// The band starts off the left edge; it reaches the text after a few
		// frames, so compare later frames for the accent crest and movement.
		let crest = first.text;
		for (let i = 0; i < 6; i++) {
			crest = statusRowRenderer({ ...base, elapsedMs: (i + 1) * 100 }, ansiTheme)!.text;
			if (crest.includes("\x1b[35m")) break;
		}
		expect(crest).toContain("\x1b[35m");
		expect(crest).not.toBe(first.text);

		// The working row keeps its own renderer, so one registration does not
		// replace the other.
		expect(statusRowRenderer({ ...base, elapsedMs: 0, kind: "working" }, ansiTheme)).toBeUndefined();
	});

	test("keeps a short step intact on a narrow terminal", () => {
		setPlan([{ text: "Read AGENTS.md", status: "in_progress" }]);
		captureTerminalWidth(80);
		expect(row()).toContain("0/1 Read AGENTS.md");
	});
});
