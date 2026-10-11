import * as bundledNanoPiAgentCore from "@nanopi/pi-agent-core";
import * as bundledNanoPiAiCompat from "@nanopi/pi-ai/compat";
import * as bundledNanoPiAiOauth from "@nanopi/pi-ai/oauth";
import * as bundledNanoPiAiProviders from "@nanopi/pi-ai/providers/all";
import * as bundledNanoPiTui from "@nanopi/pi-tui";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
// This import is safe because loader.ts exports are not re-exported from index.ts.
// Extensions can therefore import from @nanopi/pi-coding-agent.
import * as bundledNanoPiCodingAgent from "../../index.ts";

/** Modules available to extensions in source and compiled binary runtimes. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: bundledTypebox,
	"typebox/compile": bundledTypeboxCompile,
	"typebox/value": bundledTypeboxValue,
	"@sinclair/typebox": bundledTypebox,
	"@sinclair/typebox/compile": bundledTypeboxCompile,
	"@sinclair/typebox/value": bundledTypeboxValue,
	"@nanopi/pi-agent-core": bundledNanoPiAgentCore,
	"@nanopi/pi-tui": bundledNanoPiTui,
	// Extensions resolve the pi-ai root to the compat entrypoint (a strict
	// superset of the core entrypoint): existing extensions using the old
	// global API keep working at runtime until compat is removed.
	"@nanopi/pi-ai": bundledNanoPiAiCompat,
	"@nanopi/pi-ai/compat": bundledNanoPiAiCompat,
	"@nanopi/pi-ai/oauth": bundledNanoPiAiOauth,
	"@nanopi/pi-ai/providers/all": bundledNanoPiAiProviders,
	"@nanopi/pi-coding-agent": bundledNanoPiCodingAgent,
	"@mariozechner/pi-agent-core": bundledNanoPiAgentCore,
	"@mariozechner/pi-tui": bundledNanoPiTui,
	"@mariozechner/pi-ai": bundledNanoPiAiCompat,
	"@mariozechner/pi-ai/compat": bundledNanoPiAiCompat,
	"@mariozechner/pi-ai/oauth": bundledNanoPiAiOauth,
	"@mariozechner/pi-ai/providers/all": bundledNanoPiAiProviders,
	"@mariozechner/pi-coding-agent": bundledNanoPiCodingAgent,
};
