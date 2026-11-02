import { describe, expect, it } from "vitest";
import type { ModuleApi, ToolDefinition } from "../../../src/core/modules/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import subagentMini from "../../../src/extras/pi-subagent-mini/src/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

/**
 * The archive restore reads `entry.data` out of the session file, which is outside
 * this module's control: another build's schema, or a payload that was never an
 * archive object. `data.version` is the only thing that says the entry is a
 * `subagent-job` this build understands, so it has to be the first thing read.
 *
 * A `session_start` handler that throws is swallowed by the registry (it surfaces
 * as a module error, not a rejection), so the assertion is on what got restored.
 */

type SubagentTool = ToolDefinition<never, unknown, never>;

/** The archived job ids the module restored, as `status` reports them. */
async function restoredStatus(harness: Harness, tool: SubagentTool, jobId: string): Promise<string> {
	const ctx = { cwd: harness.tempDir, ui: createTestUiContext() } as never;
	const result = await tool.execute("call-1", { action: "status", jobId } as never, undefined, undefined, ctx);
	return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

async function register(sessionManager: SessionManager): Promise<{
	harness: Harness;
	status: (jobId: string) => Promise<string>;
	errors: string[];
}> {
	const captured: { tool?: SubagentTool } = {};
	const harness = await createHarness({
		sessionManager,
		modules: [
			{
				name: "pi-subagent-mini",
				factory: (nanopi: ModuleApi) => {
					const registerTool = nanopi.registerTool.bind(nanopi);
					nanopi.registerTool = (definition) => {
						if (definition.name === "subagent") captured.tool = definition as unknown as SubagentTool;
						registerTool(definition);
					};
					subagentMini(nanopi);
				},
			},
		],
	});
	if (!captured.tool) throw new Error("subagent tool was not registered");
	const tool = captured.tool;
	const errors: string[] = [];
	const registry = (
		harness.session as unknown as {
			_moduleRegistry: { onError: (listener: (error: { error: string }) => void) => void };
		}
	)._moduleRegistry;
	registry.onError((error) => errors.push(error.error));
	// The session start the harness already ran has no UI context; run it again with one.
	await harness.session.bindModules({ uiContext: createTestUiContext(), mode: "print" });
	return { harness, errors, status: (jobId) => restoredStatus(harness, tool, jobId) };
}

/** A job this build understands, archived behind the payload under test. */
const realEntry = {
	version: 2,
	id: "sa-1",
	status: "completed",
	task: "Task: real",
	scope: "real",
	report: "the result",
	startedAt: 2,
};

describe("subagent archive restore version gate", () => {
	for (const [what, payload] of [
		// A string has no `id`, so it never reaches the payload read below; only the
		// missing version distinguishes it from an archive entry, and reading `id`
		// first is what would have made the gate run second.
		["a payload that is not an object", "sa-7"],
		// A newer schema carries every field the rest of this loop reads.
		[
			"another build's schema",
			{ version: 3, id: "sa-9", status: "completed", task: "Task: future", report: "nope", startedAt: 1 },
		],
		[
			"a payload with no version",
			{ id: "sa-8", status: "completed", task: "Task: legacy", report: "nope", startedAt: 1 },
		],
	] as Array<[string, unknown]>) {
		it(`skips ${what} and keeps restoring the entries after it`, async () => {
			const sessionManager = SessionManager.inMemory(process.cwd());
			sessionManager.appendCustomEntry("subagent-job", payload);
			sessionManager.appendCustomEntry("subagent-job", realEntry);
			const rig = await register(sessionManager);
			try {
				expect(rig.errors).toEqual([]);
				expect(await rig.status("sa-1")).toContain("the result");
				expect(await rig.status("sa-9")).toContain("no subagent found");
				expect(await rig.status("sa-8")).toContain("no subagent found");
			} finally {
				rig.harness.cleanup();
			}
		});
	}
});
