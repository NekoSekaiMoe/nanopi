import type { InlineExtension } from "../core/extensions/types.ts";
import builtinCommandsExtension from "./builtin-commands/index.ts";
import codexCompactionExtension from "./codex-compaction/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	{ name: "builtin-commands", factory: builtinCommandsExtension, builtin: true },
	{ name: "codex-compaction", factory: codexCompactionExtension, builtin: true },
];
