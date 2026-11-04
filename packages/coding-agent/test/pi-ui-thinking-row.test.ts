import { describe, expect, test } from "vitest";
import type { AssistantMessageRenderContext } from "../src/core/modules/types.ts";
import { installThinkingDisplay } from "../src/extras/pi-ui/src/thinking.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * A theme that answers calls with a marker instead of ANSI, so the rendered
 * row shows which theme instance the renderer actually used.
 */
function markedTheme(marker: string): Theme {
	return {
		fg: (_color: string, text: string) => `${marker}${text}`,
		bold: (text: string) => text,
		italic: (text: string) => text,
	} as unknown as Theme;
}

/** Minimal stand-in for the host's render context. */
function makeContext(theme: Theme): AssistantMessageRenderContext & { children: unknown[] } {
	const children: unknown[] = [];
	return {
		isStreaming: false,
		outputPad: 0,
		markdownTheme: {} as AssistantMessageRenderContext["markdownTheme"],
		theme,
		addChild: (child) => {
			children.push(child);
		},
		renderText: () => {},
		renderStopReason: () => {},
		transform: (_type, markdown) => markdown,
		children,
	};
}

/**
 * The pi-ui thinking renderer must style through `context.theme`, not the
 * process-global theme: the global is only reachable via `globalThis` in
 * restored sessions, and reading it left the module unable to follow a theme
 * switch. Regression for #457 item 2.
 */
describe("pi-ui thinking row theme", () => {
	test("rows use the theme handed in by the render context", () => {
		let renderer: ((message: never, context: AssistantMessageRenderContext) => boolean) | undefined;
		const pi = {
			registerAssistantMessageRenderer: (fn: typeof renderer) => {
				renderer = fn;
			},
			registerShortcut: () => {},
			unregisterSettingsItem: () => {},
			on: () => {},
		};
		installThinkingDisplay(pi as never);
		expect(renderer).toBeTypeOf("function");

		const context = makeContext(markedTheme("«T»"));
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "first line\nsecond line" },
				{ type: "text", text: "answer" },
			],
		} as never;

		expect(renderer!(message, context)).toBe(true);
		const lines = context.children
			.filter((child) => (child as { constructor?: { name?: string } }).constructor?.name === "ThinkingRow")
			.flatMap((row) => (row as { render(width: number): string[] }).render(80))
			.map(stripAnsi);
		// A collapsed done row: the header and the summary line both carry the
		// marker, so the row cannot have reached for a different theme.
		expect(lines.length).toBe(2);
		expect(lines.every((line) => line.includes("«T»"))).toBe(true);
	});
});
