/**
 * Row budget for interactive list components.
 *
 * Selectors used to hardcode their own row count, so an 8-row list overflowed a
 * short terminal instead of scrolling inside it. The budget keeps a list at its
 * natural height when it fits and shrinks it toward `minRows` when the terminal
 * is short, leaving room for the surrounding chrome.
 */
const MIN_LIST_ROWS = 3;

export interface ListRowBudgetOptions {
	/** Rows the terminal currently has. */
	terminalRows: number;
	/** Rows the surrounding chrome (borders, title, search input, hints) needs. */
	chromeRows: number;
	/** Rows the list would use if the terminal were tall enough. */
	preferredRows: number;
	/** Lower bound; also the floor used when the terminal cannot fit the chrome. */
	minRows?: number;
}

export function listRowBudget(options: ListRowBudgetOptions): number {
	const minRows = Math.max(1, options.minRows ?? MIN_LIST_ROWS);
	return Math.max(minRows, Math.min(options.preferredRows, options.terminalRows - options.chromeRows));
}
