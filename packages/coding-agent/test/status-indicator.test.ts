import { CURSOR_MARKER, renderFakeCursor, type TUI, visibleWidth } from "@nanopi/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
	WorkingStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as standalone status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("keeps the top border unchanged unless the editor opts in", () => {
		initTheme();
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create());
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		expect(stripAnsi(editor.render(20)[0]!)).toBe("─".repeat(20));
		const standaloneLine = indicator.render(20)[1]!;
		expect(standaloneLine).toContain(theme.getFgAnsi("accent"));
		expect(standaloneLine).toContain(theme.getFgAnsi("muted"));
		indicator.dispose();
	});

	it("embeds the working indicator when the editor opts in", () => {
		initTheme();
		const tui = {
			requestRender: vi.fn(),
			terminal: { rows: 10 },
		} as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		expect(editor.embedWorkingStatus).toBe(true);
		editor.borderColor = theme.getThinkingBorderColor("high");
		const indicator = new WorkingStatusIndicator(tui, "Working", undefined, (text) => editor.borderColor(text));
		editor.setWorkingStatusIndicator(indicator);

		const topBorder = editor.render(20)[0]!;
		expect(stripAnsi(topBorder)).toBe("── ⠋ Working ───────");
		expect(visibleWidth(topBorder)).toBe(20);
		expect(topBorder.split(theme.getFgAnsi("thinkingHigh"))).toHaveLength(5);
		indicator.dispose();
	});

	it("embeds a module-registered working row instead of the spinner text", () => {
		initTheme();
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
			style: "composer",
		});
		const indicator = new WorkingStatusIndicator(tui, "Working");
		const frames: { dtMs: number; elapsedMs: number }[] = [];
		indicator.setRowRenderer((state) => {
			frames.push({ dtMs: state.dtMs, elapsedMs: state.elapsedMs });
			return { text: `shimmer ${state.elapsedMs}ms` };
		});
		editor.setWorkingStatusIndicator(indicator);

		try {
			expect(stripAnsi(editor.render(40)[0]!)).toContain("shimmer ");
			// The row owns the line, so the spinner text does not leak through.
			expect(stripAnsi(editor.render(40)[0]!)).not.toContain("Working");
			// A frame carries the time since the previous one, so an animated row
			// moves with the clock instead of standing still.
			expect(frames.length).toBeGreaterThanOrEqual(2);
			expect(frames[0]!.dtMs).toBe(0);
			expect(frames[1]!.dtMs).toBeGreaterThanOrEqual(0);
		} finally {
			indicator.dispose();
		}
	});

	it("repaints while a module-registered row is installed", () => {
		initTheme();
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Working");
		indicator.setRowRenderer(() => ({ text: "shimmer" }));

		vi.advanceTimersByTime(100);
		expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(3);

		indicator.dispose();
		const afterDispose = requestRender.mock.calls.length;
		vi.advanceTimersByTime(200);
		expect(requestRender.mock.calls.length).toBe(afterDispose);
	});

	it("keeps a blank row between the embedded status and the composer input", () => {
		initTheme();
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
			style: "composer",
		});
		editor.focused = true;
		editor.setText("hi");
		editor.handleInput("\x1b[D"); // cursor over "i"
		const indicator = new WorkingStatusIndicator(tui, "Working");
		editor.setWorkingStatusIndicator(indicator);

		const click = (y: number) =>
			editor.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y,
				screenX: 4,
				screenY: y,
				width: 20,
				height: 4,
				shift: false,
				alt: false,
				ctrl: false,
			})!;

		try {
			const lines = editor.render(20);
			expect(stripAnsi(lines[0]!)).toMatch(/^ ⠋ Working/);
			expect(lines[1]).toBe(" ".repeat(20));
			expect(lines[2]!.includes(`h${CURSOR_MARKER}${renderFakeCursor("i")}`)).toBe(true);

			// Clicks on the pad row do not move the cursor onto the input line.
			expect(click(1)).toEqual({ handled: true, focus: true });
			expect(editor.render(20)[2]!.includes(`h${CURSOR_MARKER}${renderFakeCursor("i")}`)).toBe(true);

			// Clicks on the input row (below the pad row) still place the cursor.
			click(2);
			expect(editor.render(20)[2]!.includes(`hi${CURSOR_MARKER}${renderFakeCursor(" ")}`)).toBe(true);
		} finally {
			indicator.dispose();
		}
	});

	it("embeds compaction, summary, and retry labels within the border width", () => {
		initTheme();
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn(), terminal: { rows: 10 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), KeybindingsManager.create(), {
			embedWorkingStatus: true,
		});
		const indicators = [
			new CompactionStatusIndicator(tui, "manual"),
			new CompactionStatusIndicator(tui, "threshold"),
			new CompactionStatusIndicator(tui, "overflow"),
			new BranchSummaryStatusIndicator(tui),
			new RetryStatusIndicator(tui, 1, 3, 3000),
		];
		try {
			for (const indicator of indicators) {
				editor.setWorkingStatusIndicator(indicator);
				const label = stripAnsi(indicator.render(120)[1]!).trim();
				expect(stripAnsi(editor.render(120)[0]!)).toContain(`── ${label} `);
				for (const width of [1, 4, 10, 20, 80, 120]) {
					expect(visibleWidth(editor.render(width)[0]!)).toBe(width);
				}
			}
			vi.advanceTimersByTime(1000);
			expect(stripAnsi(editor.render(120)[0]!)).toContain("Retrying (1/3) in 2s");
			editor.setWorkingStatusIndicator(undefined);
			expect(stripAnsi(editor.render(120)[0]!)).toBe("─".repeat(120));
		} finally {
			for (const indicator of indicators) indicator.dispose();
		}
	});

	it("disposes retry countdown updates", () => {
		initTheme();
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
