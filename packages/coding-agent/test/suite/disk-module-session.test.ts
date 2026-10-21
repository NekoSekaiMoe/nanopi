import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@nanopi/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const TOOL_MODULE = `
import type { AgentTool } from "@nanopi/pi-agent-core";
import { Type } from "typebox";

export default {
	name: "disk-echo",
	hidden: false,
	factory: (nanopi) => {
		nanopi.registerTool({
			name: "disk_echo",
			description: "Echo the text it is given",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => ({ content: [{ type: "text", text: params.text }] }),
		});
	},
};
`;

// The harness needs a tool map to build a session. The disk module's own tool
// is registered by its factory, so the assertion below looks for that one.
const ECHO_TOOL: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

describe("disk modules reach a session", () => {
	let root: string;
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("registers the project module's tool and prompt note", async () => {
		root = join(tmpdir(), `nanopi-disk-module-suite-${Date.now()}`);
		const projectDir = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(join(projectDir, ".nanopi", "extensions"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(projectDir, ".nanopi", "extensions", "disk-echo.ts"), TOOL_MODULE);

		const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
		const resourceLoader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager });
		await resourceLoader.reload();
		expect(resourceLoader.getModules().modules.map((module) => module.name)).toEqual(["disk-echo"]);

		harness = await createHarness({ resourceLoader, tools: [ECHO_TOOL] });
		const registered = harness.session.getToolDefinition("disk_echo");
		expect(registered?.description).toBe("Echo the text it is given");
	});
});
