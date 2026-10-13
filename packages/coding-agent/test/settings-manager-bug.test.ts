import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Tests for the fix to a bug where external file changes to arrays were overwritten.
 *
 * The bug scenario was:
 * 1. nanopi starts with settings.json containing packages: ["npm:some-pkg"]
 * 2. User externally edits file to packages: []
 * 3. User changes an unrelated setting (e.g., theme) via UI
 * 4. save() would overwrite packages back to ["npm:some-pkg"] from stale in-memory state
 *
 * The fix tracks which fields were explicitly modified during the session, and only
 * those fields override file values during save().
 */
describe("SettingsManager - External Edit Preservation", () => {
	const testDir = join(process.cwd(), "test-settings-bug-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".nanopi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should preserve file changes to extensions array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.json");

		writeFileSync(
			settingsPath,
			JSON.stringify({
				theme: "dark",
				extensions: ["/old/extension.ts"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		// User externally updates extensions
		const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		currentSettings.extensions = ["/new/extension.ts"];
		writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

		// Change unrelated setting
		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));

		// With the fix, extensions should be preserved (not reverted to startup value)
		expect(savedSettings.extensions).toEqual(["/new/extension.ts"]);
	});
});
