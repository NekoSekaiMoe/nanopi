import type { ThinkingLevel } from "@nanopi/pi-agent-core";
import {
	backgroundAnsi,
	type Color,
	colorToHex,
	colorToOklch,
	type EditorTheme,
	foregroundAnsi,
	getTerminalColorMode,
	type MarkdownTheme,
	mixColors,
	parseColor,
	type RgbColor,
	rgbColor,
	type SelectListTheme,
	type SettingsListTheme,
	styleTextWithAnsi,
	type TerminalColorMode,
	type TerminalColors,
	type TextAttributes,
} from "@nanopi/pi-tui";
import chalk from "chalk";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";
import { generateSystemThemeColors, SYSTEM_THEME_NAME, terminalAppearance } from "./system-theme.ts";
import {
	type ResolvedThemeColorValues,
	THEME_TOKENS,
	type ThemeBg,
	type ThemeColor,
	type ThemeColorValues,
	type ThemeToken,
} from "./theme-tokens.ts";

export { SYSTEM_THEME_NAME } from "./system-theme.ts";
export type { ThemeBg, ThemeColor, ThemeToken } from "./theme-tokens.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Tokens are only accepted in their own slot, because "" (terminal default) means the default foreground
 * or background depending on the slot. Use `theme.colors[token]` to use a token's color in the other slot.
 */
export interface ThemeStyle extends TextAttributes {
	fg?: ThemeColor | Color;
	bg?: ThemeBg | Color;
}

// ============================================================================
// Color Utilities
// ============================================================================

function withThemeTokenFallbacks<Value>(values: ThemeColorValues<Value>): ResolvedThemeColorValues<Value> {
	const resolved = { ...values } as Partial<ResolvedThemeColorValues<Value>>;
	for (const [rawName, descriptor] of Object.entries(THEME_TOKENS)) {
		if (!("fallback" in descriptor)) continue;
		const name = rawName as ThemeToken;
		if (resolved[name] !== undefined) continue;
		const fallback = descriptor.fallback as ThemeToken;
		const fallbackValue = resolved[fallback];
		if (fallbackValue === undefined) {
			throw new Error(`Theme token ${rawName} has unresolved fallback ${descriptor.fallback}`);
		}
		resolved[name] = fallbackValue;
	}
	return resolved as ResolvedThemeColorValues<Value>;
}

// ============================================================================
// Appearance & Terminal Default Colors
// ============================================================================

/** The background a theme is designed for. */
export type ThemeAppearance = TerminalTheme;

// The terminal's reported colors. Replaced (never mutated) on update, so themes can cache resolved colors
// by identity.
let terminalColors: TerminalColors = {};
// While the terminal color query is in flight, the system theme renders in grayscale.
let terminalColorsPending = false;
// The terminal's last light/dark report (mode 2031). Only used while it has not reported a background.
let terminalColorScheme: TerminalTheme | undefined;

/**
 * Record the terminal's reported colors. The system theme is generated from them; tokens set to "" use
 * the defaults. Ends the pending state.
 */
export function setTerminalColors(colors: TerminalColors): void {
	terminalColors = { ...colors };
	terminalColorsPending = false;
}

/** Record the terminal's light/dark report, the fallback for terminals that do not report their background. */
export function setTerminalColorScheme(scheme: TerminalTheme | undefined): void {
	terminalColorScheme = scheme;
}

/** Render the system theme in grayscale until `setTerminalColors()` reports the terminal's colors. */
export function markTerminalColorsPending(): void {
	terminalColorsPending = true;
}

/** Assumed terminal default colors when the terminal does not report them. */
const GUESSED_DEFAULT_COLORS: Record<ThemeAppearance, { foreground: Color; background: Color }> = {
	dark: { foreground: parseColor("#e5e5e7"), background: parseColor("#000000") },
	light: { foreground: parseColor("#000000"), background: parseColor("#ffffff") },
};

function averageLightness(colors: Color[]): number | undefined {
	// Palette colors 0-15 follow the user's terminal palette, so they say nothing about the theme.
	const fixed = colors.filter((color) => color.kind !== "indexed" || color.index >= 16);
	if (fixed.length === 0) return undefined;
	return fixed.reduce((sum, color) => sum + colorToOklch(color).l, 0) / fixed.length;
}

/** Detect the background a theme is designed for from the lightness of its own colors. */
function detectAppearance(foregrounds: Color[], backgrounds: Color[]): ThemeAppearance | undefined {
	const fg = averageLightness(foregrounds);
	const bg = averageLightness(backgrounds);
	if (fg !== undefined && bg !== undefined) return bg < fg ? "dark" : "light";
	if (bg !== undefined) return bg < 0.5 ? "dark" : "light";
	if (fg !== undefined) return fg > 0.5 ? "dark" : "light";
	return undefined;
}

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
	readonly name?: string;
	private mode: TerminalColorMode;
	// Precomputed escape sequences keep fg()/bg() on the render hot path to a lookup and concat.
	private readonly fgAnsi = new Map<ThemeColor, string>();
	private readonly bgAnsi = new Map<ThemeBg, string>();
	// Tokens set to "" have no color of their own; `colors` fills them from the terminal defaults.
	private readonly concreteColors: Partial<Record<ThemeToken, Color>> = {};
	private readonly defaultForegroundTokens: ThemeToken[] = [];
	private readonly defaultBackgroundTokens: ThemeToken[] = [];
	// Foreground tokens rendered faint (SGR 2) on top of their color.
	private readonly dimTokens: ReadonlySet<ThemeColor>;
	private readonly ownAppearance: ThemeAppearance | undefined;
	private resolvedColors: { terminal: TerminalColors; colors: Readonly<Record<ThemeToken, Color>> } | undefined;

	constructor(
		fgColors: Pick<ThemeColorValues<string | number>, ThemeColor>,
		bgColors: Pick<ThemeColorValues<string | number>, ThemeBg>,
		mode: TerminalColorMode,
		options: {
			name?: string;
			appearance?: ThemeAppearance;
			/** Foreground tokens to render faint (SGR 2). */
			dim?: readonly ThemeColor[];
		} = {},
	) {
		this.name = options.name;
		this.mode = mode;
		this.dimTokens = new Set(options.dim);
		const { fgColors: foregrounds, bgColors: backgrounds } = splitThemeColors(
			withThemeTokenFallbacks({ ...fgColors, ...bgColors }),
		);
		const concreteForegrounds: Color[] = [];
		const concreteBackgrounds: Color[] = [];
		// Returns the escape sequence for the token's own slot.
		const addToken = (token: ThemeToken, value: string | number, isBackground: boolean): string => {
			if (value === "") {
				(isBackground ? this.defaultBackgroundTokens : this.defaultForegroundTokens).push(token);
				return isBackground ? "\x1b[49m" : "\x1b[39m";
			}
			const color = parseColor(value);
			this.concreteColors[token] = color;
			(isBackground ? concreteBackgrounds : concreteForegrounds).push(color);
			return isBackground ? backgroundAnsi(color, mode) : foregroundAnsi(color, mode);
		};
		for (const [token, value] of Object.entries(foregrounds) as [ThemeColor, string | number][]) {
			this.fgAnsi.set(token, addToken(token, value, false));
		}
		for (const [token, value] of Object.entries(backgrounds) as [ThemeBg, string | number][]) {
			this.bgAnsi.set(token, addToken(token, value, true));
		}
		this.ownAppearance = options.appearance ?? detectAppearance(concreteForegrounds, concreteBackgrounds);
	}

	/**
	 * The background the theme is designed for: declared at creation, detected from its colors, or, for
	 * themes without usable colors, the terminal's appearance.
	 */
	get appearance(): ThemeAppearance {
		return this.ownAppearance ?? getTerminalTheme();
	}

	/**
	 * Concrete colors for all tokens. Tokens set to "" (terminal default) use the terminal's reported
	 * default colors, or a guess based on `appearance` when the terminal did not report them. Faint
	 * tokens are approximated by mixing their color toward the background.
	 */
	get colors(): Readonly<Record<ThemeToken, Color>> {
		const terminal = terminalColors;
		if (this.resolvedColors?.terminal !== terminal) {
			const guess = GUESSED_DEFAULT_COLORS[this.appearance];
			const toColor = (rgb: RgbColor | undefined, fallback: Color) =>
				rgb ? rgbColor(rgb.r, rgb.g, rgb.b) : fallback;
			const foreground = toColor(terminal.foreground, guess.foreground);
			const background = toColor(terminal.background, guess.background);
			const colors = { ...this.concreteColors };
			for (const token of this.defaultForegroundTokens) colors[token] = foreground;
			for (const token of this.defaultBackgroundTokens) colors[token] = background;
			for (const token of this.dimTokens) {
				const color = colors[token];
				if (color) colors[token] = mixColors(color, background, 0.4);
			}
			this.resolvedColors = { terminal, colors: Object.freeze(colors as Record<ThemeToken, Color>) };
		}
		return this.resolvedColors.colors;
	}

	style(text: string, options: ThemeStyle): string {
		const { fg, bg } = options;
		if (typeof fg === "string" && this.dimTokens.has(fg)) options = { ...options, dim: true };
		return styleTextWithAnsi(
			text,
			fg === undefined
				? undefined
				: typeof fg === "string"
					? this.tokenAnsi(this.fgAnsi, fg)
					: foregroundAnsi(fg, this.mode),
			bg === undefined
				? undefined
				: typeof bg === "string"
					? this.tokenAnsi(this.bgAnsi, bg)
					: backgroundAnsi(bg, this.mode),
			options,
		);
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.tokenAnsi(this.fgAnsi, color);
		if (this.dimTokens.has(color)) return `${ansi}\x1b[2m${text}\x1b[22;39m`;
		return `${ansi}${text}\x1b[39m`;
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.tokenAnsi(this.bgAnsi, color);
		return `${ansi}${text}\x1b[49m`;
	}

	private tokenAnsi<T extends ThemeToken>(ansi: Map<T, string>, token: T): string {
		const value = ansi.get(token);
		if (value === undefined) throw new Error(`Unknown theme color: ${token}`);
		return value;
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	/** Opening escape sequence for a foreground token. Faint tokens include SGR 2, which `\x1b[22m` closes. */
	getFgAnsi(color: ThemeColor): string {
		const ansi = this.tokenAnsi(this.fgAnsi, color);
		return this.dimTokens.has(color) ? `${ansi}\x1b[2m` : ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		return this.tokenAnsi(this.bgAnsi, color);
	}

	getColorMode(): TerminalColorMode {
		return this.mode;
	}

	getThinkingBorderColor(level: ThinkingLevel): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				return (str: string) => this.fg("thinkingMax", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}
}

// ============================================================================
// System Theme
// ============================================================================

function splitThemeColors(colors: ResolvedThemeColorValues<string | number>): {
	fgColors: Record<ThemeColor, string | number>;
	bgColors: Record<ThemeBg, string | number>;
} {
	const fgColors = {} as Record<ThemeColor, string | number>;
	const bgColors = {} as Record<ThemeBg, string | number>;
	for (const [key, value] of Object.entries(colors)) {
		if (THEME_TOKENS[key as ThemeToken].slot === "background") {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return { fgColors, bgColors };
}

/** Generate the system theme from the terminal's reported colors (grayscale while they are pending). */
function createSystemTheme(mode?: TerminalColorMode): Theme {
	const generated = generateSystemThemeColors({
		...terminalColors,
		saturation: terminalColorsPending ? 0 : 1,
		appearanceHint: getTerminalTheme(),
	});
	const { fgColors, bgColors } = splitThemeColors(withThemeTokenFallbacks(generated.colors));
	return new Theme(fgColors, bgColors, mode ?? getTerminalColorMode(), {
		name: SYSTEM_THEME_NAME,
		appearance: generated.appearance,
		dim: generated.dim,
	});
}

export type TerminalTheme = "dark" | "light";

/**
 * Dark or light from the `COLORFGBG` environment variable some terminals set, or undefined without a
 * usable background index. The value is `fg;bg` or `fg;xpm;bg` (rxvt), where a field is an ANSI color
 * index or `default` when the color is not in the palette. The index refers to the terminal's own palette,
 * whose colors are unknown here, so it is classified by index like Vim does: 0-6 and 8 (bright black, e.g.
 * Solarized Dark's background) are dark, 7 and 9-15 are light.
 */
export function detectColorFgBgTheme(env: NodeJS.ProcessEnv = process.env): TerminalTheme | undefined {
	const bg = env.COLORFGBG?.split(";").at(-1)?.trim();
	if (!bg || !/^\d{1,2}$/.test(bg)) return undefined;
	const index = Number(bg);
	if (index > 15) return undefined;
	return index <= 6 || index === 8 ? "dark" : "light";
}

/**
 * Whether the terminal is dark or light. The background it renders decides, classified the same way the
 * system theme does. Without a reported background: the terminal's light/dark report, then COLORFGBG,
 * then dark.
 */
export function detectTerminalTheme(
	colors: TerminalColors = {},
	reportedScheme?: TerminalTheme,
	env: NodeJS.ProcessEnv = process.env,
): TerminalTheme {
	const { background, foreground } = colors;
	if (background) return terminalAppearance(background, foreground);
	return reportedScheme ?? detectColorFgBgTheme(env) ?? "dark";
}

/** Whether the terminal is dark or light, from everything it reported so far. See `detectTerminalTheme()`. */
export function getTerminalTheme(): TerminalTheme {
	return detectTerminalTheme(terminalColors, terminalColorScheme);
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders
const THEME_KEY = Symbol.for("@nanopi/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances see the same theme
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

/**
 * The active theme instance. Regenerating the system theme installs a new instance, so renderers can
 * compare identities to invalidate cached styled output.
 */
export function getThemeInstance(): Theme {
	const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
	if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
	return t;
}

function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

/** Install the system theme. Rendered in grayscale until the terminal reports its colors. */
export function initTheme(): void {
	setGlobalTheme(createSystemTheme());
}

/**
 * Regenerate the system theme from the colors and light/dark reports recorded so far. Installs a new
 * instance, so callers must invalidate cached styled output afterwards. Returns the new instance.
 */
export function refreshSystemTheme(): Theme {
	const next = createSystemTheme();
	setGlobalTheme(next);
	return next;
}

// ============================================================================
// HTML Export Helpers
// ============================================================================

/**
 * Resolved theme colors of the active system theme as CSS-compatible hex strings.
 * Used by HTML export to generate CSS custom properties.
 */
export function getResolvedThemeColors(): Record<string, string> {
	const colors = getThemeInstance().colors;
	return Object.fromEntries(Object.entries(colors).map(([token, color]) => [token, colorToHex(color)]));
}

// ============================================================================
// TUI Helpers
// ============================================================================

type CliHighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		subst: (s: string) => t.fg("text", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string): string[] {
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// Skip highlighting when no valid language is specified. cli-highlight's
	// auto-detection is unreliable and can misidentify prose as AppleScript,
	// LiveCodeServer, etc., coloring random English words as keywords.
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => theme.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			// Validate language before highlighting to avoid stderr spam from cli-highlight
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			// Skip highlighting when no valid language is specified. cli-highlight's
			// auto-detection is unreliable and can misidentify prose as AppleScript,
			// LiveCodeServer, etc., coloring random English words as keywords.
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
		placeholderStyle: (text: string) => theme.fg("muted", text),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
