/**
 * mcp-lite config: `~/.nanopi/mcp.json` (global) plus `.nanopi/mcp.json`
 * (project, per-server override), mirroring the pi-mcp-extension layout:
 *
 * { "mcpServers": { "name": { "transport": "stdio", "command": "npx", "args": [...] } } }
 *
 * Both files also accept `discovery` (see `resolveDiscovery`) to control the
 * automatic import of MCP servers configured for other clients.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "./client.ts";
import { discoverServers, type DiscoveryOptions } from "./discover.ts";

const ENV_AGENT_DIR = "NANOPI_CODING_AGENT_DIR";

export type McpDiscoveryMode = "auto" | "off";

/** `discovery` block, accepted in the global or the project `mcp.json`. */
export interface McpDiscoverySettings {
	mode?: McpDiscoveryMode;
	/** Restrict discovery to user-level files: a project file can start arbitrary commands. */
	globalOnly?: boolean;
	/** Extra config files to read, relative to the project or absolute. */
	include?: string[];
	/** Config files to skip, relative to the project or absolute. */
	exclude?: string[];
}

export interface McpConfig {
	servers: Map<string, McpServerConfig>;
	sources: string[];
	/** Files the servers came from, in merge order (`mcp.json` first). */
	origins: Map<string, string>;
	/** Per-file read errors and skipped entries, surfaced by `/mcp`. */
	problems: string[];
	discovery: McpDiscoverySettings;
	/** Where the file was found, for the status line. */
	discoveryFiles: string[];
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

/** Parse a config file, tolerating the UTF-8 BOM that Windows PowerShell writes. */
function readJsonConfig(file: string): unknown {
	const text = readFileSync(file, "utf8");
	return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function readConfigFile(file: string): Map<string, McpServerConfig> {
	const servers = new Map<string, McpServerConfig>();
	if (!existsSync(file)) return servers;
	try {
		const parsed: unknown = readJsonConfig(file);
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

function readDiscoverySettings(file: string): McpDiscoverySettings {
	if (!existsSync(file)) return {};
	try {
		const parsed: unknown = readJsonConfig(file);
		const block =
			parsed && typeof parsed === "object" ? (parsed as { discovery?: unknown }).discovery : undefined;
		if (!block || typeof block !== "object") return {};
		const record = block as Record<string, unknown>;
		const settings: McpDiscoverySettings = {};
		if (record.mode === "auto" || record.mode === "off") settings.mode = record.mode;
		if (typeof record.globalOnly === "boolean") settings.globalOnly = record.globalOnly;
		const strings = (value: unknown): string[] | undefined =>
			Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
		const include = strings(record.include);
		if (include) settings.include = include;
		const exclude = strings(record.exclude);
		if (exclude) settings.exclude = exclude;
		return settings;
	} catch {
		return {};
	}
}

/** Nothing to import from, and no API to keep stable: auto-discovery is session-wide on unless disabled. */
export function resolveDiscovery(
	globalSettings: McpDiscoverySettings,
	projectSettings: McpDiscoverySettings,
): McpDiscoverySettings {
	return {
		...globalSettings,
		...projectSettings,
		mode: projectSettings.mode ?? globalSettings.mode ?? "auto",
		include: [...(globalSettings.include ?? []), ...(projectSettings.include ?? [])],
		exclude: [...(globalSettings.exclude ?? []), ...(projectSettings.exclude ?? [])],
	};
}

/**
 * Global config, then project overrides per server name, then the servers
 * discovered in other clients' config files.
 *
 * Discovered entries sit *below* the user's own files: an explicit
 * `~/.nanopi/mcp.json` or `.nanopi/mcp.json` entry with the same name wins,
 * which keeps the manual file authoritative while a machine that only ever
 * configured MCP for Cursor or Claude still gets working tools.
 */
export function loadMcpConfig(cwd: string, options: { env?: Record<string, string | undefined>; home?: string } = {}): McpConfig {
	const globalFile = join(getAgentDir(), "mcp.json");
	const projectFile = join(cwd, ".nanopi", "mcp.json");
	const servers = new Map<string, McpServerConfig>();
	const origins = new Map<string, string>();
	const problems: string[] = [];
	const sources: string[] = [];

	const projectServers = readConfigFile(projectFile);
	const globalServers = readConfigFile(globalFile);
	// Global first, then project: a project entry overrides a global one by name.
	const explicit = new Map([...globalServers, ...projectServers]);
	for (const [name, config] of explicit) {
		servers.set(name, config);
		origins.set(name, projectServers.has(name) ? projectFile : globalFile);
	}
	if (globalServers.size > 0) sources.push(globalFile);
	if (projectServers.size > 0) sources.push(projectFile);

	const discovery = resolveDiscovery(readDiscoverySettings(globalFile), readDiscoverySettings(projectFile));
	const discoveryFiles: string[] = [];
	if (discovery.mode !== "off") {
		const discoveryOptions: DiscoveryOptions = {
			cwd,
			home: options.home ?? homedir(),
			env: options.env,
			globalOnly: discovery.globalOnly === true,
			include: discovery.include,
			exclude: discovery.exclude,
			enabled: true,
		};
		const found = discoverServers(discoveryOptions);
		for (const server of found.servers) {
			if (servers.has(server.name)) continue; // the user's own entry wins
			servers.set(server.name, server.config);
			origins.set(server.name, server.source);
		}
		discoveryFiles.push(...found.sources);
		problems.push(...found.problems);
	}

	return { servers, sources, origins, problems, discovery, discoveryFiles };
}
