import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { blameDays, missingPaths, staleCandidates } from "../../src/extras/pi-memory/src/freshness.ts";
import {
	ageInDays,
	isDuplicate,
	listEntries,
	renderEntry,
	sectionOf,
	validateEntry,
} from "../../src/extras/pi-memory/src/parse.ts";
import { buildExtractionPrompt, parseCandidates } from "../../src/extras/pi-memory/src/prompt.ts";
import {
	applyEntry,
	otherContextFiles,
	readEntries,
	removeEntries,
	resolveTarget,
	touchSections,
} from "../../src/extras/pi-memory/src/store.ts";

/** A fixed day, so a stamped assertion does not depend on when it runs. */
const TODAY = new Date(2026, 4, 1);
const STAMP = "(kept 2026-05-01)";

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
		const outcome = applyEntry(file, "Run `pnpm run check` after code changes", "Build", TODAY);
		expect(outcome.status).toBe("added");
		expect(readFileSync(file, "utf-8")).toBe(`## Build\n\n- Run \`pnpm run check\` after code changes ${STAMP}\n`);
	});

	test("appends under an existing section and keeps the rest of the file", () => {
		const dir = tempDir();
		const file = join(dir, "AGENTS.md");
		writeFileSync(file, "# Repo\n\nIntro text.\n\n## Build\n\n- Existing rule\n\n## Style\n\n- No emojis\n");

		applyEntry(file, "Rebuild the webui before testing a frontend change", "Build", TODAY);

		const text = readFileSync(file, "utf-8");
		expect(text).toContain(`- Existing rule ${STAMP}\n- Rebuild the webui before testing a frontend change ${STAMP}`);
		expect(text).toContain("## Style\n\n- No emojis");
		expect(text.startsWith("# Repo\n\nIntro text.\n")).toBe(true);
	});

	test("reports a duplicate instead of writing it again", () => {
		const file = join(tempDir(), "AGENTS.md");
		applyEntry(file, "Never commit to main directly", "Build", TODAY);
		const before = readFileSync(file, "utf-8");
		expect(applyEntry(file, "never commit to main directly", "Build", TODAY).status).toBe("duplicate");
		expect(readFileSync(file, "utf-8")).toBe(before);
	});

	test("a Summary section retires the entry it restates", () => {
		const file = join(tempDir(), "AGENTS.md");
		writeFileSync(file, "## Summary\n\n- The build uses tsup\n- The test runner is vitest\n");

		const outcome = applyEntry(file, "The build now uses esbuild", "Summary", TODAY);

		expect(outcome.status).toBe("added");
		expect(outcome.status === "added" && outcome.replaced).toEqual(["- The build uses tsup"]);
		const text = readFileSync(file, "utf-8");
		expect(text).not.toContain("tsup");
		expect(text).toContain("- The test runner is vitest");
		expect(text).toContain(`- The build now uses esbuild ${STAMP}`);
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
		expect(parseCandidates(reply)).toEqual({
			candidates: [{ text: "- a", reason: "r", section: "Build" }],
			stale: [],
		});
	});

	test("accepts a bare array of strings", () => {
		expect(parseCandidates('{"candidates":["- a"]}')).toEqual({ candidates: [{ text: "- a" }], stale: [] });
	});

	test("returns undefined for prose with no json", () => {
		expect(parseCandidates("Nothing worth keeping.")).toBeUndefined();
	});

	test("caps the number of candidates", () => {
		const many = { candidates: Array.from({ length: 9 }, (_v, i) => ({ text: `- ${i}` })) };
		expect(parseCandidates(JSON.stringify(many))?.candidates).toHaveLength(3);
	});

	test("reads the entries the model says are out of date", () => {
		const reply = JSON.stringify({
			candidates: [],
			stale: [{ text: "- The build uses tsup", reason: "the tree builds with esbuild now" }],
		});
		expect(parseCandidates(reply)?.stale).toEqual([
			{ text: "- The build uses tsup", reason: "the tree builds with esbuild now" },
		]);
	});

	test("a reply without a stale list still parses", () => {
		expect(parseCandidates('{"candidates":[]}')?.stale).toEqual([]);
	});
});

describe("age stamps", () => {
	test("an entry is written with the day it was kept", () => {
		const file = join(tempDir(), "AGENTS.md");
		applyEntry(file, "Never commit to main directly", "Build", TODAY);
		expect(readFileSync(file, "utf-8")).toContain("- Never commit to main directly (kept 2026-05-01)");
	});

	test("the stamp is stripped before the text is compared", () => {
		const entry = listEntries(["## Build", "- Run `pnpm run check` after code changes (kept 2026-01-02)"])[0];
		expect(entry.body).toBe("- Run `pnpm run check` after code changes");
		expect(entry.kept).toBe("2026-01-02");
		expect(isDuplicate("- run pnpm run check after any code change", [entry])).toBe(true);
	});

	test("a nearby write restamps the section and leaves other sections alone", () => {
		const file = join(tempDir(), "AGENTS.md");
		writeFileSync(file, "## Build\n\n- Old rule (kept 2025-01-01)\n\n## Style\n\n- No emojis (kept 2025-01-01)\n");
		applyEntry(file, "Rebuild the webui before testing a frontend change", "Build", TODAY);
		const text = readFileSync(file, "utf-8");
		expect(text).toContain("- Old rule (kept 2026-05-01)");
		expect(text).toContain("- Rebuild the webui before testing a frontend change (kept 2026-05-01)");
		expect(text).toContain("- No emojis (kept 2025-01-01)");
	});

	test("reading a section without a write still refreshes its ages", () => {
		const file = join(tempDir(), "AGENTS.md");
		writeFileSync(file, "## Build\n\n- Old rule (kept 2025-01-01)\n");
		expect(touchSections(file, ["build"], TODAY)).toEqual(["build"]);
		expect(readFileSync(file, "utf-8")).toContain("- Old rule (kept 2026-05-01)");
	});

	test("a hand-written stamp that does not parse is refused", () => {
		expect(validateEntry("- Run the build (kept last tuesday)")).toMatch(/malformed/);
		expect(validateEntry("- Run the build (kept 2026-05-01)")).toBeUndefined();
	});

	test("a multi-line entry carries the stamp on its last line", () => {
		const bullet = renderEntry("First line\n  detail", "2026-05-01");
		expect(bullet).toBe("- First line\n  detail (kept 2026-05-01)");
		expect(listEntries(bullet.split("\n"))[0].kept).toBe("2026-05-01");
	});

	test("age is counted in whole days from the stamp", () => {
		expect(ageInDays("2026-04-01", new Date("2026-05-01T12:00:00Z"))).toBe(30);
		expect(ageInDays("2026-05-02", TODAY)).toBe(0);
	});
});

describe("deleting entries", () => {
	test("removes the bullet and keeps everything else", () => {
		const file = join(tempDir(), "AGENTS.md");
		writeFileSync(file, "# Repo\n\n## Build\n\n- Keep me\n- Drop me\n\n## Style\n\n- No emojis\n");
		const outcome = removeEntries(file, (entry) => entry.body.includes("Drop me"));
		expect(outcome.removed).toHaveLength(1);
		const text = readFileSync(file, "utf-8");
		expect(text).toBe("# Repo\n\n## Build\n\n- Keep me\n\n## Style\n\n- No emojis\n");
	});

	test("a section whose last bullet is deleted goes with it", () => {
		const file = join(tempDir(), "AGENTS.md");
		writeFileSync(file, "## Build\n\n- Keep me\n\n## Tooling\n\n- Only bullet\n");
		removeEntries(file, (entry) => entry.body.includes("Only bullet"));
		expect(readFileSync(file, "utf-8")).toBe("## Build\n\n- Keep me\n");
	});

	test("the reported entries carry the section they came from", () => {
		const file = join(tempDir(), "AGENTS.md");
		writeFileSync(file, "## Build\n\n- A rule\n");
		expect(readEntries(file).map((entry) => entry.section)).toEqual(["Build"]);
	});
});

describe("stale detection", () => {
	test("an entry that names a missing path is proof, not a guess", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "kept.ts"), "export {};\n");
		const [alive, dead] = listEntries([
			"## Build",
			"- The loader lives in `src/kept.ts`",
			"- The loader lives in `src/gone.ts`",
		]);
		expect(missingPaths(dir, alive)).toEqual([]);
		expect(missingPaths(dir, dead)).toEqual(["src/gone.ts"]);
	});

	test("prose in backticks is not a path", () => {
		const dir = tempDir();
		const [entry] = listEntries(["## Build", "- Run `pnpm run check` after changes"]);
		expect(missingPaths(dir, entry)).toEqual([]);
	});

	test("old entries and missing paths are both reported", () => {
		const dir = tempDir();
		const entries = listEntries([
			"## Build",
			"- Ancient rule (kept 2024-01-01)",
			"- Fresh rule (kept 2026-04-30)",
			"- Reads `src/gone.ts`",
		]);
		const stale = staleCandidates({ cwd: dir, entries, now: TODAY });
		expect(stale.map((item) => item.reason)).toEqual(["aged", "missing"]);
		expect(stale[0].days).toBeGreaterThanOrEqual(180);
	});

	test("an unstamped entry falls back to the blame day", () => {
		const [entry] = listEntries(["## Build", "- Untouched rule"]);
		const stale = staleCandidates({
			cwd: tempDir(),
			entries: [entry],
			now: TODAY,
			blameDays: new Map([[entry.text, "2025-01-01"]]),
		});
		expect(stale.map((item) => item.reason)).toEqual(["aged"]);
	});

	test("a repository without git reports no ages instead of failing", async () => {
		const dir = tempDir();
		const entries = listEntries(["## Build", "- A rule"]);
		expect(await blameDays(join(dir, "AGENTS.md"), entries, dir)).toEqual(new Map());
	});

	test("git blame dates an entry by the commit that wrote its line", async () => {
		const dir = tempDir();
		const file = join(dir, "AGENTS.md");
		writeFileSync(file, "## Build\n\n- A very old rule\n");
		const git = (...args: string[]) =>
			spawnSync("git", args, {
				cwd: dir,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@example.com",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@example.com",
					GIT_AUTHOR_DATE: "2025-02-03T12:00:00Z",
					GIT_COMMITTER_DATE: "2025-02-03T12:00:00Z",
				},
			});
		if (git("init", "-q").status !== 0) return;
		git("add", "AGENTS.md");
		const commit = git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed");
		expect(commit.status, commit.stderr).toBe(0);
		const entries = listEntries(readFileSync(file, "utf-8").split("\n"));
		const days = await blameDays(file, entries, dir);
		expect(days.get("- A very old rule")).toMatch(/^2025-02-0[23]$/);
	});
});
