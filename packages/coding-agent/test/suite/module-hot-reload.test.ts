import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("module hot reload on a live session", () => {
	it("refreshes the tool list the model sees after a module is unloaded", async () => {
		let unloaded = false;
		const harness = await createHarness({
			modules: [
				{
					name: "hot",
					factory: (nanopi) => {
						nanopi.registerTool({
							name: "hot_tool",
							label: "hot_tool",
							description: "hot",
							parameters: { type: "object", properties: {} },
							execute: async () => ({ content: [{ type: "text", text: "hot" }], details: {} }),
						});
						nanopi.on("session_shutdown", () => {
							unloaded = true;
						});
					},
				},
			],
		});
		try {
			expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("hot_tool");

			await harness.session.moduleRegistry.unloadModule("hot");

			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("hot_tool");
			expect(unloaded).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("applies the swap when the session is idle", async () => {
		const harness = await createHarness({
			modules: [
				{
					name: "hot",
					factory: (nanopi) => {
						nanopi.registerCommand("hot", { description: "d", handler: async () => {} });
					},
				},
			],
		});
		try {
			expect(harness.session.isIdle).toBe(true);
			await expect(harness.session.reloadDiskModules()).resolves.toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("refuses while a reload is already in flight", async () => {
		const harness = await createHarness({ modules: [] });
		try {
			// The state machine is the single gate: a swap cannot interleave with
			// another one, whatever triggered it.
			(harness.session as unknown as { _runtimeAvailability: string })._runtimeAvailability = "reloading";
			await expect(harness.session.reloadDiskModules()).rejects.toThrow("Runtime reload in progress");
		} finally {
			harness.cleanup();
		}
	});
});
