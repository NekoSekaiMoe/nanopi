import { hasOAuthFlows } from "../build-components.ts";
import { APP_NAME } from "../config.ts";
import { enabledExportFormats } from "./session-export-formats.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

const ALL_BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "effort", description: "Set thinking effort", argumentHint: "<level>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default; path extension picks .md/.html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "bug", description: "Report a bug to the nanopi developers", argumentHint: "<description>" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "status", description: "Show the current model, session, and usage" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "exit", description: `Quit ${APP_NAME}` },
];

/**
 * Commands this build offers. A build without OAuth flows (buildconfig.json
 * `oauth/*` off, the minimal flavor) has no flow code to log in with, so
 * `/login` and `/logout` only reach an API key dialog at best and report that
 * nothing is stored at worst; the build drops them from autocomplete and from
 * the conflict list. Their handlers stay reachable for API-key logins.
 *
 * `/export` follows the same rule: a build whose flavor drops both export
 * components (the minimal flavor) has nothing to export to. The JSONL export is
 * the session file itself and is not gated, so only a build with no export
 * component at all loses the command.
 */
export function builtinSlashCommands(): ReadonlyArray<BuiltinSlashCommand> {
	const commands = hasOAuthFlows()
		? ALL_BUILTIN_SLASH_COMMANDS
		: ALL_BUILTIN_SLASH_COMMANDS.filter((command) => command.name !== "login" && command.name !== "logout");
	if (enabledExportFormats().length > 0) return commands;
	return commands.filter((command) => command.name !== "export");
}
