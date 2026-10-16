import { describe, expect, test } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";

/**
 * Regression for the subagent child launch.
 *
 * `pi-subagent-mini` shelled out to `pi --mode json -p --no-session -ne ... -e
 * <ext> <task>`. Both `-ne` and `-e` were removed with the plugin system, so
 * every spawn died on `Unknown option` — and because the flags were parsed as
 * errors rather than removed, the orphaned `-e` path became `parsed.messages[0]`,
 * i.e. the child's prompt was a file path instead of the task.
 *
 * The child argv is pinned here so a future flag rename fails loudly instead of
 * quietly producing subagents that exit before doing any work.
 */
describe("subagent child argv", () => {
	const argv = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"-t",
		"read,bash,grep,find,ls",
		"--modules",
		"extra,builtin-commands,codex-compaction,pi-fake-opencode",
		"Task: list the TODO comments in src",
	];

	test("parses with no diagnostics", () => {
		expect(parseArgs(argv).diagnostics).toEqual([]);
	});

	test("treats the task as the only message", () => {
		expect(parseArgs(argv).messages).toEqual(["Task: list the TODO comments in src"]);
	});

	test("no leftover flag value becomes the prompt", () => {
		const parsed = parseArgs(argv);
		expect(parsed.messages.some((message) => message.includes("pi-fake-opencode"))).toBe(false);
		expect(parsed.messages.some((message) => message.startsWith("read,bash"))).toBe(false);
	});

	test("keeps the requested tool list and modules", () => {
		const parsed = parseArgs(argv);
		expect(parsed.tools).toEqual(["read", "bash", "grep", "find", "ls"]);
		expect(parsed.modules).toContain("pi-fake-opencode");
	});

	test("the retired -ne / -e flags are still rejected, not silently ignored", () => {
		expect(parseArgs(["-ne"]).diagnostics.length).toBeGreaterThan(0);
		expect(parseArgs(["-e", "/some/entry.ts"]).diagnostics.length).toBeGreaterThan(0);
	});
});
