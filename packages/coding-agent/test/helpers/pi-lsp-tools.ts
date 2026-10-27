import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleApi, ModuleToolContext, ToolDefinition } from "../../src/core/modules/types.ts";
import lspMiniExtension from "../../src/extras/pi-lsp-mini/src/index.ts";

export const FAKE_SERVER = join(
	import.meta.dirname,
	"..",
	"..",
	"src",
	"extras",
	"pi-lsp-mini",
	"src",
	"__tests__",
	"fixtures",
	"fake-lsp-server.mjs",
);

export type ToolParams = Record<string, unknown>;

/**
 * Registers the extension against a stub `ModuleApi` and returns the tools it
 * registered by name. The registration is a static interface: the tool objects
 * it captures are what a session would execute, so a test asserts behavior
 * instead of copying the handler body.
 */
export function lspTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const stub = {
		on: () => () => undefined,
		registerCommand: () => undefined,
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
	} as unknown as ModuleApi;
	lspMiniExtension(stub);
	return tools;
}

/** A project whose only language server is the fake one. `env` steers that server. */
export function project(content: string, env: Record<string, string> = {}): { cwd: string; file: string } {
	const cwd = mkdtempSync(join(tmpdir(), "lsp-tool-"));
	const agentDir = mkdtempSync(join(tmpdir(), "lsp-tool-agent-"));
	writeFileSync(join(cwd, ".git"), "");
	const file = join(cwd, "sample.txt");
	writeFileSync(file, content);
	writeFileSync(
		join(agentDir, "lsp.json"),
		JSON.stringify({
			servers: [
				{
					id: "fake",
					command: `${process.execPath} ${FAKE_SERVER}`,
					include: [".txt"],
					rootMarkers: [".git"],
					requestTimeout: 20_000,
				},
			],
		}),
	);
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	return { cwd, file };
}

/** Runs one tool as a session would and returns the text it answered with. */
export async function run(
	tools: Map<string, ToolDefinition>,
	name: string,
	cwd: string,
	params: ToolParams,
): Promise<string> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool ${name} was not registered; got ${[...tools.keys()].join(", ")}`);
	const result = await tool.execute("test-call", params, undefined, undefined, {
		cwd,
		ui: { notify: () => undefined },
	} as unknown as ModuleToolContext);
	const first = result.content[0];
	return first && first.type === "text" ? first.text : "";
}
