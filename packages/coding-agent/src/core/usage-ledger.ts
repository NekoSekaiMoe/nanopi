/**
 * Cross-session usage totals for `/status`.
 *
 * Every session file is already a JSONL of `SessionEntry` records, so the
 * ledger is a second read of the files that sit next to the current one: same
 * parser, same attribution rules as `getUsageCostBreakdown`, no second
 * database. Session files reach hundreds of megabytes over a few months, so a
 * pass only stats every file and re-parses the ones whose size or modification
 * time moved since the previous pass.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadEntriesFromFile } from "./session-manager.ts";
import type { SessionEntry } from "./session-store.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "./usage-totals.ts";

/** Session files parsed per batch; a parse is synchronous, so batches are what keep the TUI responsive. */
const PARSE_BATCH_SIZE = 8;

interface LedgerFileRecord {
	totals: UsageTotals;
	/** Assistant messages that reported usage: the denominator of the cache hit rate. */
	responses: number;
	models: Set<string>;
}

export interface UsageLedgerTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** `usage.cost.total` as recorded when each response was written, i.e. the historical price. */
	cost: number;
	/** Files whose responses reported cache activity in either direction. */
	reportedCacheFiles: number;
	/** Distinct `provider/model` pairs seen in any session. */
	models: number;
	/** Assistant messages that reported usage. */
	responses: number;
}

export interface UsageLedger {
	/** Start time of the newest session, or null when there is none. */
	updatedAt: number | null;
	files: number;
	totals: UsageLedgerTotals;
}

function emptyTotals(): UsageLedgerTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		reportedCacheFiles: 0,
		models: 0,
		responses: 0,
	};
}

/**
 * Fold one session file into a record. Token attribution matches
 * `getUsageCostBreakdown` so the model count reconciles with the per-model
 * breakdown `/session` prints.
 */
function summarize(entries: SessionEntry[]): LedgerFileRecord {
	const totals = createUsageTotals();
	const models = new Set<string>();
	let responses = 0;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			models.add(`${message.provider}/${message.responseModel ?? message.model}`);
			responses++;
			addUsageToTotals(totals, message.usage);
		} else if (entry.type === "usage") {
			models.add(`${entry.provider}/${entry.model}`);
			addUsageToTotals(totals, entry.usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			addUsageToTotals(totals, entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(totals, entry.usage);
		}
	}

	return { totals, responses, models };
}

interface SessionFileStamp {
	path: string;
	size: number;
	mtimeMs: number;
}

/** Session files one level below `dir` (`<dir>/<encoded-cwd>/*.jsonl`) with their stamps. */
function listSessionFiles(dir: string): SessionFileStamp[] {
	const files: SessionFileStamp[] = [];
	let projects: string[];
	try {
		projects = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(dir, entry.name));
	} catch {
		// No sessions directory yet: a fresh install is an empty ledger, not an error.
		return files;
	}

	for (const project of projects) {
		let names: string[];
		try {
			names = readdirSync(project).filter((name) => name.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(project, name);
			try {
				const stats = statSync(path);
				files.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
			} catch {
				// Removed between the listing and the stat.
			}
		}
	}
	return files;
}

/**
 * Session start time from the file name, which `SessionManager` stamps with the
 * header timestamp (`2026-11-11T16-02-19-042Z_<id>.jsonl`). The header itself is
 * not kept by `loadEntriesFromFile`, and the mtime says only when the file was
 * last written.
 */
function sessionStartFromName(path: string): number | null {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(basename(path));
	if (!match) return null;
	const [, date, hour, minute, second, millisecond] = match;
	const parsed = Date.parse(`${date}T${hour}:${minute}:${second}.${millisecond}Z`);
	return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Index over every session file. `refresh()` walks the filesystem and re-parses
 * what changed; `totals()` only folds the per-file records.
 */
export class UsageLedgerIndex {
	private readonly records = new Map<string, LedgerFileRecord>();
	/** Stamp each record was parsed at. A file written during a parse bumps it and stays stale. */
	private readonly parsed = new Map<string, { size: number; mtimeMs: number }>();
	private latestMtime = 0;
	private latestStart: number | null = null;

	/**
	 * Re-parse the files whose stamp moved and drop the ones that vanished.
	 * Parses run in batches with an event-loop turn in between: one large session
	 * file is already tens of milliseconds of synchronous JSON work.
	 */
	async refresh(dir: string, signal?: AbortSignal): Promise<void> {
		const files = listSessionFiles(dir);
		signal?.throwIfAborted();

		const seen = new Set(files.map((file) => file.path));
		for (const path of [...this.records.keys()]) {
			if (!seen.has(path)) {
				this.records.delete(path);
				this.parsed.delete(path);
			}
		}

		this.latestMtime = 0;
		this.latestStart = null;
		for (const file of files) {
			if (file.mtimeMs > this.latestMtime) this.latestMtime = file.mtimeMs;
			const start = sessionStartFromName(file.path);
			if (start !== null && (this.latestStart === null || start > this.latestStart)) this.latestStart = start;
		}

		const stale = files.filter((file) => {
			const stamp = this.parsed.get(file.path);
			return !stamp || stamp.size !== file.size || stamp.mtimeMs !== file.mtimeMs;
		});

		for (let offset = 0; offset < stale.length; offset += PARSE_BATCH_SIZE) {
			signal?.throwIfAborted();
			for (const file of stale.slice(offset, offset + PARSE_BATCH_SIZE)) {
				const entries = loadEntriesFromFile(file.path).filter((entry): entry is SessionEntry => {
					return entry.type !== "session";
				});
				this.records.set(file.path, summarize(entries));
				this.parsed.set(file.path, { size: file.size, mtimeMs: file.mtimeMs });
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	/** Totals over every indexed file: one folded record per file, no re-parse. */
	totals(): UsageLedger {
		const totals = emptyTotals();
		const models = new Set<string>();
		for (const record of this.records.values()) {
			totals.input += record.totals.input;
			totals.output += record.totals.output;
			totals.cacheRead += record.totals.cacheRead;
			totals.cacheWrite += record.totals.cacheWrite;
			totals.cost += record.totals.cost;
			totals.responses += record.responses;
			if (record.totals.cacheRead > 0 || record.totals.cacheWrite > 0) totals.reportedCacheFiles++;
			for (const model of record.models) models.add(model);
		}
		totals.models = models.size;
		const updatedAt = this.latestStart ?? (this.latestMtime > 0 ? this.latestMtime : null);
		return { updatedAt, files: this.records.size, totals };
	}
}
