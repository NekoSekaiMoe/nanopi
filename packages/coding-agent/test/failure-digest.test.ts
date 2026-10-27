/**
 * Failed commands end with a digest of the lines that name the failure. The rules are
 * heuristics over each framework's human output, so each case here is a real transcript
 * from that framework; the assertions are on the lines kept, not on the regexes.
 */

import { describe, expect, it } from "vitest";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { digestFailures, formatFailureDigest } from "../src/core/tools/failure-digest.ts";

function texts(output: string): string[] | undefined {
	return digestFailures(output)?.failures.map((failure) => failure.text);
}

function digest(output: string): string {
	const result = digestFailures(output);
	if (!result) throw new Error("expected a digest");
	const formatted = formatFailureDigest(result, { maxLines: 20, maxBytes: 4096 });
	if (!formatted) throw new Error("expected a formatted digest");
	return formatted.text;
}

describe("failure digest", () => {
	it("keeps the failing test and its assertion from vitest output", () => {
		const output = [
			"",
			" RUN  v2.1.0 /repo",
			"",
			" ✓ test/a.test.ts (3 tests) 12ms",
			" ❯ test/b.test.ts (2 tests | 1 failed) 8ms",
			"   × adds numbers 5ms",
			"     → expected 3 to be 4",
			"",
			"⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
			"",
			" FAIL  test/b.test.ts > math > adds numbers",
			"AssertionError: expected 3 to be 4",
			"",
			" ❯ test/b.test.ts:12:20",
			"",
			" Test Files  1 failed | 1 passed (2)",
			"",
		].join("\n");
		expect(texts(output)).toEqual([
			" FAIL  test/b.test.ts > math > adds numbers",
			"AssertionError: expected 3 to be 4",
		]);
	});

	it("drops the compilation errors once a test framework named a failure", () => {
		const output = [
			"src/a.ts:1:1: error: 'x' was not declared in this scope",
			" FAIL  test/b.test.ts > math > adds numbers",
			"AssertionError: expected 3 to be 4",
			"",
		].join("\n");
		expect(texts(output)).toEqual([
			" FAIL  test/b.test.ts > math > adds numbers",
			"AssertionError: expected 3 to be 4",
		]);
	});

	it("strips ANSI before matching tsc's pretty output", () => {
		const output =
			"\u001b[96msrc/a.ts\u001b[0m:\u001b[93m12\u001b[0m:\u001b[93m20\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'string' is not assignable.";
		// The line is reported as the compiler wrote it; only the match saw the stripped text.
		expect(texts(output)).toEqual([output]);
	});

	it("reads tsc with --pretty false and gcc-style errors", () => {
		const output = [
			"src/a.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/foo.cpp:5:5: error: 'x' was not declared in this scope",
			"    5 |     x = 1;",
			"      |     ^",
			"",
		].join("\n");
		expect(texts(output)).toEqual([
			"src/a.ts(1,5): error TS2322: Type 'string' is not assignable to type 'number'.",
			"src/foo.cpp:5:5: error: 'x' was not declared in this scope",
		]);
	});

	it("keeps ninja's FAILED line, which names the output path", () => {
		const output = [
			"[1/3] Building CXX object CMakeFiles/foo.dir/src/foo.cpp.o",
			"FAILED: CMakeFiles/foo.dir/src/foo.cpp.o",
			"/usr/bin/c++ -o CMakeFiles/foo.dir/src/foo.cpp.o -c /repo/src/foo.cpp",
			"ninja: build stopped: subcommand failed.",
		].join("\n");
		expect(texts(output)).toEqual(["FAILED: CMakeFiles/foo.dir/src/foo.cpp.o"]);
	});

	it("keeps ctest's failed list, which is stable across CMake versions", () => {
		const output = [
			"    Start 3: gamma",
			"3/3 Test #3: gamma ............................***Failed    0.01 sec",
			"",
			"50% tests passed, 1 tests failed out of 3",
			"",
			"The following tests FAILED:",
			"\t  3 - gamma (Failed)",
			"",
		].join("\n");
		expect(texts(output)).toEqual(["The following tests FAILED:", "\t  3 - gamma (Failed)"]);
	});

	it("reads pytest's short summary and jest's case marker", () => {
		expect(texts("FAILED tests/test_a.py::test_b - assert 1 == 2\n")).toEqual([
			"FAILED tests/test_a.py::test_b - assert 1 == 2",
		]);
		expect(texts("  ● math › adds numbers\n\n    expect(3).toBe(4)\n")).toEqual(["  ● math › adds numbers"]);
	});

	it("reports a configure failure instead of its probing", () => {
		const probing = ["checking for gcc... gcc", "checking whether the C compiler works... no"].join("\n");
		expect(texts(probing)).toBeUndefined();
		const failed = [
			probing,
			"checking for stdio.h... no",
			"checking for string.h... no",
			"configure: error: cannot find a C compiler",
			"",
		].join("\n");
		expect(texts(failed)).toEqual(["configure: error: cannot find a C compiler"]);
	});

	it("returns nothing for a passing run", () => {
		expect(texts("✓ test/a.test.ts (3 tests)\n\n Test Files  2 passed (2)\n")).toBeUndefined();
	});

	it("cuts the middle of a long line but keeps the assertion", () => {
		const line = `AssertionError: expected ${"x".repeat(400)}`;
		const kept = texts(line)?.[0] ?? "";
		expect(kept.length).toBeLessThan(260);
		expect(kept.startsWith("AssertionError:")).toBe(true);
		expect(kept.endsWith("x")).toBe(true);
	});

	it("reports line numbers against the full output", () => {
		const output = ["one", "two", "FAIL  a.test.ts > b", "AssertionError: c", "five", "six"].join("\n");
		expect(digestFailures(output)?.failures.map((failure) => failure.line)).toEqual([3, 4]);
		expect(digestFailures(output)?.totalLines).toBe(6);
	});

	it("fits the digest into the tail budget", () => {
		const output = Array.from({ length: 40 }, (_, index) => `FAIL  test/${index}.test.ts > case ${index}`).join("\n");
		const formatted = formatFailureDigest(digestFailures(output) ?? { failures: [], totalLines: 0, omitted: 0 }, {
			maxLines: 5,
			maxBytes: 4096,
		});
		expect(formatted?.text.split("\n").length).toBeLessThanOrEqual(5);
		// The tail survives truncation, so the last kept match is the one the block keeps.
		expect(formatted?.text).toContain("case 39");
	});

	it("labels every kept line with its output line number", () => {
		expect(digest("nope\nFAIL  a.test.ts > b\n")).toBe(
			"[failures]\n2 | FAIL  a.test.ts > b\n(3 lines of output; other lines omitted)",
		);
	});
});

describe("bash failure digest wiring", () => {
	const failing: BashOperations = {
		exec: async (command, _cwd, { onData }) => {
			onData(Buffer.from(command.includes("test") ? VITEST_OUTPUT : "plain failure\n"));
			return { exitCode: 1 };
		},
	};

	it("appends the digest after the status line so head truncation cannot drop it", async () => {
		const definition = createBashToolDefinition(process.cwd(), { operations: failing });
		const result = await definition.execute("t", { command: "pnpm test" }, undefined, undefined, undefined as never);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

		expect(text.trimEnd().endsWith("(10 lines of output; other lines omitted)")).toBe(true);
		expect(text.indexOf("Command exited with code 1")).toBeLessThan(text.indexOf("[failures]"));
	});

	it("keeps the failure list out of the model-facing text", async () => {
		const definition = createBashToolDefinition(process.cwd(), { operations: failing });
		const result = await definition.execute("t", { command: "pnpm test" }, undefined, undefined, undefined as never);
		const structured = result.structuredContent as { failures?: { source: string }[] };
		expect(structured.failures?.map((failure) => failure.source)).toEqual(["vitest", "assertion"]);
	});

	it("adds nothing to a passing command", async () => {
		const passing: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from(" FAIL  test/a.test.ts > case\n"));
				return { exitCode: 0 };
			},
		};
		const definition = createBashToolDefinition(process.cwd(), { operations: passing });
		const result = await definition.execute("t", { command: "pnpm test" }, undefined, undefined, undefined as never);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).not.toContain("[failures]");
		expect((result.structuredContent as { failures?: unknown }).failures).toBeUndefined();
	});
});

const VITEST_OUTPUT = [
	" RUN  v2.1.0 /repo",
	"",
	" ❯ test/b.test.ts (2 tests | 1 failed) 8ms",
	"   × adds numbers 5ms",
	"",
	"⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
	"",
	" FAIL  test/b.test.ts > math > adds numbers",
	"AssertionError: expected 3 to be 4",
	"",
].join("\n");
