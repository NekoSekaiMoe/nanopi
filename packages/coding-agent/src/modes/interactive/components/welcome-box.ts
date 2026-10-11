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
 * │ π NanoPi vx.x.x                  │
 * │                                  │
 * │ model: xxx                       │
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

	const title = theme.bold(`π NanoPi v${data.version}`);
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

/** Startup tip, truncated to the terminal width so narrow terminals do not crash the renderer. */
export function renderWelcomeTip(width: number): string {
	const tip = "Tip: Use /status to see the model, token usage, context, and loaded extensions and skills.";
	return theme.fg("dim", truncateToWidth(tip, Math.max(0, width), "…"));
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
		return [...renderWelcomeBox(this.getData(), width), "", renderWelcomeTip(width)];
	}
}
