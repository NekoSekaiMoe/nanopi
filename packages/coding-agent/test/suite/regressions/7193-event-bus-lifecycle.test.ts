import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createModuleRuntime, loadModules } from "../../../src/core/modules/registry.ts";
import type { ModuleApi, ModuleFactory, ResourceLoader } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #7193 extension event-bus lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("removes extension-owned event-bus listeners on reload and dispose", async () => {
		const eventBus = createEventBus();
		let extensionCalls = 0;
		let hostCalls = 0;
		let firstApi: ModuleApi | undefined;
		const factory: ModuleFactory = (nanopi) => {
			firstApi ??= nanopi;
			nanopi.events.on("reload:test", () => extensionCalls++);
		};
		eventBus.on("reload:test", () => hostCalls++);

		const loadExtensions = async () => {
			const _runtime = createModuleRuntime();
			const result = await loadModules([{ name: "test", factory }], process.cwd(), eventBus);
			return result;
		};
		let extensionsResult = await loadExtensions();
		const resourceLoader: ResourceLoader = {
			getModules: () => extensionsResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {
				extensionsResult = await loadExtensions();
			},
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindModules({ shutdownHandler: () => {} });

		const emit = async () => {
			const extensionBefore = extensionCalls;
			const hostBefore = hostCalls;
			eventBus.emit("reload:test", undefined);
			await new Promise((resolve) => setImmediate(resolve));
			return { extension: extensionCalls - extensionBefore, host: hostCalls - hostBefore };
		};

		expect(await emit()).toEqual({ extension: 1, host: 1 });
		await harness.session.reload();
		expect(() => firstApi?.getCommands()).toThrow("stale after session replacement or reload");
		expect(await emit()).toEqual({ extension: 1, host: 1 });
		await harness.session.reload();
		expect(await emit()).toEqual({ extension: 1, host: 1 });

		harness.session.dispose();
		expect(await emit()).toEqual({ extension: 0, host: 1 });
	});
});
