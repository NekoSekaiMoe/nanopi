import { describe, expect, it } from "vitest";
import { mcpBrief } from "../src/extras/mcp-lite/src/index.ts";

/**
 * The `mcp` shell exists to hand one call to a subagent, so the brief is the
 * contract: a renamed or retried argument set is a different request to an
 * external service, and a summarized result is not the server's answer.
 */
describe("mcp shell brief", () => {
	const brief = mcpBrief({
		server: "filesystem",
		tool: "read_file",
		args: { path: "/tmp/a.txt", encoding: "utf8" },
	});

	it("names the exact mcp__ tool the child has to call", () => {
		expect(brief).toContain("`mcp__filesystem__read_file`");
	});

	it("carries the arguments it must pass through", () => {
		expect(brief).toContain('{"path":"/tmp/a.txt","encoding":"utf8"}');
		expect(brief).toContain("must be passed through unchanged");
	});

	it("forbids rewriting the arguments or retrying", () => {
		expect(brief).toContain("Do not add, rename, or drop a field, and do not retry with different arguments.");
	});

	it("asks for the output verbatim instead of a summary", () => {
		expect(brief).toContain("the tool's textual output verbatim, with nothing before or after it");
		expect(brief).toContain("Do not summarize");
	});

	it("stops instead of guessing when the server or tool is missing", () => {
		expect(brief).toContain("STOP RULES:");
		expect(brief).toContain("does not exist or the server is not connected");
	});
});
