import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpCommand, runMcpCommand } from "../src/cli/mcp-command.ts";

const temps: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseMcpCommand", () => {
	it("parses a stdio server with argv after --", () => {
		const command = parseMcpCommand(["mcp", "add", "fs", "--", "npx", "-y", "srv", "."]);
		expect(command?.server).toEqual({ transport: "stdio", command: "npx", args: ["-y", "srv", "."] });
	});
	it("parses a stdio server without --", () => {
		const command = parseMcpCommand(["mcp", "add", "fs", "npx", "-y", "srv"]);
		expect(command?.server).toEqual({ transport: "stdio", command: "npx", args: ["-y", "srv"] });
	});
	it("parses an http server", () => {
		const command = parseMcpCommand([
			"mcp",
			"add",
			"remote",
			"--url",
			"https://x/mcp",
			"--header",
			"authorization=Bearer t",
		]);
		expect(command?.server).toEqual({
			transport: "http",
			url: "https://x/mcp",
			headers: { authorization: "Bearer t" },
		});
	});
	it("rejects both transports", () => {
		expect(() => parseMcpCommand(["mcp", "add", "x", "--command", "a", "--url", "b"])).toThrow();
	});
	it("parses remove with scope", () => {
		expect(parseMcpCommand(["mcp", "remove", "fs", "--project"])?.scope).toBe("project");
	});
});

describe("runMcpCommand", () => {
	it("adds to the global file and keeps other keys", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify(
				{ discovery: { mode: "off" }, mcpServers: { old: { transport: "stdio", command: "old" } } },
				null,
				2,
			),
		);
		runMcpCommand(parseMcpCommand(["mcp", "add", "fs", "--", "npx", "-y", "srv"])!, { cwd, agentDir });
		const written = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
		expect(written.discovery).toEqual({ mode: "off" });
		expect(Object.keys(written.mcpServers)).toEqual(["old", "fs"]);
	});
	it("refuses a duplicate without --force, replaces with it", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		runMcpCommand(parseMcpCommand(["mcp", "add", "fs", "--", "npx", "a"])!, { cwd, agentDir });
		expect(() =>
			runMcpCommand(parseMcpCommand(["mcp", "add", "fs", "--", "npx", "b"])!, { cwd, agentDir }),
		).toThrow();
		runMcpCommand(parseMcpCommand(["mcp", "add", "fs", "--force", "--", "npx", "b"])!, { cwd, agentDir });
		const written = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
		expect(written.mcpServers.fs.args).toEqual(["b"]);
	});
	it("writes the project file on --project", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		runMcpCommand(parseMcpCommand(["mcp", "add", "fs", "--project", "--", "npx", "a"])!, { cwd, agentDir });
		expect(JSON.parse(readFileSync(join(cwd, ".nanopi", "mcp.json"), "utf8")).mcpServers.fs.command).toBe("npx");
	});
	it("removes from both files", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		runMcpCommand(parseMcpCommand(["mcp", "add", "fs", "--", "npx", "a"])!, { cwd, agentDir });
		runMcpCommand(parseMcpCommand(["mcp", "add", "fs", "--project", "--", "npx", "a"])!, { cwd, agentDir });
		expect(runMcpCommand(parseMcpCommand(["mcp", "remove", "fs"])!, { cwd, agentDir })).toBe(0);
		expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).mcpServers).toBeUndefined();
		expect(JSON.parse(readFileSync(join(cwd, ".nanopi", "mcp.json"), "utf8")).mcpServers).toBeUndefined();
	});
	it("reports a malformed file instead of overwriting it", () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), "{ not json");
		expect(() => runMcpCommand(parseMcpCommand(["mcp", "add", "fs", "--", "npx"])!, { cwd, agentDir })).toThrow(
			/not valid JSON/,
		);
	});
});
