/**
 * `/status` dialog chrome.
 *
 * Same conventions as `/context` (see context-dialog.ts): bottom-docked
 * full-width overlay, accent rules top/bottom, one-line dim hint footer,
 * pure keyboard interaction (Esc/Ctrl-C closes, ↑/↓ scrolls on overflow).
 *
 * Below the label/value rows, the loaded-resource sections moved here from the
 * startup page ([Context] / [Skills] / [Prompts] / [Extensions]) render as
 * indented comma-separated lists, wrapped to the dialog width.
 */

import { clampScrollOffset, Key, matchesKey, pageScrollOffset, truncateToWidth, visibleWidth } from "@nanopi/pi-tui";
import type { ModuleCommandContext } from "../../core/modules/types.ts";

export type StatusRow = {
	label: string;
	value: string;
};

export type StatusSection = {
	title: string;
	items: string[];
};

export type StatusDialogData = {
	title: string;
	rows: StatusRow[];
	sections: StatusSection[];
};

/** Pad a line to a fixed visible width, truncating with an ellipsis when over. */
export function padStatusLine(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Greedy word wrap by visible width. Long words are kept on their own line, truncated later. */
export function wrapStatusText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
		if (current === "") {
			current = word;
			continue;
		}
		if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
			current = `${current} ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current !== "" || lines.length === 0) lines.push(current);
	return lines;
}

/** Overlay placement: full-width, docked to the bottom edge (matches /context). */
const OVERLAY_OPTIONS = {
	anchor: "bottom-center",
	width: "100%",
	maxHeight: "100%",
	margin: { left: 0, right: 0, bottom: 0 },
} as const;

function rule(theme: any, width: number): string {
	return theme.fg("accent", "─".repeat(Math.max(1, width)));
}

function hintRow(theme: any, text: string, width: number): string {
	return theme.fg("dim", padStatusLine(` ${text}`, width));
}

/** Render the section block: ` [Title]` header plus dim wrapped item lines. */
function sectionLines(theme: any, section: StatusSection, contentWidth: number): string[] {
	const lines = [theme.fg("mdHeading", `[${section.title}]`)];
	const joined = section.items.join(", ");
	for (const wrapped of wrapStatusText(joined, Math.max(1, contentWidth - 2))) {
		lines.push(theme.fg("dim", padStatusLine(`   ${wrapped}`, contentWidth)));
	}
	return lines;
}

/** Interactive /status dialog: static rows + resource sections, Esc closes, ↑/↓/PgUp/PgDn scroll on overflow. */
export async function showStatusDialog(ctx: Pick<ModuleCommandContext, "ui">, data: StatusDialogData): Promise<void> {
	let scrollOffset = 0;
	// Rows the last render could show. Key handling runs before the next render, so
	// keyboard paging needs the size the body already had. `render()` derives it from
	// the rows it actually emits, not from the terminal height: the terminal can be
	// taller than the overlay, and a page taller than the body drops rows on PgDn.
	let pageRows = 1;
	// Body rows from the last render, so key handling clamps against the real length.
	let totalRows = 0;

	await ctx.ui.custom(
		(tui, theme, _keybindings, done) => {
			return {
				invalidate() {},
				handleInput(input: string) {
					if (matchesKey(input, Key.escape) || matchesKey(input, Key.ctrl("c"))) {
						done(undefined);
						return;
					}
					if (matchesKey(input, Key.up)) {
						scrollOffset = clampScrollOffset(scrollOffset - 1, totalRows, pageRows);
						tui.requestRender();
						return;
					}
					if (matchesKey(input, Key.down)) {
						scrollOffset = clampScrollOffset(scrollOffset + 1, totalRows, pageRows);
						tui.requestRender();
						return;
					}
					if (matchesKey(input, "pageUp")) {
						scrollOffset = pageScrollOffset(scrollOffset, totalRows, pageRows, -1);
						tui.requestRender();
						return;
					}
					if (matchesKey(input, "pageDown")) {
						scrollOffset = pageScrollOffset(scrollOffset, totalRows, pageRows, 1);
						tui.requestRender();
						return;
					}
				},
				render(width: number) {
					const contentWidth = Math.max(1, width - 2);
					const title = theme.bold(data.title);
					const labelWidth = Math.min(16, Math.max(...data.rows.map((row) => row.label.length), 8));
					const rowLines = data.rows.map((row) =>
						padStatusLine(` ${row.label.padEnd(labelWidth)}  ${row.value}`, contentWidth),
					);

					const sectionEntries = data.sections.filter((section) => section.items.length > 0);
					const sectionBlocks = sectionEntries.map((section) => sectionLines(theme, section, contentWidth));
					const body: string[] = [];
					for (const [index, block] of sectionBlocks.entries()) {
						if (index === 0) body.push(padStatusLine("", contentWidth));
						body.push(...block);
					}
					const allRows = [...rowLines, ...body];

					// rule + title + blank above the body, blank + rule + hint below it: six
					// chrome rows this dialog actually draws.
					const rows = Math.max(1, tui.terminal.rows);
					pageRows = Math.max(1, Math.min(rows - 6, allRows.length));
					totalRows = allRows.length;
					scrollOffset = clampScrollOffset(scrollOffset, allRows.length, pageRows);
					const visible = allRows.slice(scrollOffset, scrollOffset + pageRows);
					if (scrollOffset > 0 && visible.length > 0) visible[0] = theme.fg("dim", "↑");
					if (scrollOffset + pageRows < allRows.length && visible.length > 0) {
						visible[visible.length - 1] = theme.fg("dim", "↓");
					}

					return [
						rule(theme, width),
						padStatusLine(` ${title}`, contentWidth),
						"",
						...visible,
						"",
						rule(theme, width),
						hintRow(theme, "↑/↓ PgUp/PgDn to scroll · Esc to close", width),
					];
				},
			};
		},
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);
}
