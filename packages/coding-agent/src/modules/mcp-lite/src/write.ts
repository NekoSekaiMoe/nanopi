/**
 * Writing `mcp.json`.
 *
 * mcp-lite could read the config and never write it, which left the one shape
 * MCP actually needs — "add this server" — as a hand-edit of a JSON file whose
 * server schema differs per transport. `nanopi mcp add` / `remove` close that
 * asymmetry from the CLI, and both write through this file:
 *
 * - the user's global `mcp.json` by default, the project `.nanopi/mcp.json` on
 *   request, so a team server and a personal one do not have to share a file;
 * - other top-level keys (`discovery`) and servers this command did not touch
 *   stay exactly as they were, because the file is also a hand-edited document;
 * - the write is one rename, so a crash mid-add cannot truncate the servers
 *   that were already there.
 *
 * Path resolution lives here rather than in the CLI: the webui reads MCP config
 * through the same module, and two callers deriving `agentDir` separately is
 * how a user who moved their config gets read from one place and written to
 * another.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "./client.ts";
import { readJsonConfig } from "./config.ts";

/** Which `mcp.json` a write goes to. */
export type McpConfigScope = "global" | "project";

export interface McpWriteTarget {
	scope: McpConfigScope;
	file: string;
}

export class McpConfigError extends Error {}

/** The two files mcp-lite reads; `global` is the user's, `project` is the checkout's. */
export function resolveWriteTarget(
	scope: McpConfigScope,
	options: { cwd: string; agentDir: string },
): McpWriteTarget {
	return {
		scope,
		file: scope === "global" ? join(options.agentDir, "mcp.json") : join(options.cwd, ".nanopi", "mcp.json"),
	};
}

/** JSON with the indentation the file already uses, so a hand-edited file stays hand-editable. */
function detectIndent(text: string): string {
	for (const line of text.split("\n")) {
		const match = /^(\s+)"/u.exec(line);
		if (match) return match[1].startsWith("\t") ? "\t" : match[1];
	}
	return "\t";
}

interface ConfigDocument {
	/** The parsed file, or a fresh `{ mcpServers: {} }` when it does not exist yet. */
	root: Record<string, unknown>;
	servers: Record<string, unknown>;
	/** Existing formatting that a rewrite has to keep. */
	indent: string;
	bom: string;
}

function readDocument(file: string): ConfigDocument {
	if (!existsSync(file)) return { root: {}, servers: {}, indent: "\t", bom: "" };
	const text = readFileSync(file, "utf8");
	const bom = text.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
	const body = bom ? text.slice(1) : text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		// A malformed file is not something an add command may quietly overwrite:
		// the servers in it are the user's, and a parse failure is the only chance
		// to say so before the file is replaced.
		throw new McpConfigError(
			`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it before adding a server`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new McpConfigError(`${file} must contain a JSON object`);
	}
	const root = parsed as Record<string, unknown>;
	const servers = root.mcpServers;
	if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
		throw new McpConfigError(`"mcpServers" in ${file} must be an object`);
	}
	return {
		root,
		servers: (servers as Record<string, unknown> | undefined) ?? {},
		indent: detectIndent(body),
		bom,
	};
}

/** One server entry in the file's own shape, from the parsed form the client reads. */
export function serializeServer(config: McpServerConfig): Record<string, unknown> {
	if (config.transport === "stdio") {
		return {
			transport: "stdio",
			command: config.command,
			...(config.args && config.args.length > 0 ? { args: config.args } : {}),
			...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
			...(config.cwd ? { cwd: config.cwd } : {}),
		};
	}
	return {
		transport: config.transport,
		url: config.url,
		...(config.headers && Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
	};
}

function writeDocument(target: McpWriteTarget, document: ConfigDocument): void {
	if (Object.keys(document.servers).length === 0) delete document.root.mcpServers;
	else document.root.mcpServers = document.servers;
	const text = `${document.bom}${JSON.stringify(document.root, null, document.indent)}\n`;
	mkdirSync(dirname(target.file), { recursive: true });
	// A sibling rename: the file is read at every session start, and a half-written
	// one would report "no servers configured" instead of failing loudly.
	const temporary = `${target.file}.${process.pid}.tmp`;
	writeFileSync(temporary, text, "utf8");
	renameSync(temporary, target.file);
}

export interface AddServerResult {
	target: McpWriteTarget;
	/** True when this replaced an entry of the same name. */
	replaced: boolean;
}

/**
 * Add one server, or fail on a name clash unless `overwrite` is set.
 *
 * Refusing by default is the point: `add` typed twice must not silently replace
 * a server the user spent time configuring, and the message names the flag that
 * says "yes, replace it".
 */
export function addServer(
	name: string,
	config: McpServerConfig,
	target: McpWriteTarget,
	options?: { overwrite?: boolean },
): AddServerResult {
	const trimmed = name.trim();
	if (trimmed.length === 0) throw new McpConfigError("Server name must not be empty");
	if (/\s/u.test(trimmed)) throw new McpConfigError("Server name must not contain whitespace");
	const document = readDocument(target.file);
	const replaced = Object.hasOwn(document.servers, trimmed);
	if (replaced && options?.overwrite !== true) {
		throw new McpConfigError(
			`${trimmed} is already configured in ${target.file}; pass --force to replace it`,
		);
	}
	document.servers[trimmed] = serializeServer(config);
	writeDocument(target, document);
	return { target, replaced };
}

export interface RemoveServerResult {
	target: McpWriteTarget;
	removed: boolean;
}

/** Remove one server from one file. `removed: false` means that file never had it. */
export function removeServer(name: string, target: McpWriteTarget): RemoveServerResult {
	const trimmed = name.trim();
	if (trimmed.length === 0) throw new McpConfigError("Server name must not be empty");
	if (!existsSync(target.file)) return { target, removed: false };
	const document = readDocument(target.file);
	if (!Object.hasOwn(document.servers, trimmed)) return { target, removed: false };
	delete document.servers[trimmed];
	writeDocument(target, document);
	return { target, removed: true };
}

/** Raw `mcpServers` entries of one file, unparsed, for a listing that must not invent a shape. */
export function readServerNames(file: string): string[] {
	if (!existsSync(file)) return [];
	try {
		const parsed = readJsonConfig(file) as { mcpServers?: unknown } | undefined;
		const servers = parsed?.mcpServers;
		return servers && typeof servers === "object" ? Object.keys(servers) : [];
	} catch {
		return [];
	}
}
