import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The shell-only prompt is the `toolset: "bash"` flavor's shape: one shell tool
 * per platform, no tool list, no docs section. It is exercised by injecting the
 * build defines the flavor injects and re-importing the module.
 */
const SHELL_ONLY_DEFINES = {
	NANOPI_BUILD_TOOLSET: JSON.stringify("bash"),
	NANOPI_BUILD_TOOLS: JSON.stringify(["bash", "powershell"]),
	NANOPI_BUILD_COMPONENTS: JSON.stringify({ docs: false, examples: false }),
};

async function importShellOnlyPrompt() {
	vi.resetModules();
	for (const [name, value] of Object.entries(SHELL_ONLY_DEFINES)) vi.stubGlobal(name, JSON.parse(value));
	return await import("../src/core/system-prompt.ts");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("shell-only system prompt", () => {
	test("drops the tool list, the docs pointer and the cwd rule, keeping rules and cwd", async () => {
		const { buildSystemPromptSections } = await importShellOnlyPrompt();
		const sections = buildSystemPromptSections({
			cwd: "/home/user/project",
			selectedTools: ["bash", "powershell"],
			contextFiles: [],
			skills: [],
		});

		expect(Object.keys(sections)).toEqual(["preamble", "rules", "cwd"]);
		expect(sections.preamble).toContain("shell tool");
		expect(sections.rules).toContain("<rules>");
		expect(sections.cwd).toBe("<cwd>\n/home/user/project\n</cwd>");
	});

	test("keeps a custom prompt exact and still appends rules", async () => {
		const { buildSystemPromptSections } = await importShellOnlyPrompt();
		const sections = buildSystemPromptSections({
			customPrompt: "You are Exact.",
			cwd: "/tmp",
			selectedTools: ["bash"],
			contextFiles: [],
			skills: [],
		});

		expect(sections.preamble).toBe("You are Exact.");
		expect(sections.docs).toBeUndefined();
	});

	test("keeps appended instructions and project context", async () => {
		const { buildSystemPromptSections } = await importShellOnlyPrompt();
		const sections = buildSystemPromptSections({
			cwd: "/tmp",
			selectedTools: ["bash"],
			appendSystemPrompt: "Extra.",
			contextFiles: [{ path: "/tmp/AGENTS.md", content: "Rules." }],
			skills: [],
		});

		expect(sections.addendum).toBe("<addendum>\nExtra.\n</addendum>");
		expect(sections.project_context).toContain("/tmp/AGENTS.md");
	});
});
