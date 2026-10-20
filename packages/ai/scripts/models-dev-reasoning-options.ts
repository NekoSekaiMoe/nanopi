import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";

export type ModelsDevReasoningOption =
	| { type: "toggle" }
	| {
			type: "effort";
			values: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null>;
	  }
	| { type: "budget_tokens"; min?: number; max?: number };

const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Converts models.dev verified effort values into nanopi's selectable thinking levels.
 * Values without a nanopi equivalent (`default` and JSON `null`) are intentionally
 * omitted.
 *
 * models.dev lists the effort values a model accepts, so an absent extreme level
 * means it is unsupported. `off` is the exception: an effort list that omits
 * "none" says nothing about disabling thinking on its own, so it stays
 * selectable unless the model reports a verified reasoning effort control.
 */
export function getEffortThinkingLevelMap(options: readonly ModelsDevReasoningOption[]): ThinkingLevelMap | undefined {
	const effortValues = options.flatMap((option) => (option.type === "effort" ? option.values : []));
	if (effortValues.length === 0) return undefined;

	const supported = new Set(effortValues);
	if (!THINKING_LEVELS.some((level) => supported.has(level)) && !supported.has("none")) return undefined;

	const map: ThinkingLevelMap = {};
	if (supported.has("none")) {
		map.off = "none";
	} else if (options.some((option) => option.type === "effort")) {
		// A verified effort list without "none" means thinking cannot be turned off.
		map.off = null;
	}
	for (const level of THINKING_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}
