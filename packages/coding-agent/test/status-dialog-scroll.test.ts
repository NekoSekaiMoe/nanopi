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

/** A body short enough to fit any terminal: two rows, no sections. */
const shortDialog: StatusDialogData = {
	title: "status",
	rows: [
		{ label: "model", value: "x" },
		{ label: "provider", value: "y" },
	],
	sections: [],
};

/** Drive the real dialog component the way the overlay host does. */
async function openDialog(rows: number, data: StatusDialogData = dialog): Promise<(input: string) => string[]> {
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

	await showStatusDialog(ctx, data);
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

		// A page down leaves the last visible row as the new first row, so a single line up
		// from there is still a scroll — but walking back to the first page drops the marker.
		const oneLineUp = body(press("\u001b[A"));
		expect(oneLineUp).not.toBe(initial);
		expect(oneLineUp).toContain("{dim}↑");

		press(PAGE_UP);
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

	it("pages by the rows it draws, not by the terminal height", async () => {
		// One row of content on a 40-row terminal. The old `rows - 1 - chrome` budget
		// claimed 34 rows and scrolled past the single row it could show.
		let component: (Component & { dispose?(): void }) | undefined;
		const tui = { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI;
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

		await showStatusDialog(ctx, { title: "status", rows: [{ label: "model", value: "x" }], sections: [] });
		const opened = component;
		if (!opened) throw new Error("dialog did not open");
		expect(body(opened.render(60))).toContain("model");

		opened.handleInput?.(PAGE_DOWN);
		const afterPageDown = body(opened.render(60));
		expect(afterPageDown).toContain("model");
		expect(afterPageDown).not.toContain("{dim}↑");
	});

	it("does not page past the body when the terminal is taller than the overlay", async () => {
		// A tall terminal used to give the dialog a page budget of `rows - 6`, far more
		// than the two rows it draws; one PgDn then landed on the last row and hid the
		// first. The page is capped at the body length, so one PgDn from the top cannot
		// reach the end of a body that fits on screen.
		const press = await openDialog(40, shortDialog);
		const top = body(press("\u001b[A"));
		expect(top).toContain("model");
		expect(top).toContain("provider");
		expect(body(press(PAGE_DOWN))).toBe(top);
	});

	it("pages by the rows the terminal can show when the body is longer", async () => {
		// 12 rows - 6 chrome rows leaves a 6-row page, so PgDn keeps five rows on screen
		// and the sixth row of the old page becomes the first of the new one. Paging by
		// less would overlap more than the row the scroll-view rule allows.
		const press = await openDialog(12);
		const top = press("\u001b[A");
		press(PAGE_DOWN);
		const next = press("\u001b[A");
		expect(`\n${body(next)}\n`).toContain(`\n${body(top).split("\n").at(-1)}\n`);
	});
});
