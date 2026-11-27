import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SessionEntry } from "../src/index.ts";
import { formatKeyFacts } from "../src/modules/codex-compaction/compact.ts";
import codexCompaction from "../src/modules/codex-compaction/index.ts";
import compactionRecall from "../src/modules/compaction-recall/index.ts";
import contextRecallCoordinator from "../src/modules/context-recall/coordinator.ts";

function createRecallTool(): { execute: (...args: any[]) => Promise<any> } {
	const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	const surface = {
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
			tools.set(tool.name, tool);
		},
	};
	contextRecallCoordinator(surface as never);
	return tools.get("recall_context")!;
}

describe("context recall module loading (issue #832)", () => {
	it("registers one recall_context tool when all recall modules load", async () => {
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			settingsManager: SettingsManager.inMemory(),
			modules: [
				{ name: "codex-compaction", factory: codexCompaction },
				{ name: "compaction-recall", factory: compactionRecall },
				{ name: "context-recall-coordinator", factory: contextRecallCoordinator },
			],
		});
		await loader.reload();
		expect(loader.getModules().errors).toEqual([]);
		const owners = loader
			.getModules()
			.modules.filter((module) => module.tools.has("recall_context"))
			.map((module) => module.name);
		expect(owners).toEqual(["context-recall-coordinator"]);
	});

	it("resolves a Key Facts ref through the shared tool", async () => {
		const tool = createRecallTool();
		const summary = formatKeyFacts([{ ref: "c0r0", entryId: "m1", label: "the exact error" }]);
		const entry = {
			type: "message",
			id: "m1",
			parentId: "root",
			timestamp: "2026-11-17T00:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "AssertionError: expected 2 to be 3" }],
				timestamp: 1,
			},
		} as unknown as SessionEntry;
		const result = await tool.execute("call-1", { ref: "c0r0" }, undefined, undefined, {
			sessionManager: {
				getBranch: () => [
					{ type: "compaction", id: "c1", summary, timestamp: 1 } as unknown as SessionEntry,
					entry,
				],
				getEntry: (id: string) => (id === "m1" ? entry : undefined),
			},
			getContextUsage: () => undefined,
		} as never);
		expect(result.details.strategy).toBe("keyFacts");
		expect(result.details.entryIds).toEqual(["m1"]);
	});
});
