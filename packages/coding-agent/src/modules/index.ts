/**
 * Built-in modules: compiled-in functionality that used to ship as loaded
 * extensions and bundled extra packages. Everything registers through the
 * programmatic module API (`SessionModule`); nothing is discovered from disk.
 *
 * Every module is a buildconfig.json `module/<name>` component. A flavor that
 * disables one leaves both its code and its factory out of the build, so the
 * bundle script must alias the specifier to an inert stub (see
 * scripts/build-modules.mjs). `enabledModules` drops a module whose factory the
 * build removed even without that alias, which keeps the registry honest in
 * source checkouts that only set a flavor.
 */

import { extraInlineExtension } from "@nanopi/pi-extra";
import { isBuildComponentEnabled } from "../build-components.ts";
import type { SessionModule } from "../core/modules/types.ts";
import askLite from "../extras/ask-lite/index.ts";
import mcpLite from "../extras/mcp-lite/src/index.ts";
import piBtw from "../extras/pi-btw/src/index.ts";
import piDeepwiki from "../extras/pi-deepwiki/src/index.ts";
import piFakeCodex from "../extras/pi-fake-codex/src/index.ts";
import piFakeOpencode from "../extras/pi-fake-opencode/src/index.ts";
import piGitTools from "../extras/pi-git-tools/src/index.ts";
import piHostname from "../extras/pi-hostname/src/index.ts";
import piImage from "../extras/pi-image/src/index.ts";
import piLspMini from "../extras/pi-lsp-mini/src/index.ts";
import piMeat from "../extras/pi-meat/src/index.ts";
import piMemory from "../extras/pi-memory/src/index.ts";
import piOutputCompact from "../extras/pi-output-compact/src/index.ts";
import piRewind from "../extras/pi-rewind/src/index.ts";
import piSimplify from "../extras/pi-simplify/src/index.ts";
import piSmartFlow from "../extras/pi-smart-flow/src/index.ts";
import piSubagentMini from "../extras/pi-subagent-mini/src/index.ts";
import piTokenUsage from "../extras/pi-token-usage/src/index.ts";
import piUi from "../extras/pi-ui/src/index.ts";
import todoLite from "../extras/todo-lite/index.ts";
import toolResultStore from "../extras/tool-result-store/index.ts";
import websearch from "../extras/websearch/src/index.ts";
import batchExtension from "./batch/index.ts";
import builtinCommandsExtension from "./builtin-commands/index.ts";
import codexCompactionExtension from "./codex-compaction/index.ts";
import compactionRecallExtension from "./compaction-recall/index.ts";
import contextRecallCoordinator from "./context-recall/coordinator.ts";
import qoderCheckinExtension from "./qoder/index.ts";

/** Modules compiled into every nanopi build. Order matters: `extra` loads
 * first so it can answer `project_trust` for `--yolo` before anything else. */
const BUILTIN_MODULES: SessionModule[] = [
	// Modes/permissions module (packages/extra). Build flavors excluding the
	// "module/extra" component alias @nanopi/pi-extra to an inert stub whose
	// factory registers nothing.
	{ name: "extra", factory: extraInlineExtension.factory, hidden: true },
	{ name: "batch", factory: batchExtension, hidden: true },
	{ name: "builtin-commands", factory: builtinCommandsExtension, hidden: true },
	{ name: "codex-compaction", factory: codexCompactionExtension, hidden: true },
	{ name: "compaction-recall", factory: compactionRecallExtension, hidden: true },
	{ name: "context-recall-coordinator", factory: contextRecallCoordinator, hidden: true },
	{ name: "qoder-checkin", factory: qoderCheckinExtension, hidden: true },
	// Bundled extras (formerly dist/extras packages, now compiled in).
	{ name: "ask-lite", factory: askLite },
	{ name: "mcp-lite", factory: mcpLite, hidden: true },
	{ name: "pi-btw", factory: piBtw },
	{ name: "pi-fake-codex", factory: piFakeCodex },
	{ name: "pi-fake-opencode", factory: piFakeOpencode, hidden: true },
	{ name: "pi-image", factory: piImage },
	{ name: "pi-lsp-mini", factory: piLspMini },
	{ name: "pi-memory", factory: piMemory },
	{ name: "pi-rewind", factory: piRewind },
	{ name: "pi-simplify", factory: piSimplify },
	{ name: "pi-smart-flow", factory: piSmartFlow },
	{ name: "pi-subagent-mini", factory: piSubagentMini },
	{ name: "pi-deepwiki", factory: piDeepwiki },
	{ name: "pi-hostname", factory: piHostname },
	{ name: "pi-git-tools", factory: piGitTools },
	{ name: "pi-meat", factory: piMeat },
	{ name: "pi-output-compact", factory: piOutputCompact },
	{ name: "pi-token-usage", factory: piTokenUsage },
	{ name: "pi-ui", factory: piUi },
	{ name: "todo-lite", factory: todoLite },
	{ name: "tool-result-store", factory: toolResultStore },
	{ name: "websearch", factory: websearch },
];

/**
 * The modules this build carries, in `BUILTIN_MODULES` order. Callers pass the
 * result to the resource loader, so a flavor that ships a subset never
 * registers the rest.
 */
export function enabledModules(): SessionModule[] {
	return BUILTIN_MODULES.filter((module) => isBuildComponentEnabled(`module/${module.name}`));
}

// Package-internal: `enabledModules()` is the one entry point; the unfiltered table is what it
// filters, and pairing it here keeps `BUILTIN_MODULES` out of the package root.
export { BUILTIN_MODULES };
