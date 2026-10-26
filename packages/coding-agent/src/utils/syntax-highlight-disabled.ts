/**
 * Stand-in for `syntax-highlight.ts` in a build that drops the
 * `syntax-highlight` component (buildconfig.json).
 *
 * The bundle aliases the module at resolve time (scripts/build-components.mjs)
 * instead of relying on a dead branch: a `const ENABLED = components[...] !== false`
 * guard folds every caller but leaves the grammar imports in place, so all 191
 * highlight.js grammars stayed in the bundle of a build that renders no color.
 * A resolve-time alias keeps the imports out entirely.
 *
 * The signatures match `syntax-highlight.ts` exactly, because callers import
 * these functions by name and never see which module they landed on.
 */

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

export function pendingHighlightLanguages(): Promise<void>[] {
	return [];
}

/** Renders code blocks in the plain output color. */
export function highlight(code: string, _options: HighlightOptions = {}): string {
	return code;
}

export function supportsLanguage(_name: string): boolean {
	return false;
}

export function renderHighlightedHtml(html: string, _theme: HighlightTheme = {}): string {
	return html;
}
