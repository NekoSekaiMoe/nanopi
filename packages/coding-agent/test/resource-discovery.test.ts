import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLocalResources } from "../src/core/resource-discovery.ts";

// #10765
describe("resolveLocalResources", () => {
	let tempDir: string;
	let previousHome: string | undefined;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "resource-discovery-"));
		previousHome = process.env.HOME;
		process.env.HOME = tempDir;
	});

	afterAll(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	});

	it("expands ~ in exclusion and exact patterns", () => {
		const baseDir = join(homedir(), "extra");
		const skillsDir = join(baseDir, "skills");
		for (const name of ["keep", "glob-excluded", "exact-excluded"]) {
			mkdirSync(join(skillsDir, name), { recursive: true });
			writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
		}

		const { skills } = resolveLocalResources({
			cwd: tempDir,
			globalBaseDir: baseDir,
			projectBaseDir: join(tempDir, "project"),
			projectTrusted: false,
			globalSettings: {
				skills: ["!~/extra/skills/glob-*", "-~/extra/skills/exact-excluded"],
			},
			projectSettings: {},
		});

		const byPath = new Map(skills.map((skill) => [skill.path, skill.enabled]));
		expect(skills.length).toBe(3);
		for (const [path, enabled] of byPath) {
			if (path.includes("glob-excluded") || path.includes("exact-excluded")) {
				expect(enabled).toBe(false);
			} else {
				expect(enabled).toBe(true);
			}
		}
	});
});

describe("resolveLocalResources under .agents", () => {
	it("finds project skills and prompts in .agents, before .nanopi", () => {
		const root = mkdtempSync(join(tmpdir(), "resource-discovery-agents-"));
		const previousHome = process.env.HOME;
		const home = mkdtempSync(join(tmpdir(), "resource-discovery-home-"));
		process.env.HOME = home;
		const cwd = join(root, "repo");
		const projectBaseDir = join(cwd, ".nanopi");
		const nested = join(cwd, "packages", "app");
		try {
			mkdirSync(nested, { recursive: true });
			for (const dir of [join(cwd, ".agents", "skills", "shared"), join(cwd, ".nanopi", "skills", "legacy")]) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "SKILL.md"),
					`---\nname: ${dir.includes("legacy") ? "legacy" : "shared"}\ndescription: d\n---\n`,
				);
			}
			for (const dir of [join(cwd, ".agents", "prompts"), join(cwd, ".nanopi", "prompts")]) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "review.md"),
					`---\ndescription: ${dir.includes(".agents") ? "agents" : "nanopi"}\n---\n`,
				);
			}

			const { skills, prompts } = resolveLocalResources({
				cwd: nested,
				globalBaseDir: join(home, "agent"),
				projectBaseDir,
				projectTrusted: true,
				globalSettings: {},
				projectSettings: {},
			});

			const projectSkillPaths = skills.map((skill) => skill.path).filter((path) => path.startsWith(cwd));
			expect(projectSkillPaths).toContain(join(cwd, ".agents", "skills", "shared", "SKILL.md"));
			expect(skills.find((skill) => skill.path.includes(".agents"))?.metadata.baseDir).toBe(join(cwd, ".agents"));
			const promptPaths = prompts.map((prompt) => prompt.path);
			expect(promptPaths).toContain(join(cwd, ".agents", "prompts", "review.md"));

			// The legacy directory is only searched at cwd, and only when it is
			// the project base the session loaded settings from.
			const atCwd = resolveLocalResources({
				cwd,
				globalBaseDir: join(home, "agent"),
				projectBaseDir,
				projectTrusted: true,
				globalSettings: {},
				projectSettings: {},
			});
			const cwdSkillPaths = atCwd.skills.map((skill) => skill.path).filter((path) => path.startsWith(cwd));
			expect(cwdSkillPaths.sort()).toEqual([
				join(cwd, ".agents", "skills", "shared", "SKILL.md"),
				join(cwd, ".nanopi", "skills", "legacy", "SKILL.md"),
			]);
			const cwdPromptPaths = atCwd.prompts.map((prompt) => prompt.path).filter((path) => path.startsWith(cwd));
			expect(cwdPromptPaths.indexOf(join(cwd, ".agents", "prompts", "review.md"))).toBeLessThan(
				cwdPromptPaths.indexOf(join(cwd, ".nanopi", "prompts", "review.md")),
			);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
