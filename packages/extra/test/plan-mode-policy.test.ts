import { describe, expect, test } from "vitest";
import { planModeVerdict } from "../src/extension.ts";

describe("plan mode tool policy", () => {
	test("allows reading and asking", () => {
		expect(planModeVerdict("read", { path: "src/index.ts" })).toBeUndefined();
		// Regression: the questionnaire was blocked along with every other tool, so
		// plan mode could explore but never resolve an ambiguity it found.
		expect(planModeVerdict("ask_user_question", { questions: [] })).toBeUndefined();
	});

	test("allows only ls, find, and pwd through the shell", () => {
		expect(planModeVerdict("bash", { command: "ls -la src" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "find . -name '*.ts'" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "pwd" })).toBeUndefined();
		expect(planModeVerdict("bash", { command: "rm -rf build" })).toContain("plan mode allows only");
		expect(planModeVerdict("powershell", { command: "Remove-Item -Recurse build" })).toBeDefined();
	});

	test("allows the read-only lsp tools", () => {
		// Regression: the whole lsp_ family was blocked, so a plan-mode session
		// could not hover, jump to a definition, or find real usages.
		for (const toolName of ["lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_query"]) {
			expect(planModeVerdict(toolName, { path: "src/index.ts" })).toBeUndefined();
		}
	});

	test("blocks every mutating tool", () => {
		for (const toolName of ["edit", "write", "subagent", "todo", "lsp_rename", "lsp_delete"]) {
			expect(planModeVerdict(toolName, {})).toContain(`blocked ${toolName}`);
		}
	});

	test("a shell call without a command string is blocked, not allowed", () => {
		expect(planModeVerdict("bash", {})).toBeDefined();
		expect(planModeVerdict("bash", undefined)).toBeDefined();
	});
});
