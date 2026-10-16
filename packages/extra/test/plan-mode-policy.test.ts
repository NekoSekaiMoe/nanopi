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

	test("blocks every mutating tool", () => {
		for (const toolName of ["edit", "write", "subagent", "todo", "lsp_rename"]) {
			expect(planModeVerdict(toolName, {})).toContain(`blocked ${toolName}`);
		}
	});

	test("a shell call without a command string is blocked, not allowed", () => {
		expect(planModeVerdict("bash", {})).toBeDefined();
		expect(planModeVerdict("bash", undefined)).toBeDefined();
	});
});
