import { afterEach, describe, expect, it } from "vitest";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => {
	initTheme();
});

describe("ThemedText", () => {
	it("builds lazily and rebuilds with the current theme after invalidation", () => {
		initTheme();
		let builds = 0;
		const text = new ThemedText(() => {
			builds++;
			return theme.fg("accent", "hello");
		});
		expect(builds).toBe(0);
		const dark = text.render(20).join("");

		initTheme();
		expect(text.render(20).join("")).toBe(dark);
		text.invalidate();
		expect(text.render(20).join("")).toContain(theme.getFgAnsi("accent"));
		expect(builds).toBe(2);
	});
});
