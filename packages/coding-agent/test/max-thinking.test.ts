import { describe, expect, it } from "vitest";
import { isValidThinkingLevel } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("max thinking level", () => {
	it("is accepted by CLI and settings", async () => {
		expect(isValidThinkingLevel("max")).toBe(true);

		const settings = SettingsManager.inMemory();
		settings.setDefaultThinkingLevel("max");
		await settings.flush();
		expect(settings.getDefaultThinkingLevel()).toBe("max");
	});
});
