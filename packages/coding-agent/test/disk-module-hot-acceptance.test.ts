import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModuleRegistry } from "../src/core/modules/registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * The acceptance criteria from the issue, on the real loader and a real
 * registry: edit one command's description, delete a file, add one back.
 */
describe("hot reload acceptance", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let file: string;

	const moduleSource = (description: string, withTool = true) => `export default {
  name: "hello",
  factory: (nanopi) => {
    nanopi.registerCommand("hello", { description: ${JSON.stringify(description)}, handler: async () => {} });
    ${
			withTool
				? `nanopi.registerTool({
      name: "hello_tool",
      description: "hello tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "hi" }] }),
    });`
				: ""
		}
  },
};`;

	beforeEach(() => {
		root = join(tmpdir(), `nanopi-accept-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(root, "agent");
		cwd = join(root, "proj");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		file = join(agentDir, "extensions", "hello.ts");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const startup = async () => {
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, modules: [] });
		await loader.reload();
		const snapshot = loader.getModules();
		const registry = new ModuleRegistry([...snapshot.modules], snapshot.runtime, cwd, {} as never, {} as never);
		return { loader, registry };
	};

	it("sees a changed command description without a restart", async () => {
		writeFileSync(file, moduleSource("v1"));
		const { loader, registry } = await startup();
		expect(registry.getCommand("hello")?.description).toBe("v1");

		writeFileSync(file, moduleSource("v2"));
		await loader.reloadDiskModules(registry);

		expect(registry.getCommand("hello")?.description).toBe("v2");
	});

	it("drops a deleted file's tool and command", async () => {
		writeFileSync(file, moduleSource("v1"));
		const { loader, registry } = await startup();
		expect(registry.getAllRegisteredTools().map((tool) => tool.definition.name)).toEqual(["hello_tool"]);

		rmSync(file);
		await loader.reloadDiskModules(registry);

		expect(registry.getAllRegisteredTools()).toEqual([]);
		expect(registry.getCommand("hello")).toBeUndefined();
	});

	it("picks up a file that appears later", async () => {
		const { loader, registry } = await startup();
		expect(registry.getCommand("hello")).toBeUndefined();

		writeFileSync(file, moduleSource("added"));
		await loader.reloadDiskModules(registry);

		expect(registry.getCommand("hello")?.description).toBe("added");
		expect(registry.getAllRegisteredTools().map((tool) => tool.definition.name)).toEqual(["hello_tool"]);
	});

	it("survives 50 reloads without accumulating modules or tools", async () => {
		writeFileSync(file, moduleSource("v0"));
		const { loader, registry } = await startup();

		for (let index = 1; index <= 50; index++) {
			writeFileSync(file, moduleSource(`v${index}`));
			await loader.reloadDiskModules(registry);
		}

		expect(registry.getModuleNames()).toEqual(["hello"]);
		expect(registry.getAllRegisteredTools()).toHaveLength(1);
		expect(registry.getCommand("hello")?.description).toBe("v50");
	});
});
