import type { Component, KeybindingsManager, TUI } from "@nanopi/pi-tui";
import { TUI_KEYBINDINGS, KeybindingsManager as TuiKeybindingsManager } from "@nanopi/pi-tui";
import { describe, expect, it } from "vitest";
import type { ModuleCommandContext } from "../src/index.ts";
import { initTheme } from "../src/index.ts";
import { type StatusDialogData, showStatusDialog } from "../src/modules/builtin-commands/status-dialog.ts";

initTheme();

/** PageUp/PageDown as the terminal sends them (xterm CSI 5~/6~). */
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

const dialog: StatusDialogData = {
	title: "status",
	rows: [],
	sections: [{ title: "Tools", items: Array.from({ length: 30 }, (_, index) => `tool-${index}`) }],
};

/** Drive the real dialog component the way the overlay host does. */
async function openDialog(rows: number): Promise<(input: string) => string[]> {
	let component: (Component & { dispose?(): void }) | undefined;
	const tui = { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
	const ctx = {
		ui: {
			custom: (
				factory: (
					tui: TUI,
					theme: unknown,
					keybindings: KeybindingsManager,
					done: (result: unknown) => void,
				) => Component,
			) => {
				component = factory(
					tui,
					// Only `fg(color, text)` must keep its text; other theme helpers style bare strings.
					{
						fg: (color: string, text: string) => `{${color}}${text}`,
						bold: (text: string) => text,
						bg: (_color: string, text: string) => text,
					},
					new TuiKeybindingsManager(TUI_KEYBINDINGS),
					() => {},
				);
				return Promise.resolve();
			},
		},
	} as unknown as Pick<ModuleCommandContext, "ui">;

	await showStatusDialog(ctx, dialog);
	const opened = component;
	if (!opened) throw new Error("dialog did not open");
	return (input: string) => {
		opened.handleInput?.(input);
		return opened.render(60);
	};
}

/** Overlay chrome: rule, title, blank, scrollable body, blank, rule, hint. */
const body = (lines: string[]): string => lines.slice(3, -3).join("\n");

describe("/status dialog paging", () => {
	it("stops at the top when the arrows walk back past the first row", async () => {
		const press = await openDialog(10);
		const initial = body(press("\u001b[A"));
		expect(initial).toContain("tool-0");

		press(PAGE_DOWN);
		expect(body(press("\u001b[A"))).not.toBe(initial);

		// One line up from the top of the second page leaves the offset at 0.
		const backToTop = body(press("\u001b[A"));
		expect(backToTop).not.toContain("{dim}↑");
		expect(backToTop).toContain("tool-0");

		// Down a line, then up again: the offset clamps instead of going negative.
		press("\u001b[B");
		expect(body(press("\u001b[A"))).toBe(backToTop);
	});

	it("scrolls a page on PageUp/PageDown and clamps at the ends", async () => {
		const press = await openDialog(10);
		const top = body(press("\u001b[A"));

		press(PAGE_DOWN);
		const secondPage = body(press("\u001b[A"));
		expect(secondPage).not.toBe(top);
		expect(secondPage).toContain("tool-");

		press(PAGE_UP);
		expect(body(press("\u001b[A"))).toBe(top);

		// Paging past the end keeps the last page full instead of scrolling into blank rows.
		for (let index = 0; index < 20; index++) press(PAGE_DOWN);
		const atEnd = body(press(PAGE_DOWN));
		expect(atEnd).toEqual(body(press(PAGE_DOWN)));
		expect(atEnd).not.toContain("{dim}↓");
	});
});
