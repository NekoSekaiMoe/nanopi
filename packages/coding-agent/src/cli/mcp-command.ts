/**
 * `nanopi mcp add|remove|list` — the write half of mcp-lite.
 *
 * mcp-lite reads `~/.nanopi/mcp.json` and `.nanopi/mcp.json`, discovers a dozen
 * other clients' files, and shows all of it in `/mcp`. Only the writing was
 * missing, so a user who wanted one server had to hand-edit a JSON document
 * whose shape depends on the transport. These three subcommands are the CLI
 * face of `write.ts`; they never start a session, never connect to a server,
 * and never touch a file they were not pointed at.
 *
 * A shell command is the common case and the awkward one — `npx -y pkg …
 * --some-flag` is not a set of flags this parser owns — so everything after
 * `--` is the server's argv, verbatim.
 */

import { APP_NAME, getAgentDir } from "../config.ts";
import type { McpServerConfig } from "../extras/mcp-lite/src/client.ts";
import { loadMcpConfig } from "../extras/mcp-lite/src/config.ts";
import { addServer, type McpConfigScope, removeServer, resolveWriteTarget } from "../extras/mcp-lite/src/write.ts";

export type McpCommandKind = "add" | "remove" | "list";

export interface McpCommand {
	kind: McpCommandKind;
	/** Server name; required by `add` and `remove`, unused by `list`. */
	name?: string;
	/** `add`: false removes from the global file, true from the project's. */
	project: boolean;
	/** `add`: replace an existing entry of the same name. */
	force: boolean;
	/** `remove`: restrict to one file; undefined removes from both. */
	scope?: McpConfigScope;
	/** `add`: the server to write. */
	server?: McpServerConfig;
}

export class McpCommandError extends Error {}

const USAGE = `Usage:
  ${APP_NAME} mcp list
  ${APP_NAME} mcp add <name> --command <command> [args…] [--env KEY=VALUE]… [--cwd <dir>] [--project] [--force]
  ${APP_NAME} mcp add <name> --url <url> [--header NAME=VALUE]… [--project] [--force]
  ${APP_NAME} mcp remove <name> [--project | --global]

Servers go to the user's mcp.json (~/.nanopi/mcp.json) unless --project writes
the checkout's .nanopi/mcp.json instead. Arguments after -- belong to the server
command: ${APP_NAME} mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .`;

export function isMcpCommandHelp(args: string[]): boolean {
	return (
		args[0] === "mcp" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printMcpCommandHelp(): void {
	console.log(USAGE);
}

/** `KEY=VALUE`, the only form both `--env` and `--header` accept. */
function parsePair(flag: string, value: string): [string, string] {
	const at = value.indexOf("=");
	if (at <= 0) throw new McpCommandError(`${flag} expects KEY=VALUE, got "${value}"`);
	return [value.slice(0, at), value.slice(at + 1)];
}

export function parseMcpCommand(args: string[]): McpCommand | undefined {
	if (args[0] !== "mcp") return undefined;
	const kind = args[1];
	if (kind !== "add" && kind !== "remove" && kind !== "list") {
		throw new McpCommandError(
			`Unknown mcp command "${kind ?? ""}". Use "${APP_NAME} mcp list", "${APP_NAME} mcp add", or "${APP_NAME} mcp remove".`,
		);
	}

	const positional: string[] = [];
	/** Server argv typed without `--`: once one word lands here, the rest is the server's. */
	const trailing: string[] = [];
	const env: Record<string, string> = {};
	const headers: Record<string, string> = {};
	let command: string | undefined;
	let url: string | undefined;
	let cwd: string | undefined;
	let project = false;
	let force = false;
	let scope: McpConfigScope | undefined;

	// Split the server's own argv off first: `--` ends the option parsing.
	const separator = args.indexOf("--", 2);
	const own = separator >= 0 ? args.slice(2, separator) : args.slice(2);
	const serverArgv = separator >= 0 ? args.slice(separator + 1) : [];

	for (let index = 0; index < own.length; index++) {
		const arg = own[index];
		const takeValue = (flag: string): string => {
			const value = own[++index];
			if (value === undefined) throw new McpCommandError(`${flag} requires a value`);
			return value;
		};
		// `add fs npx -y pkg` is the same server as `add fs -- npx -y pkg`, and it is
		// what people type first. The name is the only positional this parser owns;
		// from the next word on, the flags belong to the server command.
		if (trailing.length > 0 || (positional.length > 0 && !arg.startsWith("-"))) {
			trailing.push(arg);
			continue;
		}
		if (arg === "--project" || arg === "-p") {
			project = true;
			scope = "project";
			continue;
		}
		if (arg === "--global") {
			if (project) throw new McpCommandError("--global and --project are mutually exclusive");
			scope = "global";
			continue;
		}
		if (arg === "--force" || arg === "-f") {
			force = true;
			continue;
		}
		if (arg === "--command") {
			command = takeValue("--command");
			continue;
		}
		if (arg === "--url") {
			url = takeValue("--url");
			continue;
		}
		if (arg === "--cwd") {
			cwd = takeValue("--cwd");
			continue;
		}
		if (arg === "--env") {
			const [key, value] = parsePair("--env", takeValue("--env"));
			env[key] = value;
			continue;
		}
		if (arg === "--header") {
			const [key, value] = parsePair("--header", takeValue("--header"));
			headers[key] = value;
			continue;
		}
		if (arg.startsWith("-")) throw new McpCommandError(`Unknown option ${arg} for "mcp ${kind}"`);
		positional.push(arg);
	}
	serverArgv.unshift(...trailing);
	if (command === undefined && serverArgv.length > 0) {
		command = serverArgv.shift();
	}

	if (kind === "list") {
		// One list, merged: `list` answers "what can this session reach", so a scope
		// flag would either be ignored or hide the discovery results. Refuse it
		// instead of accepting a flag that does nothing.
		if (scope !== undefined) throw new McpCommandError("mcp list always shows every configured server");
		if (positional.length > 0) throw new McpCommandError("mcp list takes no server name");
		return { kind, project: false, force };
	}

	const name = positional[0];
	if (!name) throw new McpCommandError(`mcp ${kind} requires a server name`);

	if (kind === "remove") {
		if (command !== undefined || url !== undefined) {
			throw new McpCommandError("mcp remove only takes a server name");
		}
		return { kind, name, project: scope === "project", force, scope };
	}

	if (command !== undefined && url !== undefined) {
		throw new McpCommandError("a server has either --command (stdio) or --url (http), not both");
	}
	if (command === undefined && url === undefined) {
		throw new McpCommandError("mcp add requires --command <command> or --url <url>");
	}
	const server: McpServerConfig =
		command !== undefined
			? {
					transport: "stdio",
					command,
					...(serverArgv.length > 0 ? { args: serverArgv } : {}),
					...(Object.keys(env).length > 0 ? { env } : {}),
					...(cwd !== undefined ? { cwd } : {}),
				}
			: {
					transport: "http",
					url: url as string,
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				};
	return { kind, name, project, force, server };
}

/** Human-readable one-line form of a server config, for the list and for the add confirmation. */
function describeServer(config: McpServerConfig): string {
	if (config.transport === "stdio") {
		return ["stdio:", config.command, ...(config.args ?? [])].join(" ");
	}
	return `${config.transport}: ${config.url}`;
}

export function runMcpCommand(command: McpCommand, options: { cwd: string; agentDir?: string }): number {
	const agentDir = options.agentDir ?? getAgentDir();
	if (command.kind === "list") {
		const config = loadMcpConfig(options.cwd, { agentDir });
		if (config.servers.size === 0) {
			process.stdout.write(
				`No MCP servers configured. Add one with \`${APP_NAME} mcp add <name> --command <command>\`.\n`,
			);
			return 0;
		}
		for (const [name, server] of config.servers) {
			const origin = config.origins.get(name);
			process.stdout.write(`${name}\t${describeServer(server)}${origin ? `\t(${origin})` : ""}\n`);
		}
		return 0;
	}

	const scope: McpConfigScope = command.project ? "project" : "global";
	if (command.kind === "add") {
		const target = resolveWriteTarget(scope, { cwd: options.cwd, agentDir });
		const result = addServer(command.name as string, command.server as McpServerConfig, target, {
			overwrite: command.force,
		});
		process.stdout.write(`${result.replaced ? "Replaced" : "Added"} ${command.name} in ${target.file}\n`);
		return 0;
	}

	const targets =
		command.scope === undefined
			? (["global", "project"] as const).map((each) => resolveWriteTarget(each, { cwd: options.cwd, agentDir }))
			: [resolveWriteTarget(command.scope, { cwd: options.cwd, agentDir })];
	let removed = 0;
	for (const target of targets) {
		const result = removeServer(command.name as string, target);
		if (!result.removed) continue;
		removed++;
		process.stdout.write(`Removed ${command.name} from ${target.file}\n`);
	}
	if (removed === 0) {
		// The name may still be present in a discovered file (Cursor, Claude Desktop, …):
		// say which one, or the user is left editing the file this command cannot write.
		const discovered = loadMcpConfig(options.cwd, { agentDir });
		const origin = discovered.origins.get(command.name as string);
		process.stdout.write(
			origin
				? `No entry named ${command.name} in nanopi's own mcp.json; it comes from ${origin}, which ${APP_NAME} does not write. Edit that file instead.\n`
				: `No server named ${command.name} in ${targets.map((target) => target.file).join(" or ")}.\n`,
		);
		return 1;
	}
	return 0;
}
