import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/extras/mcp-lite/src/config.ts";

describe("mcp-lite config", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function makeProject(mcpJson: string): string {
		const root = mkdtempSync(join(tmpdir(), "nanopi-mcp-config-"));
		roots.push(root);
		const project = join(root, "project");
		mkdirSync(join(project, ".nanopi"), { recursive: true });
		writeFileSync(join(project, ".nanopi", "mcp.json"), mcpJson);
		return project;
	}

	// Ported from earendil-works/pi#11191: Windows PowerShell 5.1 writes a UTF-8 BOM,
	// which made the whole file unparseable and silently dropped every server.
	it("reads a project mcp.json that starts with a UTF-8 BOM", () => {
		const body = JSON.stringify({
			mcpServers: { bomtest: { transport: "stdio", command: "echo", args: ["hi"] } },
			discovery: { mode: "off" },
		});
		const project = makeProject(`\uFEFF${body}`);

		const config = loadMcpConfig(project, { home: join(project, "home"), env: {} });

		expect(config.servers.get("bomtest")).toMatchObject({ transport: "stdio", command: "echo" });
		expect(config.discovery.mode).toBe("off");
	});

	it("still reads a project mcp.json without a BOM", () => {
		const body = JSON.stringify({ mcpServers: { plain: { transport: "stdio", command: "cat" } } });
		const project = makeProject(body);

		const config = loadMcpConfig(project, { home: join(project, "home"), env: {} });

		expect(config.servers.get("plain")).toMatchObject({ transport: "stdio", command: "cat" });
	});
});
