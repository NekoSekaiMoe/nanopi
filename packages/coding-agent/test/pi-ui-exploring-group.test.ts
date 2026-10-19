import { describe, expect, test } from "vitest";
import { exploringHeader, exploringRows } from "../src/extras/pi-ui/src/subagent-widget.ts";
import { exploreCallFor, exploringCalls } from "../src/extras/pi-ui/src/tools.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** Plain theme: no ANSI wrapping, so the output is the visible text. */
const theme = {
	getFgAnsi: () => "",
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

describe("pi-ui exploring group", () => {
	test("header reads Exploring while open, Explored once settled", () => {
		expect(stripAnsi(exploringHeader(theme, true))).toBe("• Exploring");
		expect(stripAnsi(exploringHeader(theme, false))).toBe("• Explored");
	});

	test("renders nothing without actions, so no empty group is left behind", () => {
		expect(exploringRows([], theme, 80)).toEqual([]);
	});

	test("groups consecutive reads and mirrors Codex's action vocabulary", () => {
		const rows = exploringRows(
			[
				exploreCallFor("read", "AGENTS.md"),
				exploreCallFor("read", "README.md"),
				exploreCallFor("grep", "spawnJob in src"),
				exploreCallFor("ls", "packages"),
			],
			theme,
			80,
		).map(stripAnsi);
		expect(rows).toEqual([
			"• Exploring",
			"  └ Read AGENTS.md, README.md",
			"    Search spawnJob in src",
			"    List packages",
		]);
	});

	test("a subagent contributes the tool calls its child made", () => {
		const calls = exploringCalls(
			{
				content: [],
				details: {
					results: [
						{
							messages: [
								{
									content: [
										{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
										{ type: "toolCall", name: "grep", arguments: { pattern: "spawn" } },
									],
								},
							],
						},
					],
				},
			} as never,
			false,
		);
		expect(calls).toEqual([
			{ action: "Read", detail: "src/index.ts" },
			{ action: "Search", detail: "spawn" },
		]);
	});
});
