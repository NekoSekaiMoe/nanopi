import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@nanopi/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import type { ModuleApi } from "../../../src/core/modules/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

// A CLI module flag value used to reach modules only once, on the startup
// runtime. /new, /fork, and reload build a fresh module runtime, so `getFlag()`
// read undefined afterwards.
describe("regression #113: module flag values survive session replacement", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `nanopi-module-flags-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModule() {
		return {
			name: "flag-test-module",
			factory: (nanopi: ModuleApi) => {
				nanopi.registerFlag("demo-flag", { type: "string", description: "demo" });
			},
		};
	}

	async function createServices(extensionFlagValues: Map<string, boolean | string>) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		return createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFlagValues,
			resourceLoaderOptions: { modules: [createModule()] },
		});
	}

	it("applies CLI flag values on the startup runtime", async () => {
		const services = await createServices(new Map<string, boolean | string>([["demo-flag", "from-cli"]]));
		expect(services.resourceLoader.getModules().runtime.flagValues.get("demo-flag")).toBe("from-cli");
	});

	it("replays CLI flag values when a session re-binds its modules", async () => {
		const services = await createServices(new Map<string, boolean | string>([["demo-flag", "from-cli"]]));
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		// A replaced session gets a fresh module runtime: drop the startup values.
		services.resourceLoader.getModules().runtime.flagValues.clear();
		await session.bindModules({});

		expect(services.resourceLoader.getModules().runtime.flagValues.get("demo-flag")).toBe("from-cli");
		session.dispose();
	});

	it("leaves modules without CLI values alone", async () => {
		const services = await createServices(new Map<string, boolean | string>());
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		await session.bindModules({});
		expect(services.resourceLoader.getModules().runtime.flagValues.get("demo-flag")).toBeUndefined();
		session.dispose();
	});
});
