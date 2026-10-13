/**
 * mcp-lite config: `~/.nanopi/mcp.json` (global) plus `.nanopi/mcp.json`
 * (project, per-server override), mirroring the pi-mcp-extension layout:
 *
 * { "mcpServers": { "name": { "transport": "stdio", "command": "npx", "args": [...] } } }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "./client.ts";

const ENV_AGENT_DIR = "NANOPI_CODING_AGENT_DIR";

export interface McpConfig {
	servers: Map<string, McpServerConfig>;
	sources: string[];
}

function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) return envDir;
	return join(homedir(), ".nanopi", "agent");
}

function parseServerEntry(name: string, value: unknown): McpServerConfig | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const transport = record.transport;
	if (transport === "stdio" && typeof record.command === "string") {
		return {
			transport: "stdio",
			command: record.command,
			...(Array.isArray(record.args) && record.args.every((a) => typeof a === "string")
				? { args: record.args as string[] }
				: {}),
			...(record.env && typeof record.env === "object" ? { env: record.env as Record<string, string> } : {}),
			...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
		};
	}
	if ((transport === "http" || transport === "sse" || transport === "streamable-http") && typeof record.url === "string") {
		return {
			transport: transport === "streamable-http" ? "http" : (transport as "http" | "sse"),
			url: record.url,
			...(record.headers && typeof record.headers === "object"
				? { headers: record.headers as Record<string, string> }
				: {}),
		};
	}
	void name;
	return undefined;
}

function readConfigFile(file: string): Map<string, McpServerConfig> {
	const servers = new Map<string, McpServerConfig>();
	if (!existsSync(file)) return servers;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		const mcpServers =
			parsed && typeof parsed === "object" ? (parsed as { mcpServers?: unknown }).mcpServers : undefined;
		if (!mcpServers || typeof mcpServers !== "object") return servers;
		for (const [name, value] of Object.entries(mcpServers as Record<string, unknown>)) {
			const config = parseServerEntry(name, value);
			if (config) servers.set(name, config);
		}
	} catch {
		// Malformed config files are skipped; /mcp reports the servers that did load.
	}
	return servers;
}

/** Global config, then project overrides per server name. */
export function loadMcpConfig(cwd: string): McpConfig {
	const globalFile = join(getAgentDir(), "mcp.json");
	const projectFile = join(cwd, ".nanopi", "mcp.json");
	const servers = readConfigFile(globalFile);
	const sources: string[] = [];
	if (servers.size > 0) sources.push(globalFile);
	const projectServers = readConfigFile(projectFile);
	for (const [name, config] of projectServers) {
		servers.set(name, config);
	}
	if (projectServers.size > 0) sources.push(projectFile);
	return { servers, sources };
}
