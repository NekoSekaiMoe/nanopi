/**
 * Built-in slash commands registered through the extension API so they get the
 * same command context (UI, session, system prompt inspection) as extension
 * commands without a separate dispatch path.
 */

import type { ExtensionAPI } from "@nanopi/pi-coding-agent";
import { registerContext } from "./context.ts";
import { registerInit } from "./init.ts";
import { registerStatus } from "./status.ts";

export default function builtinCommandsExtension(pi: ExtensionAPI): void {
	registerInit(pi);
	registerContext(pi);
	registerStatus(pi);
}
