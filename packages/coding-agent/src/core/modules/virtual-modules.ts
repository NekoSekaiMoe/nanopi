/**
 * Bare specifiers a module file in a *bundled* build resolves to, and the
 * already-loaded namespaces they map to.
 *
 * The bundle has no per-module files: `dist/bundle/` holds esbuild output, and
 * a path-based alias there would either point at nothing or at the unbundled
 * `dist/` tree, which is a second copy of the host. A module file that got that
 * copy would build `Text`, `CustomEditor`, or `ToolDefinition` objects the
 * running process does not recognize — `instanceof` and the class-keyed theme
 * registry both fail across two copies.
 *
 * jiti's `virtualModules` answers from this map instead of touching the disk,
 * so a module sees the exact instances the CLI runs. Source checkouts and
 * unbundled installs do not need it: there the alias points at the same files
 * the host itself imported.
 *
 * This module imports the package root, which reaches back here through
 * `resource-loader` -> `jiti-loader`, so `jiti-loader` loads it lazily. A static
 * import would evaluate this object before the root barrel finished, leaving
 * every entry `undefined`.
 */

import * as hostAgentCore from "@nanopi/pi-agent-core";
import * as hostAi from "@nanopi/pi-ai";
import * as hostTui from "@nanopi/pi-tui";
import * as hostTypebox from "typebox";
import * as hostTypeboxCompile from "typebox/compile";
import * as hostTypeboxValue from "typebox/value";
import * as hostRoot from "../../index.ts";
import * as hostModules from "../../modules-api.ts";
import * as hostUi from "../../ui.ts";

/** Modules available to a module file in a bundled runtime. */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	"@nanopi/pi-coding-agent": hostRoot,
	"@nanopi/pi-coding-agent/modules": hostModules,
	"@nanopi/pi-coding-agent/ui": hostUi,
	"@nanopi/pi-agent-core": hostAgentCore,
	"@nanopi/pi-ai": hostAi,
	"@nanopi/pi-tui": hostTui,
	// A tool definition's schema has to come from the TypeBox instance the host
	// validates with; a second copy is a second set of schema objects.
	typebox: hostTypebox,
	"typebox/compile": hostTypeboxCompile,
	"typebox/value": hostTypeboxValue,
};
