import { fauxAssistantMessage } from "@nanopi/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ModuleFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

// Ported from earendil-works/pi#11062: a branch recorded its tools before an extension was
// installed, so resuming that branch left the new extension tools inactive.
describe("regression earendil-works/pi#11062: resume activates unrecorded extension tools", () => {
	it("activates a tool the transcript never mentioned and keeps opt-in tools inactive", async () => {
		const first = await createHarness();
		try {
			first.setResponses([fauxAssistantMessage("hello")]);
			await first.session.prompt("hi");
			expect(first.session.getActiveToolNames()).not.toContain("late_tool");

			const modules: ModuleFactory[] = [
				(nanopi) => {
					nanopi.registerTool({
						name: "late_tool",
						label: "Late Tool",
						description: "Registered after the transcript was recorded",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					nanopi.registerTool({
						name: "opt_in_tool",
						label: "Opt-in Tool",
						description: "Registered inactive",
						parameters: Type.Object({}),
						defaultActive: false,
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				},
			];

			const resumed = await createHarness({ sessionManager: first.sessionManager, modules });
			try {
				const active = resumed.session.getActiveToolNames();
				expect(active).toContain("late_tool");
				expect(active).not.toContain("opt_in_tool");
			} finally {
				resumed.cleanup();
			}
		} finally {
			first.cleanup();
		}
	});
});
