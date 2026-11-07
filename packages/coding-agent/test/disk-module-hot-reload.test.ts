import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { MessageTypeRegistry } from "../src/core/messages/registry.ts";
import { createModuleRuntime, loadModule, ModuleRegistry } from "../src/core/modules/registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/** A module file whose command description is the argument, so a change is observable. */
const commandModule = (description: string, extra = "") => `
export default {
	name: "hot",
	factory: (nanopi) => {
		nanopi.registerCommand("hot", { description: ${JSON.stringify(description)}, handler: async () => {} });
		${extra}
	},
};
`;

const toolModule = (toolName: string) => `
import { Type } from "typebox";

export default {
	name: "hot",
	factory: (nanopi) => {
		nanopi.registerTool({
			name: ${JSON.stringify(toolName)},
			description: "hot tool",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => ({ content: [{ type: "text", text: params.text }] }),
		});
	},
};
`;

describe("disk module hot reload", () => {
	let root: string;
	let projectDir: string;
	let agentDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `nanopi-hot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(root, "project");
		agentDir = join(root, "agent");
		extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const makeLoader = async () => {
		const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
		const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager, modules: [] });
		await loader.reload();
		return loader;
	};

	/** The registry a session would have built from the loader's first snapshot. */
	const makeTarget = (loader: DefaultResourceLoader): ModuleRegistry => {
		const modules = loader.getModules();
		return new ModuleRegistry([...modules.modules], modules.runtime, projectDir, {} as never, {} as never);
	};

	it("reloads one changed file and leaves the description new", async () => {
		writeFileSync(join(extensionsDir, "hot.ts"), commandModule("first"));
		const loader = await makeLoader();
		const registry = makeTarget(loader);
		expect(registry.getCommand("hot")?.description).toBe("first");

		writeFileSync(join(extensionsDir, "hot.ts"), commandModule("second"));
		const result = await loader.reloadDiskModules(registry);

		expect(result.failures).toEqual([]);
		expect(result.applied.map((entry) => entry.action)).toEqual(["reloaded"]);
		expect(registry.getCommand("hot")?.description).toBe("second");
	});

	it("unloads a deleted file: its command and tool disappear", async () => {
		const file = join(extensionsDir, "hot.ts");
		writeFileSync(file, toolModule("hot_tool"));
		const loader = await makeLoader();
		const registry = makeTarget(loader);
		expect(registry.getAllRegisteredTools().map((tool) => tool.definition.name)).toEqual(["hot_tool"]);

		rmSync(file);
		const result = await loader.reloadDiskModules(registry);

		expect(result.applied.map((entry) => entry.action)).toEqual(["unloaded"]);
		expect(registry.getAllRegisteredTools()).toEqual([]);
		expect(registry.getModuleNames()).toEqual([]);
	});

	it("loads a file added after startup", async () => {
		const loader = await makeLoader();
		const registry = makeTarget(loader);
		expect(registry.getCommand("hot")).toBeUndefined();

		writeFileSync(join(extensionsDir, "hot.ts"), commandModule("added"));
		const result = await loader.reloadDiskModules(registry);

		expect(result.applied.map((entry) => entry.action)).toEqual(["loaded"]);
		expect(registry.getCommand("hot")?.description).toBe("added");
	});

	it("does nothing when no file changed", async () => {
		writeFileSync(join(extensionsDir, "hot.ts"), commandModule("same"));
		const loader = await makeLoader();
		const registry = makeTarget(loader);

		const result = await loader.reloadDiskModules(registry);

		expect(result.applied).toEqual([]);
		expect(result.failures).toEqual([]);
	});

	it("keeps the module unloaded when the new contents fail to parse", async () => {
		const file = join(extensionsDir, "hot.ts");
		writeFileSync(file, commandModule("good"));
		const loader = await makeLoader();
		const registry = makeTarget(loader);

		writeFileSync(file, "export default 42;\n");
		const result = await loader.reloadDiskModules(registry);

		expect(result.failures).toHaveLength(1);
		expect(registry.getCommand("hot")).toBeUndefined();
		expect(registry.getModuleNames()).toEqual([]);
	});

	it("does not retry an unchanged broken file on every pass", async () => {
		const file = join(extensionsDir, "hot.ts");
		writeFileSync(file, "export default 42;\n");
		const loader = await makeLoader();
		const registry = makeTarget(loader);
		// The startup scan already failed this file and recorded the reason.
		expect(loader.getModules().errors).toHaveLength(1);

		const first = await loader.reloadDiskModules(registry);
		const second = await loader.reloadDiskModules(registry);

		expect(first.failures).toEqual([]);
		expect(second.failures).toEqual([]);
		expect(second.applied).toEqual([]);
	});

	it("retries a broken file once its contents change", async () => {
		const file = join(extensionsDir, "hot.ts");
		writeFileSync(file, "export default 42;\n");
		const loader = await makeLoader();
		const registry = makeTarget(loader);

		writeFileSync(file, commandModule("fixed"));
		const result = await loader.reloadDiskModules(registry);

		expect(result.failures).toEqual([]);
		expect(registry.getCommand("hot")?.description).toBe("fixed");
		expect(loader.getModules().errors.filter((error) => error.path === file)).toEqual([]);
	});

	it("runs the module's own dispose hook before undoing its registrations", async () => {
		const file = join(extensionsDir, "hot.ts");
		writeFileSync(
			file,
			`
const calls = [];
export default {
	name: "hot",
	factory: (nanopi) => {
		nanopi.registerCommand("hot", { description: "d", handler: async () => {} });
	},
	dispose: () => { globalThis.__hotDisposed = (globalThis.__hotDisposed ?? 0) + 1; },
};
`,
		);
		const loader = await makeLoader();
		const registry = makeTarget(loader);
		expect(registry.getCommand("hot")).toBeDefined();

		rmSync(file);
		await loader.reloadDiskModules(registry);

		expect((globalThis as { __hotDisposed?: number }).__hotDisposed).toBe(1);
		delete (globalThis as { __hotDisposed?: number }).__hotDisposed;
	});

	it("delivers session_shutdown to the unloaded module alone", async () => {
		const keeper = join(extensionsDir, "keeper.ts");
		const going = join(extensionsDir, "going.ts");
		writeFileSync(
			keeper,
			`
export default {
	name: "keeper",
	factory: (nanopi) => {
		nanopi.on("session_shutdown", () => { globalThis.__keeperShutdowns = (globalThis.__keeperShutdowns ?? 0) + 1; });
	},
};
`,
		);
		writeFileSync(
			going,
			`
export default {
	name: "going",
	factory: (nanopi) => {
		nanopi.on("session_shutdown", () => { globalThis.__goingShutdowns = (globalThis.__goingShutdowns ?? 0) + 1; });
	},
};
`,
		);
		const loader = await makeLoader();
		const registry = makeTarget(loader);
		expect([...registry.getModuleNames()].sort()).toEqual(["going", "keeper"]);

		rmSync(going);
		await loader.reloadDiskModules(registry);

		const globals = globalThis as { __keeperShutdowns?: number; __goingShutdowns?: number };
		expect(globals.__goingShutdowns).toBe(1);
		expect(globals.__keeperShutdowns).toBeUndefined();
		delete globals.__keeperShutdowns;
		delete globals.__goingShutdowns;
	});
});

describe("hot reload swap keeps the registry identity", () => {
	it("setModules replaces the list without rebuilding the registry", async () => {
		const eventBus = createEventBus();
		const runtime = createModuleRuntime();
		const messageTypes = new MessageTypeRegistry();
		const first = await loadModule(
			{
				name: "one",
				factory: (nanopi) => {
					nanopi.registerCommand("one", { description: "1", handler: async () => {} });
				},
			},
			{ cwd: process.cwd(), eventBus, runtime, messageTypes, loadedNames: [] },
		);
		const registry = new ModuleRegistry([first], runtime, process.cwd(), {} as never, {} as never);
		const before = registry;

		registry.setModules([]);

		expect(registry).toBe(before);
		expect(registry.getCommand("one")).toBeUndefined();
	});
});
