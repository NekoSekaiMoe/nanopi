/**
 * websearch: keyless web search and page reading for nanopi, plus DeepWiki
 * questions about public GitHub repositories. One `web` tool keeps the engine
 * chain and repo-grounded answers in the model's tool list without two extra
 * tool names. Configuration lives in `websearch.json` next to settings.json,
 * with env vars as the fallback; see ./README.md.
 */

import type { ModuleCommandsSurface, ModuleEventsSurface, ModuleToolsSurface } from "@nanopi/pi-coding-agent";
import { registerDeepwikiCommand, registerWebTools } from "./tools.ts";

export default function websearchExtension(
	pi: ModuleEventsSurface & ModuleToolsSurface & ModuleCommandsSurface,
): void {
	registerWebTools(pi);
	registerDeepwikiCommand(pi);
}
