/**
 * Built-in modules: compiled-in functionality that used to ship as loaded
 * extensions and bundled extra packages. Everything registers through the
 * programmatic module API (`SessionModule`); nothing is discovered from disk.
 */

import { extraInlineExtension } from "@nanopi/pi-extra";
import askLite from "../../extras/ask-lite/index.ts";
import mcpLite from "../../extras/mcp-lite/src/index.ts";
import piFakeCodex from "../../extras/pi-fake-codex/src/index.ts";
import piFakeOpencode from "../../extras/pi-fake-opencode/src/index.ts";
import piRewind from "../../extras/pi-rewind/src/index.ts";
import piSimplify from "../../extras/pi-simplify/src/index.ts";
import piSmartFlow from "../../extras/pi-smart-flow/src/index.ts";
import piSubagentMini from "../../extras/pi-subagent-mini/src/index.ts";
import piUi from "../../extras/pi-ui/src/index.ts";
import todoLite from "../../extras/todo-lite/index.ts";
import type { SessionModule } from "../core/modules/types.ts";
import builtinCommandsExtension from "./builtin-commands/index.ts";
import codexCompactionExtension from "./codex-compaction/index.ts";
import llamaExtension from "./llama/index.ts";

/** Modules compiled into every nanopi build. Order matters: `extra` loads
 * first so it can answer `project_trust` for `--yolo` before anything else. */
export const BUILTIN_MODULES: SessionModule[] = [
	// Modes/permissions module (packages/extra). Build flavors excluding the
	// "modes" component alias @nanopi/pi-extra to an inert stub whose factory
	// registers nothing.
	{ name: "extra", factory: extraInlineExtension.factory, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension },
	{ name: "builtin-commands", factory: builtinCommandsExtension, hidden: true },
	{ name: "codex-compaction", factory: codexCompactionExtension, hidden: true },
	// Bundled extras (formerly dist/extras packages, now compiled in).
	{ name: "ask-lite", factory: askLite },
	{ name: "mcp-lite", factory: mcpLite, hidden: true },
	{ name: "pi-fake-codex", factory: piFakeCodex },
	{ name: "pi-fake-opencode", factory: piFakeOpencode, hidden: true },
	{ name: "pi-rewind", factory: piRewind },
	{ name: "pi-simplify", factory: piSimplify },
	{ name: "pi-smart-flow", factory: piSmartFlow },
	{ name: "pi-subagent-mini", factory: piSubagentMini },
	{ name: "pi-ui", factory: piUi },
	{ name: "todo-lite", factory: todoLite },
];
