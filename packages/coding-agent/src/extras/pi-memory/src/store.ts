/**
 * Where memory lives: the project's AGENTS.md, or a new section appended to it.
 *
 * The file is normally already in the system prompt, so an entry is worth
 * writing only if it will not simply restate what is there. Dedupe runs against
 * the bullets already in the destination section, and a write preserves every
 * line it does not own.
 *
 * Every bullet written here carries a `(kept YYYY-MM-DD)` stamp, and every write
 * refreshes the stamp of the other bullets in the same section. The age of a
 * section is therefore the age of its oldest commit since anyone last touched
 * it, while the bullet that was rewritten loses its "old" marking — a property
 * no per-line annotation can give, because annotations get deleted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	isDuplicate,
	isSummarySection,
	listEntries,
	type MemoryEntry,
	renderEntry,
	restamp,
	sectionOf,
	sectionRange,
	toBullet,
	validateEntry,
} from "./parse.ts";

/** Upstream's context-file names, in the order the loader prefers them. */
const CONTEXT_FILES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** The section a new entry is appended to when the caller does not name one. */
const DEFAULT_SECTION = "Project Notes";

export interface MemoryTarget {
	path: string;
	/** False when the file does not exist yet and would be created. */
	exists: boolean;
}

export interface MemoryFileEntry extends MemoryEntry {
	/** The heading the bullet sits under, or undefined at file level. */
	section: string | undefined;
}

/** The context file the session would load for `cwd`, or the one to create. */
export function resolveTarget(cwd: string): MemoryTarget {
	for (const name of CONTEXT_FILES) {
		const path = join(cwd, name);
		if (existsSync(path)) return { path, exists: true };
	}
	return { path: join(cwd, "AGENTS.md"), exists: false };
}

/** The other context files the loader would also read, so a write cannot contradict one silently. */
export function otherContextFiles(cwd: string, target: string): string[] {
	return CONTEXT_FILES.map((name) => join(cwd, name)).filter((path) => path !== target && existsSync(path));
}

export function readText(path: string): string {
	return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/** Every bullet in the file with the heading that owns it, in file order. */
export function readEntries(file: string): MemoryFileEntry[] {
	const lines = readText(file).split("\n");
	return listEntries(lines).map((entry) => ({ ...entry, section: sectionOf(lines, entry.start)?.title }));
}

/** A section's bullets, cheapest possible cleanup: the whole heading goes away with them. */
export interface DroppedSection {
	title: string;
	entries: number;
	/** 0-based line range of the heading block. */
	start: number;
	end: number;
}

export type ApplyOutcome =
	| { status: "added"; file: string; section: string; replaced: string[] }
	| { status: "duplicate"; file: string };

/**
 * Write one entry into `file` and report what changed.
 *
 * An explicit `section` appends under that heading, creating it when absent. A
 * call without one appends to the section that already holds bullets, so a
 * one-line `/remember` does not start a competing section next to `## Build`.
 *
 * Bullets in the destination section decide the duplicate verdict; a bullet
 * elsewhere in the file only counts when it says the same thing word for word,
 * because another section is a different topic that may legitimately overlap.
 * A section titled "Summary" is the one place an entry retires its
 * predecessors: those bullets describe current state, so a newer note about the
 * same subject replaces the older one.
 */
export function applyEntry(file: string, entry: string, requested?: string, today?: Date): ApplyOutcome {
	const invalid = validateEntry(entry);
	if (invalid) throw new Error(invalid);
	const day = today ?? new Date();

	const existing = readText(file);
	let lines = existing.length > 0 ? existing.split("\n") : [];
	const section = requested ?? defaultSection(lines);
	const heading = findSection(lines, section);
	const elsewhere = listEntries(lines).filter((item) => {
		const owner = sectionOf(lines, item.start);
		return owner?.title.toLowerCase() !== section.toLowerCase();
	});
	if (elsewhere.some((item) => normalizeEntry(item.text) === normalizeEntry(toBullet(entry)))) {
		return { status: "duplicate", file };
	}
	const replaced: string[] = [];
	let insertAt: number;

	if (heading === undefined) {
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
		lines = lines.length > 0 ? [...lines, "", `## ${section}`, ""] : [`## ${section}`, ""];
		insertAt = lines.length;
	} else {
		insertAt = sectionEnd(lines, heading);
		const inSection = listEntries(lines.slice(heading + 1, insertAt)).map((item) => ({
			...item,
			start: item.start + heading + 1,
			end: item.end + heading + 1,
		}));
		if (isSummarySection(section)) {
			// Retire first: an entry that restates an older one is the replacement,
			// not a duplicate of it.
			const stale: MemoryEntry[] = inSection.filter((item) => isDuplicate(entry, [item]));
			replaced.push(...stale.map((item) => item.body));
			lines = removeLines(lines, stale);
			insertAt = sectionEnd(lines, heading);
		} else if (isDuplicate(entry, inSection)) {
			return { status: "duplicate", file };
		}
	}

	const bullet = renderEntry(entry, dayText(day));
	const before = lines.slice(0, insertAt);
	const after = lines.slice(insertAt);
	// Keep a blank line between the new bullet and whatever follows it.
	const gap = after.length === 0 || after[0].trim() === "" ? [] : [""];
	const next = [...before, ...bullet.split("\n"), ...gap, ...after];
	writeFileSync(
		file,
		`${refreshStamps(next, new Set([section]), dayText(day)).join("\n").replace(/\n+$/, "")}\n`,
		"utf-8",
	);
	return { status: "added", file, section, replaced };
}

/**
 * Refresh the stamps of every section `touch` appeared in.
 *
 * Ignoring a bullet has to mean something: without this, an entry can only be
 * re-confirmed by being repeated, and `/remember` refuses repeats. A user who
 * accepts a candidate because it is still true, or who declines one because it
 * never was, is saying the section was read today.
 */
export function touchSections(file: string, titles: Iterable<string>, today?: Date): string[] {
	const day = dayText(today ?? new Date());
	const text = readText(file);
	if (!text) return [];
	const before = text.replace(/\n$/, "");
	const after = refreshStamps(text.split("\n"), new Set(titles), day).join("\n").replace(/\n+$/, "");
	if (after === before || after.length === 0) return [];
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${after}\n`, "utf-8");
	return [...new Set(titles)];
}

export interface RemoveOutcome {
	removed: MemoryFileEntry[];
	/** Headings whose last bullet was removed, and that are now empty. */
	section: DroppedSection | undefined;
}

/**
 * Delete matched bullets. A bare section that had bullets and now has none is
 * deleted with its heading: an empty heading is a reminder that memory *was*
 * there, which costs a line and says nothing.
 */
export function removeEntries(file: string, match: (entry: MemoryFileEntry) => boolean): RemoveOutcome {
	const lines = readText(file).split("\n");
	const owned = readEntries(file);
	const drop = owned.filter((entry) => match(entry));
	if (drop.length === 0) return { removed: [], section: undefined };

	let next = removeLines(lines, drop);
	let section: DroppedSection | undefined;
	const titles = [...new Set(drop.map((entry) => entry.section).filter((title) => title !== undefined))];
	if (titles.length === 1 && titles[0] !== undefined) {
		const title = titles[0];
		const range = sectionRange(next, title);
		if (range && listEntries(next.slice(range.start + 1, range.end)).length === 0) {
			next = [...next.slice(0, range.start), ...next.slice(range.end)];
			// A removal that left two blank lines in a row leaves one.
			next = next.filter((line, index) => !(line.trim() === "" && index > 0 && next[index - 1].trim() === ""));
			section = { title, entries: drop.length, start: range.start, end: range.end };
		}
	}
	writeFileSync(file, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf-8");
	return { removed: drop, section };
}

/**
 * Restamp every bullet that lives in one of `titles`.
 *
 * Two passes: replace each bullet's own lines first, then rebuild the file one
 * line at a time. Line indices stay valid because every replacement happens
 * inside the range it was measured in.
 */
function refreshStamps(lines: readonly string[], titles: ReadonlySet<string>, day: string): string[] {
	if (titles.size === 0) return [...lines];
	const wanted = new Set([...titles].map((title) => title.trim().toLowerCase()));
	const restamps = new Map<number, string[]>();
	for (const entry of listEntries(lines)) {
		const owner = sectionOf(lines, entry.start);
		if (!owner || !wanted.has(owner.title.trim().toLowerCase())) continue;
		const stamped = restamp(entry, day);
		if (stamped === entry.text) continue;
		stamped.split("\n").forEach((line, offset) => restamps.set(entry.start + offset, [line]));
	}
	if (restamps.size === 0) return [...lines];
	return lines.map((line, index) => restamps.get(index)?.[0] ?? line);
}

function dayText(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The section a one-line entry belongs to: the first that holds bullets, else the default. */
function defaultSection(lines: readonly string[]): string {
	const entries = listEntries(lines);
	for (const entry of entries) {
		const owner = sectionOf(lines, entry.start);
		if (owner) return owner.title;
	}
	return DEFAULT_SECTION;
}

function normalizeEntry(text: string): string {
	return text
		.toLowerCase()
		.replace(/\(kept \d{4}-\d{2}-\d{2}\)\s*$/, "")
		.replace(/^[-*]\s+/, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function findSection(lines: readonly string[], title: string): number | undefined {
	const wanted = title.trim().toLowerCase();
	for (let index = 0; index < lines.length; index++) {
		const match = /^#{1,6}\s+(.*)$/.exec(lines[index]);
		if (match && match[1].trim().toLowerCase() === wanted) return index;
	}
	return undefined;
}

/** Line index just past the last non-blank line of the section starting at `heading`. */
function sectionEnd(lines: readonly string[], heading: number): number {
	let end = heading + 1;
	let last = heading;
	for (; end < lines.length; end++) {
		if (/^#{1,6}\s+/.test(lines[end])) break;
		if (lines[end].trim() !== "") last = end;
	}
	return last + 1;
}

/** Drop whole entries, keeping every line the caller does not own. */
function removeLines(lines: readonly string[], drop: readonly { start: number; end: number }[]): string[] {
	const remove = new Set<number>();
	for (const { start, end } of drop) {
		for (let index = start; index <= end; index++) remove.add(index);
	}
	return lines.filter((_line, index) => !remove.has(index));
}
