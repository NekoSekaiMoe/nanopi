import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportSessionToMarkdown, renderSessionMarkdown } from "../src/core/export-markdown/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

/**
 * A session manager over entries written to a real session file: the exporter
 * reads the header and the branch, which only exist once the entries are
 * appended.
 */
function session(messages: object[]): { manager: SessionManager; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-export-md-"));
	const manager = SessionManager.create(dir, dir);
	for (const message of messages) manager.appendMessage(message as never);
	return { manager, dir };
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Markdown export", () => {
	it("writes the conversation with roles, tool calls, and tool output", () => {
		const { manager, dir } = session([{ role: "user", content: "what does src/a.ts do?" }]);
		tempDirs.push(dir);
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Reading it now." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
			],
		} as never);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "export const a = 1;" }],
			isError: false,
		} as never);

		const markdown = renderSessionMarkdown(manager, "Session title");

		expect(markdown).toContain("# Session title");
		expect(markdown).toContain("## User");
		expect(markdown).toContain("what does src/a.ts do?");
		expect(markdown).toContain("## Assistant");
		expect(markdown).toContain("Reading it now.");
		expect(markdown).toContain("### Tool call: read");
		expect(markdown).toContain('"path": "src/a.ts"');
		expect(markdown).toContain("### Tool result: read");
		expect(markdown).toContain("export const a = 1;");
	});

	it("keeps a fenced block intact when the output itself contains a fence", () => {
		const { manager, dir } = session([]);
		tempDirs.push(dir);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "```ts\nconst a = 1;\n```" }],
			isError: false,
		} as never);

		const markdown = renderSessionMarkdown(manager);
		// Four backticks: three would be closed by the output's own fence.
		expect(markdown).toContain("````\n```ts");
	});

	it("writes a file and defaults the name to the session file", () => {
		const { manager, dir } = session([]);
		tempDirs.push(dir);
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
		} as never);

		const outputPath = join(dir, "out.md");
		expect(exportSessionToMarkdown(manager, { outputPath })).toBe(outputPath);
		expect(readFileSync(outputPath, "utf8")).toContain("hello");
	});

	it("refuses an empty session", () => {
		const { manager, dir } = session([]);
		tempDirs.push(dir);
		expect(() => exportSessionToMarkdown(manager)).toThrow(/Nothing to export/);
	});
});
