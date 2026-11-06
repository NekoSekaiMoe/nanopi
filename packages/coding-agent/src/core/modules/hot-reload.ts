/**
 * Watch the module directories and report that something changed.
 *
 * The watcher only says "look again": the loader compares stat keys against the
 * files it actually loaded and decides what to do. That has two wanted
 * consequences:
 *
 * - A file the loader never loaded (a `.d.ts`, a helper next to a module, a
 *   sibling one module imports) costs nothing, because it has no record.
 * - `add`/`change`/`unlink` need no separate handling. Editors disagree about
 *   which one a save produces, and a rename-over-temp save reports `rename`
 *   twice; the reconciliation reads the directory state instead of the events.
 *   (Upstream dsh watches only `'change'`, so a deleted module never unloads.)
 *
 * `fs.watch(recursive)` rather than chokidar: the repository pins exact
 * dependency versions and installs scripts nowhere, so three directories are
 * not worth a new dependency. `utils/fs-watch.ts` already carries the
 * error-and-retry shape the footer's git watcher uses.
 *
 * A directory that does not exist yet (the user-wide `extensions/` on a fresh
 * install) is watched at its nearest existing ancestor, non-recursively, and
 * the watch is re-created at the real path once it appears -- recursive at an
 * ancestor would watch the whole home directory.
 */

import { existsSync, type FSWatcher } from "node:fs";
import { dirname, join, sep } from "node:path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../../utils/fs-watch.ts";
import type { RegisteredModule } from "./types.ts";

/** Coalesce the burst an editor produces when it writes, renames, and chmods. */
export const MODULE_WATCH_DEBOUNCE_MS = 150;

/** The live registry a reconciliation swaps modules into. */
export interface ModuleHotReloadTarget {
	loadModule(module: RegisteredModule): void;
	unloadModule(name: string): Promise<boolean>;
}

interface WatchedDirectory {
	/** The directory or directory handed to `fs.watch`. */
	root: string;
	/** The directory the caller asked for; differs from `root` until it exists. */
	requested: string;
	watcher: FSWatcher;
}

export class ModuleHotReloadWatcher {
	private directories: WatchedDirectory[] = [];
	private debounceTimer: NodeJS.Timeout | undefined;
	private retryTimer: NodeJS.Timeout | undefined;
	private closed = false;
	private readonly onChange: () => void;

	constructor(onChange: () => void) {
		this.onChange = onChange;
	}

	/** Start watching `dirs`. Idempotent per directory. */
	start(dirs: readonly string[]): void {
		if (this.closed) return;
		for (const dir of dirs) {
			if (this.directories.some((entry) => entry.requested === dir)) continue;
			this.watchDirectory(dir);
		}
	}

	close(): void {
		this.closed = true;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.debounceTimer = undefined;
		this.retryTimer = undefined;
		for (const entry of this.directories) closeWatcher(entry.watcher);
		this.directories = [];
	}

	private watchDirectory(requested: string): void {
		const root = nearestExistingDirectory(requested);
		if (root === undefined) {
			this.scheduleRetry();
			return;
		}
		// Recursive only when the watch sits on the directory itself: an ancestor
		// watch would descend into the whole home directory.
		const exact = root === requested;
		const watcher = watchWithErrorHandler(
			root,
			(_eventType, filename) => {
				// A watch on an ancestor sees the whole subtree; only a path under the
				// directory that was asked for is this watcher's business.
				if (filename !== null && !isUnder(requested, join(root, filename.toString()))) return;
				this.scheduleReload();
			},
			() => {
				// The directory can be deleted under us (a `git clean`, a temp dir swept):
				// drop the dead watcher and try again rather than spin on it.
				this.forget(requested);
				this.scheduleRetry();
			},
			exact ? { recursive: true } : undefined,
		);
		if (!watcher) {
			this.scheduleRetry();
			return;
		}
		this.directories.push({ root, requested, watcher });
		if (!exact) this.scheduleRetry();
	}

	private forget(requested: string): void {
		const entry = this.directories.find((candidate) => candidate.requested === requested);
		if (!entry) return;
		closeWatcher(entry.watcher);
		this.directories = this.directories.filter((candidate) => candidate !== entry);
	}

	private scheduleReload(): void {
		if (this.closed) return;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			if (this.closed) return;
			this.onChange();
		}, MODULE_WATCH_DEBOUNCE_MS);
		this.debounceTimer.unref?.();
	}

	/** Re-create watches that landed on an ancestor, and retry ones that failed. */
	private scheduleRetry(): void {
		if (this.closed || this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (this.closed) return;
			const pending = this.directories.filter((entry) => entry.root !== entry.requested).map((e) => e.requested);
			for (const requested of pending) this.forget(requested);
			for (const requested of pending) this.watchDirectory(requested);
		}, FS_WATCH_RETRY_DELAY_MS);
		this.retryTimer.unref?.();
	}
}

function isUnder(parent: string, candidate: string): boolean {
	const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
	return candidate === parent || candidate.startsWith(normalizedParent);
}

/** The directory itself when it exists, else its closest existing ancestor. */
function nearestExistingDirectory(dir: string): string | undefined {
	let current = dir;
	while (true) {
		if (existsSync(current)) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}
