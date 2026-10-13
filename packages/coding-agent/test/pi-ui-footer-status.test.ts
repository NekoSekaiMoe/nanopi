import { visibleWidth } from "@nanopi/pi-tui";
import { describe, expect, test } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import type { ModuleContext } from "../src/core/modules/types.ts";
import { renderStatusSuffix, renderToolbarLine } from "../src/extras/pi-ui/src/footer.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** Plain theme: no ANSI wrapping, so width math is plain text width. */
const theme = { fg: (_color: string, text: string) => text } as unknown as Parameters<typeof renderToolbarLine>[1];

function makeCtx(editorText: string): ModuleContext {
	return {
		getContextUsage: () => ({ tokens: 12_345, percent: null, contextWindow: 200_000 }),
		model: undefined,
		ui: { getEditorText: () => editorText },
	} as unknown as ModuleContext;
}

function makeFooterData(statuses: Record<string, string>): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map(Object.entries(statuses)),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

describe("pi-ui footer status toolbar", () => {
	test("plain usage line without statuses or shell mode", () => {
		const line = renderToolbarLine(makeCtx(""), theme, makeFooterData({}), 80);
		expect(line).toBe("used 12k/200k · / for more details");
	});

	test("shell mode right-aligns the shell label", () => {
		const line = renderToolbarLine(makeCtx("!ls"), theme, makeFooterData({}), 80);
		expect(line.startsWith("used 12k/200k · / for more details")).toBe(true);
		expect(line.endsWith("shell")).toBe(true);
		expect(visibleWidth(line)).toBe(80);
	});

	test("extension statuses render right-aligned next to the shell label", () => {
		const line = renderToolbarLine(makeCtx("!ls"), theme, makeFooterData({ mode: "yolo plan" }), 80);
		expect(line.endsWith("yolo plan shell")).toBe(true);
		expect(visibleWidth(line)).toBe(80);
	});

	test("usage line truncates when width cannot fit the suffix", () => {
		const line = renderToolbarLine(makeCtx("!"), theme, makeFooterData({ mode: "yolo plan" }), 30);
		expect(line.endsWith("yolo plan shell")).toBe(true);
		expect(visibleWidth(line)).toBe(30);
		expect(line).toContain("…");
	});

	test("suffix is dropped entirely when it cannot fit", () => {
		const line = renderToolbarLine(makeCtx("!"), theme, makeFooterData({ mode: "yolo plan" }), 10);
		expect(stripAnsi(line)).toBe("used 12k/…");
		expect(visibleWidth(line)).toBe(10);
		expect(line.includes("yolo")).toBe(false);
	});

	test("status suffix keeps producer-embedded ANSI color", () => {
		const colored = {
			fg: (color: string, text: string) => `\x1b[${color === "bashMode" ? 33 : 31}m${text}\x1b[0m`,
		} as unknown as typeof theme;
		const suffix = renderStatusSuffix(makeFooterData({ mode: "\x1b[31myolo\x1b[0m" }), colored, true);
		expect(stripAnsi(suffix)).toBe("yolo shell");
		expect(suffix).toContain("\x1b[31myolo\x1b[0m");
	});
});
