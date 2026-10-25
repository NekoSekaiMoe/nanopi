/**
 * Per-session record of the file state each `read` returned, so `edit` can tell
 * whether the text it is matching against is still what the model saw.
 *
 * This is not a lock: an edit that still matches is applied even when the file
 * moved underneath, because a warning that blocks correct work costs more than
 * the stale read it prevents. The snapshot only produces a note in the result.
 */

export interface ReadSnapshot {
	mtimeMs: number;
	size: number;
}

const MAX_ENTRIES = 512;
const snapshots = new Map<string, ReadSnapshot>();

export function recordRead(absolutePath: string, snapshot: ReadSnapshot): void {
	// Insertion-ordered: drop the oldest entry once the map outgrows real sessions.
	snapshots.delete(absolutePath);
	snapshots.set(absolutePath, snapshot);
	if (snapshots.size > MAX_ENTRIES) {
		const oldest = snapshots.keys().next();
		if (!oldest.done) snapshots.delete(oldest.value);
	}
}

export function getReadSnapshot(absolutePath: string): ReadSnapshot | undefined {
	return snapshots.get(absolutePath);
}

export function clearReadSnapshot(absolutePath: string): void {
	snapshots.delete(absolutePath);
}

/**
 * Describes how the file changed since it was read, or undefined when the
 * snapshot still matches (or when the file was never read).
 */
export function describeStaleRead(absolutePath: string, current: ReadSnapshot): string | undefined {
	const snapshot = snapshots.get(absolutePath);
	if (!snapshot) return undefined;
	if (snapshot.mtimeMs === current.mtimeMs && snapshot.size === current.size) return undefined;
	return `Note: this file changed on disk after you read it (its size went from ${snapshot.size} to ${current.size} bytes). Re-read it before the next edit so the next oldText matches what is actually there.`;
}
