/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   nanopi -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@nanopi/pi-coding-agent";
import { createBashTool } from "@nanopi/pi-coding-agent";

export default function (nanopi: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, NANOPI_SPAWN_HOOK: "1" },
		}),
	});

	nanopi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
