/**
 * MCP server auto-discovery.
 *
 * A hand-written `~/.nanopi/mcp.json` stays authoritative, but a machine that
 * already has MCP servers configured for another client should not need the
 * list copied over. Every client offers the same `mcpServers` object under a
 * different path and a slightly different server shape, so discovery reads the
 * known paths, normalizes them, and merges them *under* the user's own entries.
 *
 * The reference point is what the four harnesses we compared do:
 *
 * - Codex reads `<CODEX_HOME>/config.toml` plus `.codex/config.toml` layers up
 *   from cwd (project trust required, credential-only keys stripped).
 * - pi reads `<agentDir>/mcp.json` plus a trusted `<project>/.pi/mcp.json`.
 * - dsh mounts one plugin per server in its own config; no foreign files.
 * - ZCode imports Claude/OpenCode/Cursor configs through a user-directory
 *   (`.claude.json`, `.config/opencode/*.json`, …) with a per-source file format
 *   and a per-server `enabled` flag.
 *
 * None of them scans *every* client by default, and none of them applies a
 * silent import: an unexpected server that suddenly has tools is a security
 * surprise, not a convenience. So discovery is: known paths only, project-level
 * files only from a trusted or explicitly opted-in project, native shape only
 * for the `mcpServers` key that all clients share, and status always visible in
 * `/mcp` with the path each entry came from.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "./client.ts";
import { commandAvailable } from "./executables.ts";

export type ConfigFormat = "mcpServers" | "mcp.servers" | "vs-mcp";

export interface DiscoverySource {
	/** Human label shown by `/mcp`. */
	label: string;
	file: string;
	format: ConfigFormat;
	/** Project sources are skipped when discovery is restricted to global scope. */
	scope: "global" | "project";
}

export interface DiscoveryOptions {
	cwd: string;
	home: string;
	/** Values merged into the process env before `${VAR}` expansion. */
	env?: Record<string, string | undefined>;
	/** Restrict to global (user-level) files; project files can start arbitrary commands. */
	globalOnly?: boolean;
	/** Extra files copied verbatim from the config (`discovery.include`). */
	include?: string[];
	/** Files that must not be read. */
	exclude?: string[];
	/** Defaults on; off means only `mcp.json` is loaded. */
	enabled: boolean;
}

export interface DiscoveredServer {
	name: string;
	config: McpServerConfig;
	source: string;
}

export interface DiscoveryResult {
	servers: DiscoveredServer[];
	/** Files that were read, in merge order (later wins). */
	sources: string[];
	/** One line per skipped/unreadable file, shown by `/mcp`. */
	problems: string[];
}

function descriptor(label: string, file: string, format: ConfigFormat, scope: "global" | "project"): DiscoverySource {
	return { label, file, format, scope };
}

/** The paths every client actually uses, in ascending precedence. */
export function discoverySources(home: string, cwd: string): DiscoverySource[] {
	const appData = process.env.APPDATA;
	const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
	return [
		descriptor("claude-desktop", path.join(appData ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json"), "mcpServers", "global"),
		descriptor("claude-desktop", path.join(home, ".config", "Claude", "claude_desktop_config.json"), "mcpServers", "global"),
		descriptor("claude-desktop", path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "mcpServers", "global"),
		descriptor("cursor", path.join(home, ".cursor", "mcp.json"), "mcpServers", "global"),
		descriptor("windsurf", path.join(home, ".codeium", "windsurf", "mcp_config.json"), "mcpServers", "global"),
		descriptor("vscode", path.join(appData ?? "", "Code", "User", "mcp.json"), "vs-mcp", "global"),
		descriptor("vscode", path.join(xdgConfig, "Code", "User", "mcp.json"), "vs-mcp", "global"),
		descriptor("vscode", path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"), "vs-mcp", "global"),
		descriptor("codex", path.join(home, ".codex", "config.toml"), "mcp.servers", "global"),
		descriptor("zcode", path.join(home, ".zcode", "cli", "config.json"), "mcp.servers", "global"),
		descriptor("opencode", path.join(xdgConfig, "opencode", "opencode.json"), "mcp.servers", "global"),
		descriptor("opencode", path.join(xdgConfig, "opencode", "opencode.jsonc"), "mcp.servers", "global"),
		descriptor("project", path.join(cwd, ".mcp.json"), "mcpServers", "project"),
		descriptor("project", path.join(cwd, ".vscode", "mcp.json"), "vs-mcp", "project"),
		descriptor("project", path.join(cwd, ".cursor", "mcp.json"), "mcpServers", "project"),
		descriptor("project", path.join(cwd, ".codex", "config.toml"), "mcp.servers", "project"),
		descriptor("project", path.join(cwd, ".agents", "mcp.json"), "mcpServers", "project"),
	];
}

/** `${VAR}` and `${VAR:-default}` expansion; an unknown variable keeps the literal text. */
export function expandEnv(value: string, env: Record<string, string | undefined>): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback?: string) => {
		const resolved = env[name];
		if (resolved !== undefined) return resolved;
		return fallback ?? match;
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
	const record = asRecord(value);
	if (!record || !Object.values(record).every((entry) => typeof entry === "string")) return undefined;
	return record as Record<string, string>;
}

/**
 * One server entry, normalized from any of the shapes clients use.
 *
 * Differences handled: `command` as a string with separate `args` (Claude,
 * Cursor, Codex, VS Code) versus a single argv array (OpenCode); the
 * discriminator spelled `type` (VS Code `stdio`/`http`), `transport`
 * (nanopi/pi) or nothing at all; `url` present means a remote server whatever
 * the key says; `disabled`/`enabled` opposite polarities.
 */
export function normalizeServer(raw: unknown, env: Record<string, string | undefined>): McpServerConfig | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	if (record.enabled === false || record.disabled === true) return undefined;

	const headers = stringMap(record.headers);
	const expandAll = (record: Record<string, string>): Record<string, string> =>
		Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expandEnv(value, env)]));
	const url = typeof record.url === "string" ? expandEnv(record.url, env) : undefined;
	if (url) {
		const declared = record.transport ?? record.type;
		const transport = declared === "sse" ? "sse" : "http";
		return { transport, url, ...(headers ? { headers: expandAll(headers) } : {}) };
	}

	const commandField = record.command;
	const argv = Array.isArray(commandField) ? stringArray(commandField) : undefined;
	const command = typeof commandField === "string" ? commandField : argv?.[0];
	if (!command) return undefined;
	const args = argv ? argv.slice(1) : (stringArray(record.args) ?? []);
	const commandEnv = stringMap(record.env);
	return {
		transport: "stdio",
		command: expandEnv(command, env),
		...(args.length > 0 ? { args: args.map((arg) => expandEnv(arg, env)) } : {}),
		...(commandEnv ? { env: expandAll(commandEnv) } : {}),
		...(typeof record.cwd === "string" ? { cwd: expandEnv(record.cwd, env) } : {}),
	};
}

/** `[mcp_servers.<name>]` tables out of a TOML file, flattened to the JSON shape. */
export function serversFromToml(text: string, env: Record<string, string | undefined>): Map<string, unknown> {
	const servers = new Map<string, unknown>();
	let current: Record<string, unknown> | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const header = /^\[\[?\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\]?$/.exec(line);
		if (header) {
			// Only `[mcp_servers.<name>]` opens a server; deeper tables
			// (`[mcp_servers.x.env]`) fold into the server already in hand.
			const name = header[1] ?? header[2];
			current = (servers.get(name) as Record<string, unknown> | undefined) ?? {};
			servers.set(name, current);
			continue;
		}
		if (line.startsWith("[")) {
			current = undefined;
			continue;
		}
		if (!current) continue;
		const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
		if (!assignment) continue;
		const [, key, valueText] = assignment;
		const value = valueText.replace(/\s+#.*$/, "").trim();
		if (value.startsWith("[") && value.endsWith("]")) {
			const items = value
				.slice(1, -1)
				.split(",")
				.map((item) => parseTomlScalar(item.trim()))
				.filter((item) => item !== undefined);
			current[key] = items;
		} else {
			const scalar = parseTomlScalar(value);
			if (scalar !== undefined) current[key] = scalar;
		}
	}
	void env;
	return servers;
}

function parseTomlScalar(value: string): string | boolean | undefined {
	if (!value) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	const quoted = /^["'](.*)["']$/.exec(value);
	if (quoted) return quoted[1];
	if (/^[-\d._]+$/.test(value)) return value;
	return value;
}

/** JSON with the comments and trailing commas every client's sample config uses. */
function stripJsonc(text: string): string {
	// Strings are preserved so a `//` inside a URL survives.
	let out = "";
	let inString = false;
	let quote = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const next = text[index + 1];
		if (inString) {
			out += char;
			if (char === "\\") {
				out += next ?? "";
				index++;
			} else if (char === quote) {
				inString = false;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			quote = char;
			out += char;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index++;
			out += "\n";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
			index++;
			continue;
		}
		out += char;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

function serverMapFrom(parsed: unknown, format: ConfigFormat): Map<string, unknown> {
	const root = asRecord(parsed);
	if (!root) return new Map();
	if (format === "vs-mcp") {
		// `.vscode/mcp.json` and the VS Code user file: { "servers": { ... }, "inputs": [...] }.
		return new Map(Object.entries(asRecord(root.servers) ?? {}));
	}
	if (format === "mcp.servers") {
		const mcp = asRecord(root.mcp);
		const servers = asRecord(mcp?.servers);
		if (servers) return new Map(Object.entries(servers));
		// Codex and pi both accept a top-level `mcp_servers` object.
		return new Map(Object.entries(asRecord(root.mcp_servers) ?? {}));
	}
	return new Map(Object.entries(asRecord(root.mcpServers) ?? {}));
}

export function isTomlFile(file: string): boolean {
	return path.extname(file).toLowerCase() === ".toml";
}

function readServers(source: DiscoverySource, env: Record<string, string | undefined>): Map<string, unknown> {
	const text = readFileSync(source.file, "utf8").replace(/^\uFEFF/, "");
	if (isTomlFile(source.file) || source.format === "mcp.servers" && /^\s*\[/m.test(text)) {
		return serversFromToml(text, env);
	}
	const parsed: unknown = JSON.parse(stripJsonc(text));
	return serverMapFrom(parsed, source.format);
}

/**
 * Every server the configured sources offer, merged in precedence order.
 *
 * Precedence: explicit project files > foreign global files > nothing. Within a
 * file, later entries win; across files, later sources win, matching how every
 * client treats its own layering.
 */
export function discoverServers(options: DiscoveryOptions): DiscoveryResult {
	const result: DiscoveryResult = { servers: [], sources: [], problems: [] };
	if (!options.enabled) return result;
	const env = { ...process.env, ...(options.env ?? {}) };
	const excluded = new Set((options.exclude ?? []).map((entry) => path.resolve(options.cwd, entry)));
	const seenFiles = new Set<string>();

	const candidates: DiscoverySource[] = [
		...discoverySources(options.home, options.cwd).filter((source) => options.globalOnly !== true || source.scope === "global"),
		...(options.include ?? []).map((entry) => descriptor("config", path.resolve(options.cwd, entry), "mcpServers", "project")),
	];

	const merged = new Map<string, DiscoveredServer>();
	for (const source of candidates) {
		const file = path.resolve(source.file);
		if (excluded.has(file) || seenFiles.has(file)) continue;
		if (!existsSync(file)) continue;
		seenFiles.add(file);
		let servers: Map<string, unknown>;
		try {
			servers = readServers(source, env);
		} catch (error) {
			result.problems.push(`${source.file}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		let count = 0;
		for (const [name, raw] of servers) {
			const config = normalizeServer(raw, env);
			if (!config) {
				result.problems.push(`${source.file}: server "${name}" has no command or url (or is disabled)`);
				continue;
			}
			merged.set(name, { name, config, source: source.file });
			count++;
		}
		if (count > 0) result.sources.push(source.file);
	}
	result.servers = [...merged.values()];
	return result;
}

/**
 * Compress repeated "not runnable" problems into one line.
 *
 * A stdio entry whose command is not installed is not an error worth a line per
 * server — it is the state of the machine. The client reports it at connect.
 */
export function unavailableCommands(result: DiscoveryResult): string[] {
	const missing: string[] = [];
	for (const server of result.servers) {
		if (server.config.transport !== "stdio") continue;
		if (commandAvailable(server.config.command)) continue;
		missing.push(`${server.name}: command not found on PATH (${server.config.command})`);
	}
	return missing;
}
