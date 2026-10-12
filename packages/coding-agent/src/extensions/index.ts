import { extraInlineExtension } from "@nanopi/pi-extra";
import type { InlineExtension } from "../core/extensions/types.ts";
import builtinCommandsExtension from "./builtin-commands/index.ts";
import codexCompactionExtension from "./codex-compaction/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	// Modes/permissions module (packages/extra). Inline (not `builtin:`) so it
	// loads before project trust and can answer project_trust for --yolo.
	// Build flavors excluding the "modes" component alias @nanopi/pi-extra to
	// an inert stub whose factory registers nothing.
	extraInlineExtension,
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	{ name: "builtin-commands", factory: builtinCommandsExtension, builtin: true },
	{ name: "codex-compaction", factory: codexCompactionExtension, builtin: true },
];
