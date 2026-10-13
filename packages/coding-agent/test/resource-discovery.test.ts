import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
