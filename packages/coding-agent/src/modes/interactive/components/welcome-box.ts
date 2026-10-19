import type { Component } from "@nanopi/pi-tui";
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@nanopi/pi-tui";
import { theme } from "../theme/theme.ts";

export interface WelcomeBoxData {
	version: string;
	modelId: string;
	provider: string | undefined;
	thinkingLevel: string | undefined;
	showThinking: boolean;
	cwd: string;
	/** Current git branch of the working directory, when it is a repository. */
	branch?: string | undefined;
}

function fitRow(text: string, innerWidth: number): string {
	const fitted = truncateToWidth(text, Math.max(0, innerWidth), "…");
	return fitted + " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
}

/**
 * Fold the middle of text that does not fit: `/a/b/..../d`.
 *
 * Both ends carry the information a reader needs (where the path starts, which
 * directory it ends in), so they stay visible and the elided middle collapses
 * into one ellipsis. A plain tail truncation would drop the directory the user
 * is actually in, which is the part that matters.
 */
export function foldMiddle(text: string, maxWidth: number): string {
	const ellipsis = "…";
	if (visibleWidth(text) <= maxWidth) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (maxWidth <= ellipsisWidth) return truncateToWidth(text, Math.max(0, maxWidth), ellipsis);
	// sliceByColumn keeps graphemes and ANSI codes intact, so wide characters
	// are never split in half.
	const budget = maxWidth - ellipsisWidth;
	const headWidth = Math.ceil(budget / 2);
	return `${sliceByColumn(text, 0, headWidth)}${ellipsis}${sliceByColumn(text, visibleWidth(text) - (budget - headWidth), budget - headWidth)}`;
}

/**
 * Codex-style welcome box:
 *
 * ┌──────────────────────────────────┐
 * │ π NanoPi v20261013.718adde       │
 * │                                  │
 * │ model: xxx                       │
 * │ provider: xxx  thinking: high    │
 * │ directory: ~/a/.../d (main)      │
 * └──────────────────────────────────┘
 *
 * Border is dim; title is bold. Content rows fold long paths in the middle and
 * truncate anything else.
 */
export function renderWelcomeBox(data: WelcomeBoxData, width: number): string[] {
	const inner = Math.max(10, Math.min(width - 2, 62));
	const border = (left: string, fill: string, right: string): string =>
		theme.fg("dim", `${left}${fill.repeat(inner + 2)}${right}`);
	const row = (text: string): string => theme.fg("dim", "│ ") + fitRow(text, inner) + theme.fg("dim", " │");

	const title = theme.bold(`π NanoPi ${data.version}`);
	// The provider row already names the provider, so strip a matching "provider/" prefix
	// from the model id (catalogs like OpenRouter use "vendor/model" ids).
	const providerPrefix = data.provider ? `${data.provider}/` : undefined;
	const modelId =
		providerPrefix && data.modelId.startsWith(providerPrefix)
			? data.modelId.slice(providerPrefix.length)
			: data.modelId;
	const modelLine = row(`model:     ${modelId}`);

	const providerText = data.provider ?? "n/a";
	const thinkingText = data.showThinking ? (data.thinkingLevel ?? "off") : "off";
	const metaLine =
		theme.fg("dim", "│ ") +
		fitRow(`provider:  ${providerText}  thinking: ${thinkingText}`, inner) +
		theme.fg("dim", " │");
	// The branch suffix rides along with the path, so a long path is folded to
	// the width left after `directory: ` and the suffix.
	const directory = data.branch ? `${data.cwd} (${data.branch})` : data.cwd;
	const dirLine =
		theme.fg("dim", "│ ") + fitRow(`directory: ${foldMiddle(directory, inner - 11)}`, inner) + theme.fg("dim", " │");

	return [
		border("┌", "─", "┐"),
		theme.fg("dim", "│ ") + fitRow(title, inner) + theme.fg("dim", " │"),
		row(""),
		modelLine,
		metaLine,
		dirLine,
		border("└", "─", "┘"),
	];
}

/** Startup tip, wrapped to the terminal width so the sentence stays readable. */
export function renderWelcomeTip(width: number): string {
	const tip = "Tip: Use /status to see the model, token usage, context, and loaded extensions and skills.";
	if (width <= 0) return "";
	// A wrapped line must never exceed the terminal width, so the continuation
	// hangs under the text instead of under "Tip: ".
	const lines = wrapTextWithAnsi(tip, width);
	return theme.fg("dim", lines.map((line) => truncateToWidth(line, width, "…")).join("\n"));
}

/** Static Codex-style welcome header: box + tip line. Rebuilds colors on theme change. */
export class WelcomeHeader implements Component {
	private readonly getData: () => WelcomeBoxData;

	constructor(getData: () => WelcomeBoxData) {
		this.getData = getData;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		return [...renderWelcomeBox(this.getData(), width), "", ...renderWelcomeTip(width).split("\n")];
	}
}
