import { describe, expect, test } from "vitest";
import { planModeVerdict } from "../src/extension.ts";

describe("plan mode tool policy", () => {
	test("allows reading, asking, drafting, and re-entering", () => {
		expect(planModeVerdict("read", { path: "src/index.ts" })).toBeUndefined();
		// Regression: the questionnaire was blocked along with every other tool, so
		// plan mode could explore but never resolve an ambiguity it found.
		expect(planModeVerdict("ask_user_question", { questions: [] })).toBeUndefined();
		// The draft is what keeps a multi-step plan in one place while it is still
		// being revised; it writes no file.
		expect(planModeVerdict("todo", { action: "add", texts: ["a"] })).toBeUndefined();
		// A model asked for a plan in prose may reach for the tool that enters the
		// mode, and must not be blocked for it.
		expect(planModeVerdict("enter_plan_mode", {})).toBeUndefined();
	});

	test("allows the reading shell commands through bash", () => {
		expect(planModeVerdict("bash", { command: "ls -la src" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "find . -name '*.ts'" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "pwd" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "cat README.md" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "rg -n planIntroActive src" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "git log --oneline -5" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "rm -rf build" })).toContain("plan mode allows only");
		// PowerShell syntax is not what the analyzer parses, so the tool is refused
		// even for a word that looks like a read.
		expect(planModeVerdict("powershell", { command: "Remove-Item -Recurse build" })).toBeDefined();
	});

	test("allows the read-only lsp tools", () => {
		// Regression: the whole lsp_ family was blocked, so a plan-mode session
		// could not hover, jump to a definition, or find real usages.
		for (const toolName of ["lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_query"]) {
			expect(planModeVerdict(toolName, { path: "src/index.ts" })).toBeUndefined();
		}
	});

	test("blocks every tool that can change the repository", () => {
		for (const toolName of ["edit", "write", "subagent", "lsp_edit", "bash_bg"]) {
			expect(planModeVerdict(toolName, {})).toContain(`blocked ${toolName}`);
		}
	});

	test("names what the plan is for when it blocks", () => {
		// The message is the only instruction the model gets at the moment it is
		// refused, so it has to say where the work goes instead.
		expect(planModeVerdict("write", {})).toContain("answer with the plan");
	});

	test("a shell call without a command string is blocked, not allowed", () => {
		expect(planModeVerdict("bash", {})).toBeDefined();
		expect(planModeVerdict("bash", undefined)).toBeDefined();
	});
});
