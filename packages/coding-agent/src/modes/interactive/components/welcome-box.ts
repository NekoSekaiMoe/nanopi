import type { Component } from "@nanopi/pi-tui";
import { truncateToWidth, visibleWidth } from "@nanopi/pi-tui";
import { theme } from "../theme/theme.ts";

export interface WelcomeBoxData {
	version: string;
	modelId: string;
	provider: string | undefined;
	thinkingLevel: string | undefined;
	showThinking: boolean;
	cwd: string;
}

function fitRow(text: string, innerWidth: number): string {
	const fitted = truncateToWidth(text, Math.max(0, innerWidth), "…");
	return fitted + " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
}

/**
 * Codex-style welcome box:
 *
 * ┌──────────────────────────────────┐
 * │ π nanopi vx.x.x                  │
 * │                                  │
 * │ model: xxx    /model to change   │
 * │ provider: xxx  thinking: high    │
 * │ directory: ~                     │
 * └──────────────────────────────────┘
 *
 * Border is dim; title is bold. Content rows truncate to fit.
 */
export function renderWelcomeBox(data: WelcomeBoxData, width: number): string[] {
	const inner = Math.max(10, Math.min(width - 2, 62));
	const border = (left: string, fill: string, right: string): string =>
		theme.fg("dim", `${left}${fill.repeat(inner + 2)}${right}`);
	const row = (text: string): string => theme.fg("dim", "│ ") + fitRow(text, inner) + theme.fg("dim", " │");

	const title = theme.bold(`π nanopi v${data.version}`);
	const modelHint = theme.fg("dim", "/model to change");
	// Build model row with real colors: prefix plain, hint dim. Re-fit to keep width exact.
	const modelPrefix = `model:     ${data.modelId}   `;
	const modelLine =
		theme.fg("dim", "│ ") +
		modelPrefix +
		truncateToWidth(modelHint, Math.max(0, inner - visibleWidth(modelPrefix)), "…") +
		" ".repeat(Math.max(0, inner - visibleWidth(modelPrefix) - visibleWidth(modelHint))) +
		theme.fg("dim", " │");

	const providerText = data.provider ?? "n/a";
	const thinkingText = data.showThinking ? (data.thinkingLevel ?? "off") : "off";
	const metaLine =
		theme.fg("dim", "│ ") +
		fitRow(`provider:  ${providerText}  thinking: ${thinkingText}`, inner) +
		theme.fg("dim", " │");
	const dirLine = theme.fg("dim", "│ ") + fitRow(`directory: ${data.cwd}`, inner) + theme.fg("dim", " │");

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

export function renderWelcomeTip(): string {
	return theme.fg("dim", "Tip: Use /status to see the current model, token usage, and context.");
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
		return [...renderWelcomeBox(this.getData(), width), "", renderWelcomeTip()];
	}
}
