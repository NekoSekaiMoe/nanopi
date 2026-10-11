/**
 * `/status` dialog chrome.
 *
 * Same conventions as `/context` (see context-dialog.ts): bottom-docked
 * full-width overlay, accent rules top/bottom, one-line dim hint footer,
 * pure keyboard interaction (Esc/Ctrl-C closes, ↑/↓ scrolls on overflow).
 */

import type { ExtensionCommandContext } from "@nanopi/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@nanopi/pi-tui";

export type StatusRow = {
	label: string;
	value: string;
};

export type StatusDialogData = {
	title: string;
	rows: StatusRow[];
};

/** Pad a line to a fixed visible width, truncating with an ellipsis when over. */
export function padStatusLine(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
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

/** Interactive /status dialog: static rows, Esc closes, ↑/↓ scrolls on overflow. */
export async function showStatusDialog(
	ctx: Pick<ExtensionCommandContext, "ui">,
	data: StatusDialogData,
): Promise<void> {
	let scrollOffset = 0;

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
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
						return;
					}
					if (matchesKey(input, Key.down)) {
						scrollOffset += 1;
						tui.requestRender();
						return;
					}
				},
				render(width: number) {
					const contentWidth = Math.max(1, width - 2);
					const title = theme.bold(data.title);
					const labelWidth = Math.min(16, Math.max(...data.rows.map((row) => row.label.length), 8));
					const allRows = data.rows.map((row) =>
						padStatusLine(` ${row.label.padEnd(labelWidth)}  ${row.value}`, contentWidth),
					);

					const rows = Math.max(1, tui.terminal.rows);
					const chrome = 4; // rule + title + rule + hint
					const pageSize = Math.max(1, rows - 1 - chrome);
					scrollOffset = Math.min(scrollOffset, Math.max(0, allRows.length - pageSize));
					const visible = allRows.slice(scrollOffset, scrollOffset + pageSize);
					if (scrollOffset > 0 && visible.length > 0) visible[0] = theme.fg("dim", "↑");
					if (scrollOffset + pageSize < allRows.length && visible.length > 0) {
						visible[visible.length - 1] = theme.fg("dim", "↓");
					}

					return [
						rule(theme, width),
						padStatusLine(` ${title}`, contentWidth),
						"",
						...visible,
						"",
						rule(theme, width),
						hintRow(theme, "↑/↓ to scroll · Esc to close", width),
					];
				},
			};
		},
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);
}
