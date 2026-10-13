import { colorToHex, okhslColor, styleText, type TerminalColorMode } from "@nanopi/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { setTerminalColors, Theme, type ThemeBg, type ThemeColor } from "../src/modes/interactive/theme/theme.ts";
import type { ThemeColorValues } from "../src/modes/interactive/theme/theme-tokens.ts";

type TokenValues = Partial<Record<ThemeColor | ThemeBg, string | number>>;

/** Build a theme from raw token values, split into slots like theme creation does. */
function makeTheme(colors: TokenValues, mode: TerminalColorMode = "truecolor", appearance?: "dark" | "light"): Theme {
	const fgColors = {} as Partial<Record<ThemeColor, string | number>>;
	const bgColors = {} as Partial<Record<ThemeBg, string | number>>;
	for (const [token, value] of Object.entries(colors)) {
		if (token.endsWith("Bg")) {
			bgColors[token as ThemeBg] = value;
		} else {
			fgColors[token as ThemeColor] = value;
		}
	}
	return new Theme(
		fgColors as Pick<ThemeColorValues<string | number>, ThemeColor>,
		bgColors as Pick<ThemeColorValues<string | number>, ThemeBg>,
		mode,
		{ name: "test", appearance },
	);
}

const DARK_BASE: TokenValues = {
	text: "#e5e5e7",
	success: "#22c55e",
	error: "#ef4444",
	accent: "#3b82f6",
	thinkingXhigh: "#a78bfa",
	userMessageBg: "#1e1e2e",
	toolSuccessBg: "#052e16",
};

afterEach(() => {
	setTerminalColors({});
});

describe("theme styles", () => {
	it("renders theme tokens the same as the generic text styler", () => {
		const theme = makeTheme(DARK_BASE);
		expect(theme.style("Ready", { fg: "success", bg: "toolSuccessBg", bold: true })).toBe(
			styleText("Ready", { fg: theme.colors.success, bg: theme.colors.toolSuccessBg, bold: true }, "truecolor"),
		);
	});

	it("rejects unknown tokens and tokens in the wrong slot", () => {
		const theme = makeTheme(DARK_BASE);
		expect(() => theme.style("x", { fg: "notAToken" as never })).toThrow("Unknown theme color: notAToken");
		// @ts-expect-error background tokens are not foreground colors; use theme.colors.userMessageBg
		expect(() => theme.style("x", { fg: "userMessageBg" })).toThrow("Unknown theme color: userMessageBg");
	});

	it("loads OKLCH theme values", () => {
		const theme = makeTheme({ ...DARK_BASE, accent: "oklch(62% 0.1 200)" });
		expect(theme.colors.accent).toEqual({ kind: "oklch", l: 0.62, c: 0.1, h: 200 });
	});

	it("loads OKHSL theme values", () => {
		const theme = makeTheme({ ...DARK_BASE, accent: "okhsl(250 60% 55%)", error: "okhsl(20 90% 60%)" });
		expect(colorToHex(theme.colors.accent)).toBe(colorToHex(okhslColor(250, 0.6, 0.55)));
		expect(colorToHex(theme.colors.error)).toBe(colorToHex(okhslColor(20, 0.9, 0.6)));
	});

	it("detects the appearance unless it is declared", () => {
		expect(makeTheme(DARK_BASE).appearance).toBe("dark");
		expect(makeTheme({ ...DARK_BASE, userMessageBg: "#f5f5f5", toolSuccessBg: "#ecfdf5" }).appearance).toBe("light");
		expect(makeTheme(DARK_BASE, "truecolor", "light").appearance).toBe("light");

		// Palette colors 0-15 follow the terminal palette, so such themes follow the terminal background.
		const paletteOnly = makeTheme(
			Object.fromEntries(Object.keys(DARK_BASE).map((key) => [key, key.endsWith("Bg") ? 0 : 7])),
		);
		expect(paletteOnly.appearance).toBe("dark");
		setTerminalColors({ background: { r: 250, g: 250, b: 250 } });
		expect(paletteOnly.appearance).toBe("light");
	});

	it("renders empty tokens as terminal defaults and reports concrete colors for them", () => {
		const theme = makeTheme({ ...DARK_BASE, text: "", userMessageBg: "" });
		expect(theme.fg("text", "x")).toBe("\x1b[39mx\x1b[39m");
		expect(theme.bg("userMessageBg", "x")).toBe("\x1b[49mx\x1b[49m");
		expect(colorToHex(theme.colors.text)).toBe("#e5e5e7");
		expect(colorToHex(theme.colors.userMessageBg)).toBe("#000000");

		setTerminalColors({ foreground: { r: 200, g: 210, b: 220 }, background: { r: 10, g: 20, b: 30 } });
		expect(colorToHex(theme.colors.text)).toBe("#c8d2dc");
		expect(colorToHex(theme.colors.userMessageBg)).toBe("#0a141e");
	});
});
