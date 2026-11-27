import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { enabledModules } from "../src/modules/index.ts";

describe("built-in module startup (issue #832)", () => {
	it("loads the full built-in module set without extension errors", async () => {
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			settingsManager: SettingsManager.inMemory(),
			modules: enabledModules(),
		});
		await loader.reload();
		expect(loader.getModules().errors).toEqual([]);
	});
});
