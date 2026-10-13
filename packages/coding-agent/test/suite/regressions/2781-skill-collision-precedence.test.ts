import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

// Issue #2781 covered package-vs-local skill precedence; the package manager is
// gone, and the same-name precedence machinery now applies to the local scopes.
describe("issue #2781 skill collision precedence: project skills should override user skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `nanopi-2781-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createUserSkill(name: string, description: string): string {
		const skillDir = join(agentDir, "skills", name);
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\nUser skill content`);
		return skillPath;
	}

	function createProjectSkill(name: string, description: string): string {
		const skillDir = join(cwd, ".nanopi", "skills", name);
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\nProject skill content`);
		return skillPath;
	}

	it("project auto-discovered skill should override user skill with same name", async () => {
		createUserSkill("web-fetch", "User web-fetch override");
		const projectSkillPath = createProjectSkill("web-fetch", "Project web-fetch override");

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		const webFetch = skills.find((s) => s.name === "web-fetch");
		expect(webFetch).toBeDefined();
		expect(webFetch!.filePath).toBe(projectSkillPath);
		expect(webFetch!.description).toBe("Project web-fetch override");
	});

	it("collision diagnostics should report the user skill as loser when the project skill wins", async () => {
		const userSkillPath = createUserSkill("web-fetch", "User web-fetch override");
		createProjectSkill("web-fetch", "Project web-fetch override");

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { diagnostics } = loader.getSkills();
		const collision = diagnostics.find((d) => d.type === "collision" && d.collision?.name === "web-fetch");
		expect(collision).toBeDefined();
		expect(collision!.collision!.loserPath).toBe(userSkillPath);
	});
});
