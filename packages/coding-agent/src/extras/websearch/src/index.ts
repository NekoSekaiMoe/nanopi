/**
 * websearch: keyless web search and page reading for nanopi.
 *
 * Two tools, one module, no account required. `web_search` walks an engine
 * chain (Firecrawl keyless, Keenable keyless, then Tavily and Exa when keys are
 * configured) and rotates multiple keys per engine on auth, rate-limit, or
 * quota failures. `read_page` fetches one URL as markdown through the engines
 * that can fetch (Firecrawl today).
 *
 * Configuration lives in `websearch.json` next to settings.json, with env vars
 * as the fallback; see ./README.md. Credits: the keyless channels carry their
 * own monthly allowance, so a fresh install searches without a key.
 */

import type { ModuleApi } from "@nanopi/pi-coding-agent";
import { registerWebsearchTools } from "./tools.ts";

export default function websearchExtension(pi: ModuleApi): void {
	registerWebsearchTools(pi);
}
