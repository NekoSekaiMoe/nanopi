/**
 * How old is an entry, and does it still describe the tree?
 *
 * Two questions, two sources. "How old" comes from the stamp pi-memory writes
 * inside the bullet, because that is the only thing that survives a rebase, a
 * squash, and a shallow clone. "Does it still hold" can only be guessed from
 * what the entry mentions: a bullet that names a path which no longer exists is
 * the cheapest measurable kind of stale.
 *
 * The blame fallback exists for the file as it was before stamps: an unstamped
 * bullet has no age of its own, so the file's commits stand in for the whole
 * section. It is deliberately allowed to fail — without git, or without history,
 * age is simply unknown, which is not the same as fresh.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { ageInDays, type MemoryEntry, stripStamp } from "./parse.ts";

/** A bullet older than this is a candidate for `/remember --prune`. */
export const STALE_DAYS = 180;
/** Above this count `/remember` asks for a cleanup before adding more. */
export const SOFT_LIMIT = 80;

/** Longest a path probe may take before it is treated as unrelated to the tree. */
const GIT_TIMEOUT_MS = 3000;

export interface StaleCandidate {
	entry: MemoryEntry;
	/** "aged" is a guess from the clock, "missing" is proof from the tree. */
	reason: "aged" | "missing";
	days?: number;
	paths: string[];
}

/** Paths a bullet names that no longer exist under `cwd`. */
export function missingPaths(cwd: string, entry: MemoryEntry): string[] {
	const found = new Set<string>();
	for (const match of stripStamp(entry).matchAll(/`([^`\n]+)`/g)) {
		const raw = match[1].trim().replace(/^\.\//, "");
		if (!looksLikePath(raw)) continue;
		if (existsSync(join(cwd, raw))) continue;
		found.add(raw);
	}
	return [...found];
}

/**
 * Only a bare path qualifies. A token with a space, a flag, or a substitution
 * is a command or prose, and "the file `pnpm run check` is missing" would be a
 * false accusation.
 */
function looksLikePath(token: string): boolean {
	if (token.includes(" ")) return false;
	if (!/[./]/.test(token)) return false;
	if (token.startsWith("http") || token.startsWith("$") || token.startsWith("-")) return false;
	return /^[\w.@~+/-]+$/.test(token);
}

export interface StaleInput {
	cwd: string;
	entries: readonly MemoryEntry[];
	now: Date;
	/** Ages of unstamped bullets, from `blameDays`. Absent means age is unknown. */
	blameDays?: ReadonlyMap<string, string>;
}

/**
 * Entries worth asking about, worst first: proven-missing paths, then entries
 * stamped longer ago than `STALE_DAYS`.
 */
export function staleCandidates(input: StaleInput): StaleCandidate[] {
	const out: StaleCandidate[] = [];
	for (const entry of input.entries) {
		const paths = missingPaths(input.cwd, entry);
		if (paths.length > 0) {
			out.push({ entry, reason: "missing", paths });
			continue;
		}
		const day = entry.kept ?? input.blameDays?.get(entry.text);
		if (!day) continue;
		const days = ageInDays(day, input.now);
		if (days >= STALE_DAYS) out.push({ entry, reason: "aged", days, paths: [] });
	}
	return out;
}

/**
 * Commit day for each bullet of `file`, keyed by the bullet's text.
 *
 * `--porcelain` emits a header per group of consecutive lines, then metadata,
 * then the content lines prefixed with a tab. A repeat header (`<sha> <orig>
 * <final>`) carries no metadata, so the commit time is remembered per sha rather
 * than reset per header. The day is the author time: a rebase changes the
 * committer date of every line, which would make the whole file look new.
 *
 * Returns an empty map whenever git cannot answer, and never throws.
 */
export async function blameDays(
	file: string,
	entries: readonly MemoryEntry[],
	cwd: string,
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	if (entries.length === 0) return result;
	const days = await runGit(cwd, ["blame", "--porcelain", "--", relative(cwd, file)]);
	if (!days) return result;
	const starts = new Map(entries.map((entry) => [entry.start + 1, entry.text]));
	const times = new Map<string, string>();
	let sha: string | undefined;
	let line = 0;
	let current: string | undefined;
	for (const raw of days.split("\n")) {
		const header = /^([0-9a-f]{4,}) \d+ (\d+)(?: \d+)?$/.exec(raw);
		if (header) {
			sha = header[1];
			line = Number(header[2]);
			current = times.get(sha);
			continue;
		}
		const time = /^author-time (\d+)$/.exec(raw);
		if (time) {
			current = dayOfSeconds(Number(time[1]));
			if (sha) times.set(sha, current);
			continue;
		}
		if (!raw.startsWith("\t") || !current) continue;
		// Only the bullet's first line decides its age.
		const text = starts.get(line);
		if (text !== undefined) result.set(text, current);
	}
	return result;
}

function dayOfSeconds(seconds: number): string {
	const date = new Date(seconds * 1000);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function runGit(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			finish(undefined);
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, GIT_TIMEOUT_MS);
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.on("error", () => {
			clearTimeout(timer);
			finish(undefined);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish(code === 0 ? stdout : undefined);
		});
	});
}
