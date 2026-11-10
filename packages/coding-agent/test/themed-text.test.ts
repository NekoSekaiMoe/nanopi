import { afterEach, describe, expect, it } from "vitest";
import { ThemedText } from "../src/modes/interactive/components/themed-text.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => {
	initTheme();
});

describe("ThemedText", () => {
	it("builds lazily, rebuilds on a new theme instance, and again after invalidation", () => {
		initTheme();
		let builds = 0;
		const text = new ThemedText(() => {
			builds++;
			return theme.fg("accent", "hello");
		});
		expect(builds).toBe(0);
		const dark = text.render(20).join("");
		expect(builds).toBe(1);

		// A theme change installs a new instance. The regenerated theme can resolve
		// to the same escape sequences, so the identity is what triggers the
		// rebuild rather than the string it produces.
		initTheme();
		expect(text.render(20).join("")).toBe(dark);
		expect(builds).toBe(2);

		text.invalidate();
		expect(text.render(20).join("")).toContain(theme.getFgAnsi("accent"));
		expect(builds).toBe(3);
	});

	it("rebuilds after setBuild even when the theme is unchanged", () => {
		initTheme();
		let label = "first";
		const text = new ThemedText(() => theme.fg("accent", label));
		expect(text.render(30).join("")).toContain("first");

		label = "second";
		text.setBuild(() => theme.fg("accent", label));
		expect(text.render(30).join("")).toContain("second");
	});
});
