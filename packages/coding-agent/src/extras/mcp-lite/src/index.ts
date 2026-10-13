/**
 * mcp-lite — lean MCP client extension.
 *
 * Tools are registered with `defaultActive: false` under `mcp__<server>__<tool>`:
 * the main agent never declares them. Subagent children activate them with
 * `--tools mcp__*` (pi-subagent-mini forwards this extension when the extra
 * module's mcp subsystem switch is on), and the extra module blocks `mcp__*`
 * calls in main-agent sessions — MCP is subagent-only by design.
 *
 * Slim port of irahardianto/pi-mcp-extension (MIT): stdio + streamable-http
 * transports, initialize/tools list+call/cancel, config layering. No OAuth,
 * health pings, or reconnection machinery.
 */

import { Type, type TSchema } from "typebox";
import type { ModuleApi } from "@nanopi/pi-coding-agent";
import { McpClient, type McpToolDefinition } from "./client.ts";
import { loadMcpConfig } from "./config.ts";

const MAX_TOOL_NAME_LENGTH = 64;

function sanitizeSegment(segment: string): string {
	const cleaned = segment.replace(/[^a-zA-Z0-9_-]/g, "_");
	return cleaned.slice(0, MAX_TOOL_NAME_LENGTH) || "_";
}

function mcpToolName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
}

function parametersSchema(tool: McpToolDefinition): TSchema {
	const schema = tool.inputSchema;
	if (
		schema &&
		typeof schema === "object" &&
		typeof (schema as { type?: unknown }).type === "string" &&
		typeof (schema as { properties?: unknown }).properties === "object"
	) {
		return schema as TSchema;
	}
	return Type.Object({});
}

interface ServerState {
	client: McpClient;
	status: "connected" | "failed";
	toolCount: number;
	error?: string;
}

export default function mcpLiteExtension(pi: ModuleApi): void {
	const states = new Map<string, ServerState>();

	const connectServer = async (name: string, state: ServerState): Promise<void> => {
		try {
			await state.client.connect();
			const tools = await state.client.listTools();
			state.toolCount = tools.length;
			for (const tool of tools) {
				registerMcpTool(pi, state.client, name, tool);
			}
		} catch (error) {
			state.status = "failed";
			state.error = error instanceof Error ? error.message : String(error);
			state.client.close();
		}
	};

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "reload") return;
		void (async () => {
			const config = loadMcpConfig(ctx.cwd);
			for (const [name, serverConfig] of config.servers) {
				if (states.has(name)) continue;
				const state: ServerState = { client: new McpClient(name, serverConfig), status: "connected", toolCount: 0 };
				states.set(name, state);
				await connectServer(name, state);
			}
		})();
	});

	pi.on("session_shutdown", () => {
		for (const state of states.values()) state.client.close();
		states.clear();
	});

	pi.registerCommand("mcp", {
		description: "Show MCP server connection status",
		handler: async (_args, ctx) => {
			if (states.size === 0) {
				ctx.ui.notify("No MCP servers configured (~/.nanopi/mcp.json or .nanopi/mcp.json).", "info");
				return;
			}
			const lines: string[] = [];
			for (const [name, state] of states) {
				if (state.status === "connected") {
					lines.push(`${name}: connected (${state.toolCount} tools)`);
				} else {
					lines.push(`${name}: failed (${state.error ?? "unknown error"})`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function registerMcpTool(pi: ModuleApi, client: McpClient, serverName: string, tool: McpToolDefinition): void {
	pi.registerTool({
		name: mcpToolName(serverName, tool.name),
		label: `${serverName}: ${tool.name}`,
		description: [tool.description, `(MCP server "${serverName}"; available to subagents only)`]
			.filter(Boolean)
			.join(" "),
		parameters: parametersSchema(tool),
		defaultActive: false,
		annotations: {
			readOnlyHint: tool.annotations?.readOnlyHint,
			destructiveHint: tool.annotations?.destructiveHint,
			idempotentHint: tool.annotations?.idempotentHint,
			openWorldHint: tool.annotations?.openWorldHint,
		},
		execute: async (toolCallId, params, signal) => {
			try {
				const result = await client.callTool(
					tool.name,
					params as Record<string, unknown>,
					signal ?? undefined,
				);
				const text = result.content
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n");
				return {
					content: [{ type: "text" as const, text: text || "(no textual output)" }],
					details: {},
					isError: result.isError,
				};
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
					details: {},
					isError: true,
				};
			}
		},
	});
}
