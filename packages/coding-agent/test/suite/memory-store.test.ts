import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { isDuplicate, listEntries, sectionOf, validateEntry } from "../../src/extras/pi-memory/src/parse.ts";
import { buildExtractionPrompt, parseCandidates } from "../../src/extras/pi-memory/src/prompt.ts";
import { applyEntry, otherContextFiles, resolveTarget } from "../../src/extras/pi-memory/src/store.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-memory-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("entry validation", () => {
	test("accepts a rule that names a constraint", () => {
		expect(validateEntry("- Run `pnpm run check` after code changes")).toBeUndefined();
	});

	test("rejects narration of one session", () => {
		expect(validateEntry("- The user asked me to fix the retry logic")).toMatch(/narrates/);
		expect(validateEntry("- this session revealed the cache was stale")).toMatch(/current session/);
	});

	test("rejects an entry too long to be a bullet", () => {
		expect(validateEntry(`- ${"x".repeat(300)}`)).toMatch(/240/);
	});

	test("rejects an empty entry", () => {
		expect(validateEntry("   ")).toMatch(/empty/);
	});
});

describe("duplicate detection", () => {
	const entries = listEntries([
		"## Build",
		"- Run `pnpm run check` after code changes",
		"- The webui build needs dist",
	]);

	test("ignores case, punctuation, and backticks", () => {
		expect(isDuplicate("- run pnpm run check after code changes", entries)).toBe(true);
	});

	test("treats a light rewording as the same entry", () => {
		expect(isDuplicate("- Run pnpm run check after any code change", entries)).toBe(true);
	});

	test("keeps a genuinely different entry", () => {
		expect(isDuplicate("- Never commit to main directly", entries)).toBe(false);
	});
});

describe("entry boundaries", () => {
	test("a bullet owns its indented continuation lines", () => {
		const entries = listEntries(["## Build", "- first", "  continued", "- second"]);
		expect(entries).toHaveLength(2);
		expect(entries[0].text).toBe("- first\n  continued");
		expect(entries[0].end).toBe(2);
	});

	test("a fenced block is content, not structure", () => {
		const entries = listEntries(["```md", "- looks like a bullet", "```"]);
		expect(entries).toEqual([]);
	});

	test("sectionOf returns the owning heading", () => {
		const lines = ["# Title", "", "## Build", "- a bullet"];
		expect(sectionOf(lines, 3)?.title).toBe("Build");
	});
});

describe("applying an entry", () => {
	test("creates the file with a section", () => {
		const file = join(tempDir(), "AGENTS.md");
		const outcome = applyEntry(file, "Run `pnpm run check` after code changes", "Build");
		expect(outcome.status).toBe("added");
		expect(readFileSync(file, "utf-8")).toBe("## Build\n\n- Run `pnpm run check` after code changes\n");
	});

	test("appends under an existing section and keeps the rest of the file", () => {
		const dir = tempDir();
		const file = join(dir, "AGENTS.md");
		writeFileSync(file, "# Repo\n\nIntro text.\n\n## Build\n\n- Existing rule\n\n## Style\n\n- No emojis\n");

		applyEntry(file, "Rebuild the webui before testing a frontend change", "Build");

		const text = readFileSync(file, "utf-8");
		expect(text).toContain("## Build\n\n- Existing rule\n- Rebuild the webui");
		expect(text).toContain("## Style\n\n- No emojis");
		expect(text.startsWith("# Repo\n\nIntro text.\n")).toBe(true);
	});

	test("reports a duplicate instead of writing it again", () => {
		const file = join(tempDir(), "AGENTS.md");
		applyEntry(file, "Never commit to main directly", "Build");
		const before = readFileSync(file, "utf-8");
		expect(applyEntry(file, "never commit to main directly", "Build").status).toBe("duplicate");
		expect(readFileSync(file, "utf-8")).toBe(before);
	});

	test("a Summary section retires the entry it restates", () => {
		const file = join(tempDir(), "AGENTS.md");
		writeFileSync(file, "## Summary\n\n- The build uses tsup\n- The test runner is vitest\n");

		const outcome = applyEntry(file, "The build now uses esbuild", "Summary");

		expect(outcome.status).toBe("added");
		expect(outcome.status === "added" && outcome.replaced).toEqual(["- The build uses tsup"]);
		const text = readFileSync(file, "utf-8");
		expect(text).not.toContain("tsup");
		expect(text).toContain("- The test runner is vitest");
		expect(text).toContain("- The build now uses esbuild");
	});
});

describe("target resolution", () => {
	test("prefers an existing context file over creating AGENTS.md", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "CLAUDE.md"), "# Claude\n");
		expect(resolveTarget(dir)).toEqual({ path: join(dir, "CLAUDE.md"), exists: true });
		expect(otherContextFiles(dir, join(dir, "CLAUDE.md"))).toEqual([]);
	});

	test("falls back to a new AGENTS.md", () => {
		const dir = tempDir();
		expect(resolveTarget(dir)).toEqual({ path: join(dir, "AGENTS.md"), exists: false });
	});
});

describe("extraction prompt", () => {
	test("is skipped for a session that never reached a conclusion", () => {
		expect(
			buildExtractionPrompt({
				userTurns: ["hi"],
				assistantTurns: ["hello"],
				existing: [],
				otherFiles: [],
				rejected: [],
			}),
		).toBeUndefined();
	});

	test("names the existing entries and the declined candidates", () => {
		const prompt = buildExtractionPrompt({
			userTurns: ["one", "two"],
			assistantTurns: ["did one", "did two"],
			existing: listEntries(["- Run pnpm run check"]),
			otherFiles: ["CLAUDE.md"],
			rejected: ["- The repo uses tabs"],
		});
		expect(prompt?.prompt).toContain("- Run pnpm run check");
		expect(prompt?.prompt).toContain("CLAUDE.md");
		expect(prompt?.prompt).toContain("do not propose them again");
	});

	test("leaves tool traffic out of the transcript", () => {
		const prompt = buildExtractionPrompt({
			userTurns: ["rename the constant", "thanks"],
			assistantTurns: ["renamed it"],
			existing: [],
			otherFiles: [],
			rejected: [],
		});
		expect(prompt?.prompt).toContain("[user] rename the constant");
		expect(prompt?.prompt).not.toContain("tool");
	});
});

describe("parsing the model reply", () => {
	test("reads a fenced json block", () => {
		const reply = '```json\n{"candidates":[{"text":"- a","reason":"r","section":"Build"}]}\n```';
		expect(parseCandidates(reply)).toEqual([{ text: "- a", reason: "r", section: "Build" }]);
	});

	test("accepts a bare array of strings", () => {
		expect(parseCandidates('{"candidates":["- a"]}')).toEqual([{ text: "- a" }]);
	});

	test("returns undefined for prose with no json", () => {
		expect(parseCandidates("Nothing worth keeping.")).toBeUndefined();
	});

	test("caps the number of candidates", () => {
		const many = { candidates: Array.from({ length: 9 }, (_v, i) => ({ text: `- ${i}` })) };
		expect(parseCandidates(JSON.stringify(many))).toHaveLength(3);
	});
});
