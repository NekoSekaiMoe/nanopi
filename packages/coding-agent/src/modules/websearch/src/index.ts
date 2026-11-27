/**
 * websearch: keyless web search and page reading for nanopi. One `web` tool
 * keeps the engine chain in the model's tool list. Configuration lives in
 * `websearch.json` next to settings.json, with env vars as the fallback;
 * see ./README.md.
 */

import type { ModuleEventsSurface, ModuleToolsSurface } from "@nanopi/pi-coding-agent";
import { registerWebTools } from "./tools.ts";

export default function websearchExtension(pi: ModuleEventsSurface & ModuleToolsSurface): void {
	registerWebTools(pi);
}
