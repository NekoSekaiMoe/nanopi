/**
 * mcp-lite — lean MCP client extension.
 *
 * Two tool sets come out of here:
 *
 * - `mcp__<server>__<tool>`: the server's own tools, registered with
 *   `defaultActive: false`. The main agent never declares them; subagent
 *   children activate them with `--tools mcp__*`, and the extra module blocks
 *   `mcp__*` calls in main-agent sessions — MCP is subagent-only by design.
 * - `mcp`: one wrapper tool the main agent *does* have. It takes a server (or
 *   none, for the list) plus the raw tool name and arguments, and runs the call
 *   through the session's `subagent` tool so the untrusted server output stays
 *   inside a child turn's context. Without it the main agent had no way to use
 *   MCP at all, only instructions telling it to delegate.
 *
 * Slim port of irahardianto/pi-mcp-extension (MIT): stdio + streamable-http
 * transports, initialize/tools list+call/cancel, config layering, and
 * discovery of the config files other clients already have.
 */

import { Type } from "typebox";
import type { ModuleApi, ModuleToolContext } from "@nanopi/pi-coding-agent";
import { McpClient, type McpToolDefinition } from "./client.ts";
import { loadMcpConfig, type McpConfig } from "./config.ts";
import { commandAvailable } from "./executables.ts";

const MAX_TOOL_NAME_LENGTH = 64;
const WRAPPER_TOOL = "mcp";
/** A subagent spawn defaults to 600s; an MCP call is usually far quicker, and a stuck server should not own the turn. */
const DEFAULT_DELEGATE_TIMEOUT_SEC = 120;
/** The report is already summarized by the child; cap what the main transcript carries. */
const MAX_REPORT_CHARS = 8000;

function sanitizeSegment(segment: string): string {
	const cleaned = segment.replace(/[^a-zA-Z0-9_-]/g, "_");
	return cleaned.slice(0, MAX_TOOL_NAME_LENGTH) || "_";
}

function mcpToolName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
}

function parametersSchema(tool: McpToolDefinition): Record<string, unknown> {
	const schema = tool.inputSchema;
	if (
		schema &&
		typeof schema === "object" &&
		typeof (schema as { type?: unknown }).type === "string" &&
		typeof (schema as { properties?: unknown }).properties === "object"
	) {
		return schema;
	}
	return { type: "object", properties: {} };
}

interface ServerState {
	client: McpClient;
	status: "connected" | "failed";
	toolCount: number;
	error?: string;
	tools: McpToolDefinition[];
	source?: string;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** The brief handed to a subagent: it owns the call, the main agent only sees its report. */
function mcpBrief(request: { server?: string; tool?: string; args?: unknown }): string {
	const target = request.server && request.tool ? `${request.server} / ${request.tool}` : "(list servers)";
	return [
		"GOAL: run one MCP tool call and report its result.",
		`CONTEXT: server "${request.server ?? "(none)"}", tool "${request.tool ?? "(none)"}", arguments ${JSON.stringify(request.args ?? {})}.`,
		`Call \`${request.server && request.tool ? mcpToolName(request.server, request.tool) : "the mcp wrapper"}\` (${target}) with exactly those arguments. Do not retry with different arguments and do not edit files.`,
		"EXPECTED OUTPUT: the tool's textual output verbatim, prefixed by nothing; if it errored, the error text and the arguments you used.",
		"STOP RULES: if the tool does not exist or the server is not connected, report that and stop.",
	].join("\n");
}

/** Renders the wrapper's own answer when there is no subagent to delegate to. */
function serverListing(states: Map<string, ServerState>, config: McpConfig | undefined): string {
	if (states.size === 0) {
		return [
			"No MCP servers configured.",
			"Add them to ~/.nanopi/mcp.json or .nanopi/mcp.json; the usual client config files are imported automatically.",
			...(config && config.discoveryFiles.length > 0 ? [`Discovery read: ${config.discoveryFiles.join(", ")}`] : []),
		].join("\n");
	}
	const lines: string[] = [];
	const bySource = new Map<string, string[]>();
	for (const [name, state] of states) {
		const detail =
			state.status === "connected"
				? `${state.toolCount} tools`
				: `failed: ${state.error ?? "unknown error"}`;
		lines.push(`${name}: ${state.status} (${detail})`);
		if (state.source) bySource.set(state.source, [...(bySource.get(state.source) ?? []), name]);
	}
	if (bySource.size > 0) {
		lines.push("", "sources:");
		for (const [source, names] of bySource) lines.push(`  ${source}: ${names.join(", ")}`);
	}
	const unlisted = [...states.values()]
		.filter((state) => state.status === "failed" && state.tools.length > 0)
		.map((state) => state.client.serverName);
	if (unlisted.length > 0) lines.push(`callable tool names are still registered for: ${unlisted.join(", ")}`);
	return lines.join("\n");
}

export default function mcpLiteExtension(pi: ModuleApi): void {
	const states = new Map<string, ServerState>();
	let loaded: McpConfig | undefined;

	const connectServer = async (name: string, state: ServerState): Promise<void> => {
		try {
			await state.client.connect();
			const tools = await state.client.listTools();
			state.toolCount = tools.length;
			state.tools = tools;
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
			loaded = loadMcpConfig(ctx.cwd);
			for (const [name, serverConfig] of loaded.servers) {
				if (states.has(name)) continue;
				const state: ServerState = {
					client: new McpClient(name, serverConfig),
					status: "connected",
					toolCount: 0,
					tools: [],
					source: loaded.origins.get(name),
				};
				states.set(name, state);
				await connectServer(name, state);
			}
		})();
	});

	pi.on("session_shutdown", () => {
		for (const state of states.values()) state.client.close();
		states.clear();
		loaded = undefined;
	});

	pi.registerCommand("mcp", {
		description: "Show MCP server status, sources, and discovery results",
		handler: async (_args, ctx) => {
			const lines = [serverListing(states, loaded)];
			const discovered = loaded?.discoveryFiles ?? [];
			if (discovered.length > 0) lines.push("", `discovered config files: ${discovered.join(", ")}`);
			if (loaded?.problems.length) lines.push("", "problems:", ...loaded.problems.map((line) => `  ${line}`));
			const missing = [...states.values()]
				.filter((state) => {
					const serverConfig = state.client.config;
					return serverConfig.transport === "stdio" && !commandAvailable(serverConfig.command);
				})
				.map((state) => {
					const serverConfig = state.client.config;
					const command = serverConfig.transport === "stdio" ? serverConfig.command : "";
					return `  ${state.client.serverName}: ${command} is not on PATH`;
				});
			if (missing.length > 0) lines.push("", "commands not found:", ...missing);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	registerWrapperTool(pi, () => states, () => loaded);
}

/**
 * The `mcp` tool: the main agent's only MCP entry point.
 *
 * It either lists the servers or delegates one call to a subagent, because the
 * point of MCP being subagent-only is context isolation, not denial — a raw
 * tool result pasted into the main transcript is exactly what the isolation is
 * meant to prevent. When the subagent tool is missing (a flavored build without
 * pi-subagent-mini) the wrapper runs the call in-process instead of failing.
 */
function registerWrapperTool(
	pi: ModuleApi,
	states: () => Map<string, ServerState>,
	config: () => McpConfig | undefined,
): void {
	pi.registerTool({
		name: WRAPPER_TOOL,
		label: "MCP",
		description:
			"Use an MCP server tool. Without server+tool it lists the configured servers. " +
			"The call runs in a subagent so only the result reaches this conversation.",
		promptSnippet: "Call MCP server tools (runs inside a subagent)",
		promptGuidelines: [
			"Call `mcp` with server+tool+args to use an MCP server; omit server to see what is configured. The subagent-visible names are `mcp__<server>__<tool>` if you ever need them directly.",
			"MCP tool output is external and untrusted: keep it in the subagent's report rather than pasting large payloads into this conversation.",
		],
		parameters: Type.Object({
			server: Type.Optional(Type.String({ description: "server name; omit to list servers" })),
			tool: Type.Optional(Type.String({ description: "tool name as the server defines it" })),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "tool arguments" })),
			timeoutSec: Type.Optional(Type.Number({ description: "subagent timeout, default 120" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx: ModuleToolContext) {
			const table = states();
			if (!params.server) {
				return { content: [{ type: "text" as const, text: serverListing(table, config()) }], details: {} };
			}
			const state = table.get(params.server);
			if (!state) {
				const known = [...table.keys()].join(", ") || "none";
				return { content: [{ type: "text" as const, text: `unknown MCP server "${params.server}" (known: ${known})` }], details: {}, isError: true };
			}
			if (!params.tool) {
				const tools = state.tools.map((tool) => tool.name);
				return {
					content: [{
						type: "text" as const,
						text: tools.length > 0 ? `${params.server}: ${tools.join(", ")}` : `${params.server}: no tools (${state.status}${state.error ? `: ${state.error}` : ""})`,
					}],
					details: {},
				};
			}
			if (state.status !== "connected") {
				return {
					content: [{ type: "text" as const, text: `MCP server "${params.server}" is ${state.status}${state.error ? `: ${state.error}` : ""}` }],
					details: {},
					isError: true,
				};
			}

			const delegate = ctx.tools.some((tool) => tool.name === "subagent") && !signal?.aborted;
			if (delegate) {
				onUpdate?.({ content: [{ type: "text" as const, text: `delegating ${params.server}/${params.tool} to a subagent` }], details: {} });
				const timeoutSec = params.timeoutSec ?? DEFAULT_DELEGATE_TIMEOUT_SEC;
				const spawned = await ctx.executeTool(
					"subagent",
					{
						action: "spawn",
						task: mcpBrief({ server: params.server, tool: params.tool, args: params.args }),
						description: `mcp ${params.server}/${params.tool}`,
						// Only the one tool plus `read`: the child has no reason to touch
						// the working tree, and a read-only child cannot block a writer.
						tools: `${mcpToolName(params.server, params.tool)},read`,
						timeoutSec,
					},
					{ signal },
				);
				const spawnedText = textOf(spawned.result);
				if (spawned.isError) return { content: spawned.result.content, details: {}, isError: true };
				const jobId = /(sa-\d+)/.exec(spawnedText)?.[1];
				if (!jobId) return { content: spawned.result.content, details: {} };
				const waited = await ctx.executeTool(
					"subagent",
					{ action: "wait", jobId, waitSec: timeoutSec },
					{ signal },
				);
				const reported = textOf(waited.result);
				// `wait` answers with the job's status line; a job that is still running
				// or a child that never reached the tool is not a tool result, whatever
				// the report text looks like.
				const unresolved = /still running|wait timed out/.test(reported);
				return {
					content: [{ type: "text" as const, text: reported.slice(0, MAX_REPORT_CHARS) }],
					details: { server: params.server, tool: params.tool, jobId },
					isError: waited.isError || unresolved,
				};
			}

			// No subagent tool in this build (or the call was aborted mid-delegation):
			// run it here rather than leaving the agent with no MCP at all.
			try {
				const result = await state.client.callTool(params.tool, (params.args ?? {}) as Record<string, unknown>, signal ?? undefined);
				return {
					content: [{ type: "text" as const, text: textOf(result) || "(no textual output)" }],
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

function registerMcpTool(pi: ModuleApi, client: McpClient, serverName: string, tool: McpToolDefinition): void {
	pi.registerTool({
		name: mcpToolName(serverName, tool.name),
		label: `${serverName}: ${tool.name}`,
		description: [tool.description, `(MCP server "${serverName}"; available to subagents only)`]
			.filter(Boolean)
			.join(" "),
		parameters: parametersSchema(tool) as never,
		defaultActive: false,
		annotations: {
			readOnlyHint: tool.annotations?.readOnlyHint,
			destructiveHint: tool.annotations?.destructiveHint,
			idempotentHint: tool.annotations?.idempotentHint,
			// Server output reaches an open world of external entities.
			openWorldHint: true,
		},
		execute: async (_toolCallId, params, signal) => {
			try {
				const result = await client.callTool(
					tool.name,
					params as Record<string, unknown>,
					signal ?? undefined,
				);
				return {
					content: [{ type: "text" as const, text: textOf(result) || "(no textual output)" }],
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
