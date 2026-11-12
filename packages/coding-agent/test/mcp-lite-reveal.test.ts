import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import mcpLiteExtension from "../src/extras/mcp-lite/src/index.ts";

const temps: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-reveal-"));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

interface Harness {
	active: string[];
	registered: string[];
	start: () => Promise<void>;
}

function harness(agentDir: string, cwd: string, initialActive: string[]): Harness {
	const active = [...initialActive];
	const registered: string[] = [];
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => {
			handlers[event] = handler;
			return () => {};
		},
		registerTool: (tool: { name: string }) => {
			registered.push(tool.name);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active.length = 0;
			active.push(...names);
		},
	};
	mcpLiteExtension(pi as never);
	return {
		active,
		registered,
		start: async () => {
			// `session_start` answers with void: the servers connect in the background,
			// and answering their handshake takes as long as the spawned child needs.
			// Poll up to a few seconds instead of sleeping one fixed turn.
			await handlers.session_start?.(
				{ type: "session_start", reason: "startup" },
				{ cwd, getAgentDir: () => agentDir },
			);
			for (let attempt = 0; attempt < 300 && registered.length <= 1; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		},
	};
}

// #697: a tool registered from a server's answer landed in the registry after
// `session_start` refreshed it, so the running model never declared it.
describe("mcp-lite tool registration", () => {
	it("adds the tools a server answered with to the tools already declared", async () => {
		const dir = tempDir();
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const server = join(dir, "server.mjs");
		writeFileSync(
			server,
			[
				'process.stdin.setEncoding("utf8");',
				"let buffer = '';",
				// Every frame in the chunk, not just the first: `notifications/initialized`
				// and `tools/list` are separate writes, and the pipe delivers them as one
				// chunk whenever the client gets both out before this process reads. The
				// client frames correctly either way (it loops over its buffer); reading
				// one frame per chunk here dropped `tools/list`, so the client waited out
				// its 120s request timeout and no tool was ever registered.
				'process.stdin.on("data", (chunk) => {',
				"  buffer += chunk;",
				"  let newline;",
				'  while ((newline = buffer.indexOf("\\n")) >= 0) {',
				"    const message = JSON.parse(buffer.slice(0, newline));",
				"    buffer = buffer.slice(newline + 1);",
				"    if (message.id === undefined) continue;",
				'    const result = message.method === "tools/list"',
				'      ? { tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object" } }] }',
				"      : {};",
				'    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
				"  }",
				"});",
			].join("\n"),
		);
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { demo: { transport: "stdio", command: process.execPath, args: [server] } },
			}),
		);

		const client = harness(agentDir, cwd, ["read", "bash"]);
		await client.start();

		expect(client.registered).toContain("mcp__demo__echo");
		expect(client.active).toEqual(["read", "bash", "mcp__demo__echo"]);
	});

	it("leaves the declared tools untouched when no server answers", async () => {
		const dir = tempDir();
		const agentDir = join(dir, "agent");
		const cwd = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));

		const client = harness(agentDir, cwd, ["read", "bash"]);
		await client.start();

		expect(client.active).toEqual(["read", "bash"]);
	});
});
