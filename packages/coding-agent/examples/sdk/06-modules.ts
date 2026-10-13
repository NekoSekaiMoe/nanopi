/**
 * Programmatic Modules
 *
 * Modules are the only extension mechanism: TypeScript code that registers
 * tools, commands, flags, and event handlers through a ModuleApi. Nothing is
 * discovered from disk - you compose modules in code.
 */

import type { SessionModule } from "@nanopi/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@nanopi/pi-coding-agent";

const myModule: SessionModule = {
	name: "my-logging-module",
	factory: (nanopi) => {
		nanopi.on("agent_start", () => {
			console.log("[module] agent starting");
		});
		nanopi.on("tool_call", (event) => {
			console.log(`[module] tool call: ${event.toolName}`);
		});
	},
};

const resourceLoader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	modules: [myModule],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
	resourceLoader,
	sessionManager: SessionManager.inMemory(),
});

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("List files in the current directory.");
	console.log();
} finally {
	session.dispose();
}
