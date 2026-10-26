/**
 * Shared paging rules for scrollable lists and dialogs.
 *
 * Every list in nanopi used to repeat the same three decisions: how far PgUp/PgDn
 * moves, where the selection lands when it runs past the ends, and which slice of
 * the list stays on screen. The algorithms were byte-identical but the key handling
 * was not, so PgUp worked in some popups and vanished in others. Keeping the rules
 * here means a list that calls them cannot drift.
 */

/** Default rows moved by one PgUp/PgDn when the caller has no visible-row count. */
const DEFAULT_PAGE_STEP = 10;

export interface PageSelectionOptions {
	/** Rows (or items) on screen; the size of one page. `pageStep()` falls back to 10 when this is < 1. */
	pageSize: number;
	/** Selection wraps between the last and the first item instead of stopping at the ends. */
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
