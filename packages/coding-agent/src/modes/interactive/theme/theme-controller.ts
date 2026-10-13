import type { RgbColor, TerminalColors, TUI } from "@nanopi/pi-tui";
import {
	getTerminalTheme,
	initTheme,
	markTerminalColorsPending,
	refreshSystemTheme,
	setTerminalColorScheme,
	setTerminalColors,
	type TerminalTheme,
} from "./theme.ts";

/**
 * How long the system theme stays grayscale before falling back to palette indices. Terminals answer
 * the trailing DA1 request right after the color replies, so this only matters for terminals that
 * answer neither. Replies arriving later still apply.
 */
const TERMINAL_QUERY_TIMEOUT_MS = 100;

/**
 * Query the terminal's colors and pass them to `apply` when the query completes or times out, and again
 * if the terminal answers after the timeout. A failed query applies no colors. Settles after the first apply.
 */
export function requestTerminalColors(ui: TUI, apply: (colors: TerminalColors) => void): Promise<void> {
	let query: Promise<TerminalColors>;
	try {
		query = ui.queryTerminalColors({ timeoutMs: TERMINAL_QUERY_TIMEOUT_MS, onLateReply: apply });
	} catch {
		// Treat a failed query like a terminal that does not report colors.
		query = Promise.resolve({});
	}
	return query.then(apply, () => apply({}));
}

function sameRgb(a: RgbColor | undefined, b: RgbColor | undefined): boolean {
	return a === b || (a !== undefined && b !== undefined && a.r === b.r && a.g === b.g && a.b === b.b);
}

function sameTerminalColors(a: TerminalColors, b: TerminalColors): boolean {
	if (!sameRgb(a.foreground, b.foreground) || !sameRgb(a.background, b.background)) return false;
	if (a.palette === b.palette) return true;
	if (!a.palette || !b.palette || a.palette.length !== b.palette.length) return false;
	return a.palette.every((color, index) => sameRgb(color, b.palette?.[index]));
}

/**
 * Keeps the system theme in sync with the terminal. The theme applies immediately in grayscale, and the
 * terminal's reported colors regenerate it when they arrive. Callers that bake theme colors into content
 * can wait for the colors with `waitForTerminalColors()`.
 */
export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly onChanged: () => void;
	// Last reported colors; a query that times out keeps them instead of erasing them.
	private terminalColors: TerminalColors | undefined;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;
	// Settles when the latest color query completed or timed out, and its colors applied.
	private terminalColorQuery: Promise<void> = Promise.resolve();

	constructor(ui: TUI, options: { onChanged: () => void }) {
		this.ui = ui;
		this.onChanged = options.onChanged;
		// The system theme starts in grayscale; color follows once the terminal reports its colors.
		markTerminalColorsPending();
		initTheme();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(true);
	}

	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(true);
	}

	/**
	 * Query the terminal's colors, which regenerate the system theme when they arrive. The system theme
	 * follows terminal appearance changes on its own.
	 */
	apply(): void {
		this.queryTerminalColors();
	}

	/**
	 * Wait until the latest color query completed or timed out. Content that bakes theme colors into
	 * strings, such as the startup header, should be built after this. Terminals answer the DA1 request
	 * right after the color replies, so this only takes the full timeout when a terminal answers nothing.
	 */
	waitForTerminalColors(): Promise<void> {
		return this.terminalColorQuery;
	}

	getTerminalTheme(): TerminalTheme {
		return getTerminalTheme();
	}

	dispose(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.terminalColorSchemeUnsubscribe = undefined;
		this.ui.setTerminalColorSchemeNotifications(false);
	}

	/** Query the terminal's colors without waiting for them; `waitForTerminalColors()` waits for this query. */
	private queryTerminalColors(): void {
		this.terminalColorQuery = requestTerminalColors(this.ui, (colors) => this.applyTerminalColors(colors));
	}

	/**
	 * Record reported colors: the system theme is generated from them, and light/dark detection uses them.
	 * Re-renders only when they changed.
	 */
	private applyTerminalColors(reported: TerminalColors): void {
		const previous = this.terminalColors;
		const next: TerminalColors = {
			foreground: reported.foreground ?? previous?.foreground,
			background: reported.background ?? previous?.background,
			palette: reported.palette ?? previous?.palette,
		};
		// Re-rendering rebuilds every component, so skip it when nothing changed (including timeouts).
		if (previous && sameTerminalColors(previous, next)) return;
		this.terminalColors = next;
		setTerminalColors(next);
		this.reapplyForTerminal();
		this.ui.invalidate();
		this.ui.requestRender();
	}

	/** Regenerate the system theme from the colors recorded so far. */
	private reapplyForTerminal(): void {
		refreshSystemTheme();
		this.onChanged();
	}

	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			this.applyTerminalColorSchemeChange(terminalTheme),
		);
	}

	/**
	 * The terminal reported a light/dark switch. Its colors changed too, so query them again: they decide
	 * the appearance. The reported scheme only matters for terminals that do not report their background.
	 */
	private applyTerminalColorSchemeChange(terminalTheme: TerminalTheme): void {
		const previous = getTerminalTheme();
		setTerminalColorScheme(terminalTheme);
		if (getTerminalTheme() !== previous) this.reapplyForTerminal();
		this.queryTerminalColors();
	}
}
