/**
 * Minimal tool set (default in the `minimal` build flavor).
 *
 * nanopi declares the default tools (read, bash, edit, write) unless a
 * setting or `--tools` says otherwise. Minimal builds ship only the shell
 * tools, so the loadout has to be narrowed no matter what the settings say.
 * Two points cover it:
 *
 * 1. `session_start` — narrow the initial loadout. The session restores the
 *    loadout declared by the transcript of a resumed session, so this handler
 *    also runs for restored sessions.
 * 2. `before_agent_start` — narrow each run's declared tool set, because a run
 *    can arrive with a loadout from settings, a resumed transcript, or another
 *    module and overwrite the one set at startup.
 *
 * `tool_call` blocks everything else as a backstop: the model must not be able
 * to reach a tool that the build is not supposed to provide, even if a later
 * actor re-adds it.
 */

import type { ModuleApi } from "../../core/modules/types.ts";

/** Shell tools the minimal build keeps. */
const MINIMAL_TOOL_NAMES = new Set(["bash", "powershell"]);

const MINIMAL_GUIDELINE =
	"You are in a minimal build: only the bash tool is available. Use shell commands for everything, including reading and writing files.";

export default function minimalToolsExtension(nanopi: ModuleApi): void {
	const shellTools = () =>
		nanopi
			.getAllTools()
			.filter((tool) => MINIMAL_TOOL_NAMES.has(tool.name))
			.map((tool) => tool.name);
	const narrow = () => {
		const tools = shellTools();
		if (tools.length > 0) nanopi.setActiveTools(tools);
	};

	// Modules load before the session start event, so the tool registry is
	// complete by the time this runs.
	nanopi.on("session_start", narrow);

	nanopi.on("before_agent_start", (event) => {
		const tools = shellTools();
		if (tools.length === 0) return;
		event.systemPromptOptions.selectedTools = tools;
		event.systemPromptOptions.promptGuidelines = [
			...(event.systemPromptOptions.promptGuidelines ?? []),
			MINIMAL_GUIDELINE,
		];
	});

	nanopi.on("tool_call", (event) => {
		if (MINIMAL_TOOL_NAMES.has(event.toolName)) return undefined;
		return {
			block: true,
			reason: `this is a minimal build: only the bash tool is available (blocked ${event.toolName})`,
		};
	});
}
