import type { Component, TUI } from "@nanopi/pi-tui";
import { TUI_KEYBINDINGS, KeybindingsManager as TuiKeybindingsManager } from "@nanopi/pi-tui";
import { describe, expect, it } from "vitest";
import type { ModuleCommandContext } from "../src/index.ts";
import { initTheme } from "../src/index.ts";
import {
	type ContextDialogData,
	type ContextPreview,
	showContextDialog,
	showTextPreview,
} from "../src/modules/builtin-commands/context-dialog.ts";

initTheme();

/** Theme stub: only `fg`/`bg` must keep their text so the assertions can read it. */
const theme = {
	fg: (color: string, text: string) => `{${color}}${text}`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/**
 * Open a dialog with its component captured. `ctx.ui.custom` hands the factory to the
 * dialog, so the fake host stores whatever component the factory builds.
 */
async function open(
	rows: number,
	run: (ctx: Pick<ModuleCommandContext, "ui">) => Promise<unknown>,
): Promise<Component> {
	let component: Component | undefined;
	const tui = { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
	const ctx = {
		ui: {
			custom: (factory: unknown) => {
				component = (factory as (...args: unknown[]) => Component)(
					tui,
					theme,
					new TuiKeybindingsManager(TUI_KEYBINDINGS),
					() => {},
				);
				return Promise.resolve();
			},
		},
	} as unknown as Pick<ModuleCommandContext, "ui">;
	// The dialogs await `custom`, which never resolves here; the component is captured.
	void run(ctx);
	await Promise.resolve();
	if (!component) throw new Error("dialog did not open");
	return component;
}

const parts = Array.from({ length: 12 }, (_, index) => ({
	label: `part-${index}`,
	tokens: 100,
	color: "accent" as const,
}));

const preview: ContextPreview = {
	key: "system",
	label: "System prompt",
	title: "System prompt",
	content: Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"),
};

const data: ContextDialogData = {
	used: 1_200,
	contextWindow: 272_000,
	parts,
	previews: [preview],
};

describe("/context list frame", () => {
	it("keeps the frame inside the terminal on a short terminal", async () => {
		// rule, title, blank, bar, blank + parts + blank, rule, hint: nine chrome rows.
		// Counting eight let the last part row fall below the terminal height.
		const component = await open(12, (ctx) => showContextDialog(ctx, data));
		const lines = component.render(60);
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines.at(-1)).toContain("to navigate");
	});
});

describe("/context preview frame", () => {
	it("fills the rows the terminal has, not one fewer", async () => {
		// rule + title above, rule + hint below: four chrome rows. Subtracting a fifth
		// row left a terminal line unused and made every page one row short.
		const component = await open(12, (ctx) => showTextPreview(ctx, preview.title, preview.content));
		const lines = component.render(60);
		expect(lines).toHaveLength(12);
		// Eight body rows between the title and the bottom rule.
		expect(lines[1]).toContain("1-8 / 40 lines");
		expect(lines[2]).toContain("line 0");
		expect(lines[8]).toContain("line 6");
		// The bottom body row carries the scroll marker, and nothing past it is drawn.
		expect(lines[9]).not.toContain("line 7");
	});
});
