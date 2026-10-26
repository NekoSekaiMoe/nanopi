/**
 * Shared paging rules for scrollable lists and dialogs.
 *
 * Every list in nanopi used to repeat the same three decisions: how far PgUp/PgDn
 * moves, where the selection lands when it runs past the ends, and which slice of
 * the list stays on screen. The algorithms were byte-identical but the key handling
 * was not, so PgUp worked in some popups and vanished in others. Keeping the rules
 * here means a list that calls them cannot drift.
 *
 * Two kinds of cursor share these rules, and their page sizes differ:
 *
 * - A selection (a highlighted row) can never sit off screen, so a page is one
 *   window and `pageStep()` uses the window size: `SelectList` with 10 visible rows
 *   turns "index 2" into "index 12".
 * - A scroll offset is already the first visible row, so the window that follows
 *   it is `page - 1` rows below it (`/status`, `/context` previews). Paging by the
 *   full window there skips one row per page.
 */

/** Default rows moved by one PgUp/PgDn when the caller has no visible-row count. */
const DEFAULT_PAGE_STEP = 10;

export interface PageSelectionOptions {
	/** Rows on screen; the size of one page. `pageStep()` falls back to 10 when this is < 1. */
	pageSize: number;
	/**
	 * Selection wraps between the last and the first item instead of stopping at the
	 * ends. Only lists whose ↑/↓ already wrap should set this; a scroll offset clamps.
	 */
	wrap: boolean;
}

/** Selection reached by PgUp (`direction` < 0) or PgDn (`direction` > 0) from `selectedIndex`. */
export function pageStep(
	selectedIndex: number,
	itemCount: number,
	direction: -1 | 1,
	options: PageSelectionOptions,
): number {
	const size = pageSizeOf(options.pageSize);
	const last = itemCount - 1;
	if (last < 0) return 0;
	const current = clamp(selectedIndex, 0, last);
	if (options.wrap) return (current + direction * size + itemCount) % itemCount;
	return clamp(current + direction * size, 0, last);
}

/**
 * Scroll offset reached by PgUp/PgDn from `offset`. One page of a scroll view leaves
 * the last visible row as the new first row, so the step is `pageSize - 1` — the
 * follow-up `clampScrollOffset()` then lands the final page flush with the end.
 */
export function pageScrollOffset(offset: number, totalLines: number, pageSize: number, direction: -1 | 1): number {
	const step = Math.max(1, pageSizeOf(pageSize) - 1);
	return clampScrollOffset(offset + direction * step, totalLines, pageSize);
}

/** First visible index for a window of `pageSize` rows centered on `selectedIndex`. */
export function windowStart(selectedIndex: number, itemCount: number, pageSize: number): number {
	const size = pageSizeOf(pageSize);
	return Math.max(0, Math.min(selectedIndex - Math.floor(size / 2), itemCount - size));
}

/** Clamp a scroll offset so the last page still fills the viewport. */
export function clampScrollOffset(offset: number, totalLines: number, pageSize: number): number {
	return Math.max(0, Math.min(offset, Math.max(0, totalLines - pageSizeOf(pageSize))));
}

function pageSizeOf(pageSize: number): number {
	return pageSize >= 1 ? Math.floor(pageSize) : DEFAULT_PAGE_STEP;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
