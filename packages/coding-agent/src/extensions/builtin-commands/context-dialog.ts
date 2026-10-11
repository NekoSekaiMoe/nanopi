/**
 * `/context` interactive dialog.
 *
 * Renders the context-usage breakdown as a bottom-docked full-width overlay:
 *
 *   ───────────────────────────────────────────  ← accent rule
 *    Context Usage  12.3k / 272k tokens (4.5%)
 *
 *    ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
 *
 *    › ■ System prompt      1.2k   0.4%
 *      ■ Memory             ...        (selected → selectedBg)
 *
 *   ───────────────────────────────────────────
 *    Enter to preview · ↑/↓ to navigate · Esc to close
 *
 * Dialog conventions: bottom-center anchor, width 100%, fixed chrome top/bottom,
 * scrollable middle region with ↑/↓ overflow markers, one-line hint footer,
 * pure keyboard interaction.
 */

import { type ExtensionCommandContext, getMarkdownTheme } from "@nanopi/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@nanopi/pi-tui";

export type ContextPartColor = "accent" | "success" | "warning" | "customMessageLabel" | "muted" | "dim" | "error";

export type ContextPart = {
	label: string;
	tokens: number;
	color: ContextPartColor;
};

export type ContextPreview = {
	key: string;
	label: string;
	title: string;
	content: string;
};

export type ContextDialogData = {
	used: number;
	contextWindow: number;
	parts: ContextPart[];
	previews: ContextPreview[];
};

/** Pad a line to a fixed visible width, truncating with an ellipsis when over. */
export function padLine(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

const OVERFLOW_UP = "↑";
const OVERFLOW_DOWN = "↓";

/** Overlay placement: full-width, docked to the bottom edge. */
const OVERLAY_OPTIONS = {
	anchor: "bottom-center",
	width: "100%",
	maxHeight: "100%",
	margin: { left: 0, right: 0, bottom: 0 },
} as const;

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const ANSI_OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FENCE_MARKER_RE = /^`{3}/;

/** Drop ``` fence marker lines pi-tui's Markdown emits around code blocks. */
export function stripFenceMarkers(lines: readonly string[]): string[] {
	return lines.filter((line) => {
		const clean = line.replace(ANSI_SGR_RE, "").replace(ANSI_OSC8_RE, "");
		return !FENCE_MARKER_RE.test(clean);
	});
}

function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

/** Shared chrome: accent rules top/bottom + one-line dim hint footer. */
function rule(theme: any, width: number): string {
	return theme.fg("accent", "─".repeat(Math.max(1, width)));
}

function hintRow(theme: any, text: string, width: number): string {
	return theme.fg("dim", padLine(` ${text}`, width));
}

/** Right-align `suffix` after `prefix` on one visible row; drops it when it cannot fit. */
function rowWithSuffix(prefix: string, suffix: string, width: number): string {
	const gap = width - visibleWidth(prefix) - visibleWidth(suffix);
	if (gap < 1) return truncateToWidth(prefix, width, "…");
	return `${prefix}${" ".repeat(gap)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

/**
 * Interactive /context dialog loop: main breakdown list ↔ text previews.
 * Enter opens the preview of the selected row, Esc closes layer by layer.
 */
export async function showContextDialog(
	ctx: Pick<ExtensionCommandContext, "ui">,
	data: ContextDialogData,
): Promise<void> {
	const previewByKey = new Map(data.previews.map((preview) => [preview.key, preview]));
	let selected = 0;

	while (true) {
		const action = await ctx.ui.custom<string | undefined>(
			(tui, theme, _keybindings, done) => {
				return {
					invalidate() {},
					handleInput(input: string) {
						if (matchesKey(input, Key.escape) || matchesKey(input, Key.ctrl("c"))) {
							done(undefined);
							return;
						}
						if (data.previews.length === 0) return;
						if (matchesKey(input, Key.up)) {
							selected = (selected - 1 + data.previews.length) % data.previews.length;
							tui.requestRender();
							return;
						}
						if (matchesKey(input, Key.down)) {
							selected = (selected + 1) % data.previews.length;
							tui.requestRender();
							return;
						}
						if (matchesKey(input, Key.enter)) done(data.previews[selected]?.key);
					},
					render(width: number) {
						const contentWidth = Math.max(1, width - 2);
						const percent = data.contextWindow > 0 ? (data.used / data.contextWindow) * 100 : 0;
						const title = theme.bold(theme.fg("accent", "Context Usage"));
						const subtitle = theme.fg(
							"muted",
							`${formatTokens(data.used)} / ${formatTokens(data.contextWindow)} tokens (${percent.toFixed(1)}%)`,
						);

						// Usage bar across the full content width.
						const barWidth = Math.max(1, contentWidth - 2);
						let remaining = barWidth;
						const segments = data.parts
							.map((part, index) => {
								const cells =
									index === data.parts.length - 1
										? remaining
										: Math.min(
												remaining,
												Math.round((part.tokens / Math.max(1, data.contextWindow)) * barWidth),
											);
								remaining -= cells;
								return theme.fg(part.color, "█".repeat(Math.max(0, cells)));
							})
							.join("");
						const bar = segments;

						// Part rows: › marks the preview-selectable cursor.
						const labelWidth = Math.min(24, Math.max(...data.parts.map((part) => part.label.length)));
						const selectedLabel = data.previews[selected]?.label;
						const partRows = data.parts.map((part) => {
							const pct = data.contextWindow > 0 ? (part.tokens / data.contextWindow) * 100 : 0;
							const swatch = theme.fg(part.color, "■");
							const label = part.label.padEnd(labelWidth);
							const amount = `${formatTokens(part.tokens).padStart(7)}  ${pct.toFixed(1).padStart(5)}%`;
							const cursor = part.label === selectedLabel ? "› " : "  ";
							const row = padLine(` ${cursor}${swatch} ${label} ${amount}`, contentWidth);
							return part.label === selectedLabel ? theme.bg("selectedBg", row) : row;
						});

						// On tiny terminals drop blank rows first, then clip part rows.
						const rows = Math.max(1, tui.terminal.rows);
						const chrome = 6; // rule + title + bar + rule + hint + one blank
						const maxParts = Math.max(1, rows - chrome - 1);
						const shownParts =
							partRows.length > maxParts
								? [
										...partRows.slice(0, maxParts - 1),
										padLine(` … +${partRows.length - maxParts + 1} more`, contentWidth),
									]
								: partRows;

						return [
							rule(theme, width),
							padLine(` ${title}  ${subtitle}`, contentWidth),
							"",
							padLine(` ${bar}`, contentWidth),
							"",
							...shownParts,
							"",
							rule(theme, width),
							hintRow(theme, "Enter to preview · ↑/↓ to navigate · Esc to close", width),
						];
					},
				};
			},
			{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
		);

		if (!action) break;
		const preview = previewByKey.get(action);
		if (!preview) continue;
		await showTextPreview(ctx, preview.title, preview.content);
	}
}

// ---------------------------------------------------------------------------
// Text preview dialog
// ---------------------------------------------------------------------------

/**
 * Scrollable markdown viewer for one context slice. Pure keyboard:
 * ↑/↓ line, PgUp/PgDn page, Home/End jump, Esc back.
 */
export async function showTextPreview(
	ctx: Pick<ExtensionCommandContext, "ui">,
	title: string,
	rawContent: string,
): Promise<void> {
	const content = rawContent
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

	await ctx.ui.custom(
		(tui, theme, _keybindings, done) => {
			const markdownView = new Markdown(content, 0, 0, getMarkdownTheme());
			let scrollOffset = 0;
			let pageSize = 1;
			let totalLines = 1;

			const scrollTo = (nextOffset: number): void => {
				const next = Math.max(0, Math.min(nextOffset, Math.max(0, totalLines - pageSize)));
				if (next === scrollOffset) return;
				scrollOffset = next;
				tui.requestRender();
			};

			return {
				invalidate() {
					markdownView.invalidate();
				},
				handleInput(input: string) {
					if (matchesKey(input, Key.escape) || matchesKey(input, Key.ctrl("c"))) {
						done(undefined);
						return;
					}
					if (matchesKey(input, Key.up)) scrollTo(scrollOffset - 1);
					else if (matchesKey(input, Key.down)) scrollTo(scrollOffset + 1);
					else if (matchesKey(input, "pageUp")) scrollTo(scrollOffset - pageSize);
					else if (matchesKey(input, "pageDown")) scrollTo(scrollOffset + pageSize);
					else if (matchesKey(input, Key.home)) scrollTo(0);
					else if (matchesKey(input, Key.end)) scrollTo(totalLines - pageSize);
				},
				render(width: number) {
					// Fixed chrome: top rule + title + bottom rule + hint row.
					const rows = Math.max(1, tui.terminal.rows);
					const chromeRows = 4;
					pageSize = Math.max(3, rows - 1 - chromeRows);

					const bodyWidth = Math.max(1, width - 4);
					const wrapped = stripFenceMarkers(markdownView.render(bodyWidth));
					totalLines = wrapped.length;
					scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));

					const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
					// Three-region overflow: replace edge rows with dim arrows.
					if (scrollOffset > 0 && visible.length > 0) visible[0] = theme.fg("dim", OVERFLOW_UP);
					if (scrollOffset + pageSize < totalLines && visible.length > 0) {
						visible[visible.length - 1] = theme.fg("dim", OVERFLOW_DOWN);
					}

					const contentWidth = Math.max(1, width - 2);
					const start = totalLines === 0 ? 0 : scrollOffset + 1;
					const end = Math.min(totalLines, scrollOffset + pageSize);
					const heading = theme.bold(theme.fg("accent", title));
					const counter = theme.fg("dim", `${start}-${end} / ${totalLines} lines`);

					return [
						rule(theme, width),
						padLine(rowWithSuffix(` ${heading}`, counter, contentWidth), contentWidth),
						...visible.map((line) => padLine(` ${line}`, contentWidth)),
						rule(theme, width),
						hintRow(theme, "↑/↓ PgUp/PgDn Home/End to scroll · Esc to back", width),
					];
				},
			};
		},
		{ overlay: true, overlayOptions: OVERLAY_OPTIONS },
	);
}
