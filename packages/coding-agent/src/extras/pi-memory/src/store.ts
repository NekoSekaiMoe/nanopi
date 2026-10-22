/**
 * Where memory lives: the project's AGENTS.md, or a new section appended to it.
 *
 * The file is normally already in the system prompt, so an entry is worth
 * writing only if it will not simply restate what is there. Dedupe runs against
 * the bullets already in the destination section, and a write preserves every
 * line it does not own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	isDuplicate,
	isSummarySection,
	listEntries,
	type MemoryEntry,
	sectionOf,
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
export function applyEntry(file: string, entry: string, requested?: string): ApplyOutcome {
	const invalid = validateEntry(entry);
	if (invalid) throw new Error(invalid);

	const existing = readText(file);
	let lines = existing.length > 0 ? existing.split("\n") : [];
	const section = requested ?? defaultSection(lines);
	const heading = findSection(lines, section);
	const elsewhere = listEntries(lines).filter((item) => {
		const owner = sectionOf(lines, item.start);
		return owner?.title.toLowerCase() !== section.toLowerCase();
	});
	if (elsewhere.some((item) => normalizeEntry(item.text) === normalizeEntry(entry))) {
		return { status: "duplicate", file };
	}
	const bullet = toBullet(entry);
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
			const stale: MemoryEntry[] = inSection.filter((item) => isDuplicate(bullet, [item]));
			replaced.push(...stale.map((item) => item.text));
			lines = removeEntries(lines, stale);
			insertAt = sectionEnd(lines, heading);
		} else if (isDuplicate(entry, inSection)) {
			return { status: "duplicate", file };
		}
	}

	const before = lines.slice(0, insertAt);
	const after = lines.slice(insertAt);
	// Keep a blank line between the new bullet and whatever follows it.
	const gap = after.length === 0 || after[0].trim() === "" ? [] : [""];
	const next = [...before, ...bullet.split("\n"), ...gap, ...after];
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf-8");
	return { status: "added", file, section, replaced };
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
function removeEntries(lines: readonly string[], drop: readonly { start: number; end: number }[]): string[] {
	const remove = new Set<number>();
	for (const { start, end } of drop) {
		for (let index = start; index <= end; index++) remove.add(index);
	}
	return lines.filter((_line, index) => !remove.has(index));
}
