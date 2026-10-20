import { setKeybindings, type TUI } from "@nanopi/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { listRowBudget } from "../src/modes/interactive/components/list-window.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(rows: number): TUI {
	return { requestRender: () => {}, terminal: { rows, columns: 120 } } as unknown as TUI;
}

describe("list row budget", () => {
	it("keeps the preferred height when the terminal is tall", () => {
		expect(listRowBudget({ terminalRows: 40, chromeRows: 10, preferredRows: 10 })).toBe(10);
	});

	it("shrinks to fit a short terminal", () => {
		expect(listRowBudget({ terminalRows: 16, chromeRows: 10, preferredRows: 10 })).toBe(6);
	});

	it("never drops below the minimum", () => {
		expect(listRowBudget({ terminalRows: 5, chromeRows: 10, preferredRows: 10 })).toBe(3);
		expect(listRowBudget({ terminalRows: 5, chromeRows: 10, preferredRows: 10, minRows: 1 })).toBe(1);
	});
});

describe("model selector rows follow the terminal height", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders fewer model rows on a short terminal", async () => {
		harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({
				id: `model-${index}`,
				name: `Model ${index}`,
				reasoning: true,
			})),
		});
		const countModelRows = (rows: number): number => {
			const selector = new ModelSelectorComponent(
				createFakeTui(rows),
				harness!.getModel("model-0")!,
				harness!.session.modelRuntime,
				[],
				() => {},
				() => {},
			);
			const count = stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.filter((line) => /model-\d+ \[/.test(line)).length;
			selector.dispose();
			return count;
		};

		expect(countModelRows(40)).toBe(10);
		expect(countModelRows(16)).toBeLessThan(10);
		expect(countModelRows(16)).toBeGreaterThan(0);
	});
});
