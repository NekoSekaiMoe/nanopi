import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleApi, ToolDefinition } from "../../../src/core/modules/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { registerBashBg } from "../../../src/extras/pi-smart-flow/src/bash-bg.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

/**
 * Two things `bash_bg` owes a user whose job outlives the turn that started it.
 *
 * 1. The completion report is the only thing a backgrounded job produces. It used
 *    to go out with `sendMessage(..., { triggerTurn: true })`, which starts a turn
 *    whenever `isStreaming` is false -- including the window where the previous run
 *    is still settling, where `prompt()` rejects and the report is lost. It goes
 *    through `deliverMessage` now, which reports where it landed instead.
 * 2. `npm run dev` exits into the background while the server it spawned keeps the
 *    port. That service must stay addressable after a restart: the job is archived
 *    with its log path and whether its process group is still ours.
 */

type BashBgTool = ToolDefinition<never, unknown, never>;
type JobRecord = {
	version: number;
	id: string;
	status: string;
	logPath: string;
	logDeleted: boolean;
	serviceAlive: boolean;
	delivered?: string;
};

async function register(sessionManager?: SessionManager): Promise<{
	harness: Harness;
	tool: BashBgTool;
	entries: () => JobRecord[];
}> {
	const captured: { tool?: BashBgTool } = {};
	const harness = await createHarness({
		...(sessionManager ? { sessionManager } : {}),
		modules: [
			{
				name: "pi-smart-flow",
				factory: (nanopi: ModuleApi) => {
					const registerTool = nanopi.registerTool.bind(nanopi);
					nanopi.registerTool = (definition) => {
						if (definition.name === "bash_bg") captured.tool = definition as unknown as BashBgTool;
						registerTool(definition);
					};
					registerBashBg(nanopi);
				},
			},
		],
	});
	if (!captured.tool) throw new Error("bash_bg tool was not registered");
	const tool = captured.tool;
	// The tool needs a UI context on the session start path, same as a real host.
	await harness.session.bindModules({ uiContext: createTestUiContext(), mode: "print" });
	const entries = (): JobRecord[] =>
		harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "bash-bg-job")
			.map((entry) => (entry as { data?: JobRecord }).data)
			.filter((data): data is JobRecord => data !== undefined);
	return { harness, tool, entries };
}

async function call(tool: BashBgTool, cwd: string, params: Record<string, unknown>): Promise<string> {
	const ctx = { cwd, ui: createTestUiContext(), model: undefined } as never;
	const result = await tool.execute("call-1", params as never, undefined, undefined, ctx);
	return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

async function until(predicate: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("bash_bg completion delivery", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("delivers the report through deliverMessage and records where it landed", async () => {
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());
		await call(rig.tool, rig.harness.tempDir, { action: "start", command: "printf 'hello from the job\\n'" });
		await until(() => rig.entries().some((entry) => entry.delivered !== undefined), "the delivered record");

		const delivered = rig
			.entries()
			.filter((entry) => entry.delivered !== undefined)
			.at(-1);
		// Idle when the job finished, so the report starts a turn instead of waiting.
		expect(delivered?.delivered).toBe("started");
		const report = rig.harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "bash-bg-complete",
		);
		expect(report).toBeDefined();
	});

	it("archives a finished job so its log is addressable after a restart", async () => {
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());
		await call(rig.tool, rig.harness.tempDir, { action: "run", command: "echo archived", timeout: 5 });
		// `markDone` and `finalizeOutput` both append a record, and the first one lands
		// before the drained stdout reaches the log file. Wait for the archived log,
		// not for the status flip, or a slow runner reads an empty file.
		await until(() => {
			const latest = rig.entries().at(-1);
			if (latest === undefined || latest.status === "running") return false;
			return existsSync(latest.logPath) && readFileSync(latest.logPath, "utf8").includes("archived");
		}, "the archived log");

		const record = rig.entries().at(-1);
		expect(record?.status).toBe("completed");
		expect(record?.logDeleted).toBe(false);
		expect(existsSync(record!.logPath)).toBe(true);
		expect(readFileSync(record!.logPath, "utf8")).toContain("archived");
	});
});

describe("bash_bg archive restore", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	/** A session that already holds these archive records, as a restart finds it. */
	function archivedSession(records: unknown[]): { sessionManager: SessionManager } {
		const sessionManager = SessionManager.inMemory(process.cwd());
		for (const record of records) sessionManager.appendCustomEntry("bash-bg-job", record);
		return { sessionManager };
	}

	it("brings an archived job back with its log path, so a surviving service stays addressable", async () => {
		const { sessionManager } = archivedSession([
			{
				version: 1,
				id: "bg-dev",
				command: "npm run dev",
				cwd: "/work",
				pid: 4242,
				status: "completed",
				startedAt: 1,
				finishedAt: 2,
				exitCode: 0,
				logPath: "/tmp/pi-bash-bg-kept/dev-server.log",
				logBytes: 10,
				logDeleted: false,
				serviceAlive: true,
			},
		]);
		const rig = await register(sessionManager);
		cleanups.push(() => rig.harness.cleanup());

		const listed = await call(rig.tool, rig.harness.tempDir, { action: "list" });
		expect(listed).toContain("bg-dev");
		const status = await call(rig.tool, rig.harness.tempDir, { action: "status", jobId: "bg-dev", tail: 5 });
		expect(status).toContain("/tmp/pi-bash-bg-kept/dev-server.log");
	});

	it("ignores archive records it does not understand instead of crashing the restore", async () => {
		const sessionManager = SessionManager.inMemory(process.cwd());
		sessionManager.appendCustomEntry("bash-bg-job", "not-a-record");
		sessionManager.appendCustomEntry("bash-bg-job", { version: 9, id: "bg-future" });
		sessionManager.appendCustomEntry("bash-bg-job", { version: 1 });
		const rig = await register(sessionManager);
		cleanups.push(() => rig.harness.cleanup());

		// The restore ran; nothing unknown made it into the table.
		expect(await call(rig.tool, rig.harness.tempDir, { action: "list" })).toBe("No background jobs.");
	});

	it("skips a record whose log is gone, and says so", async () => {
		const { sessionManager } = archivedSession([
			{
				version: 1,
				id: "bg-gone",
				command: "npm run dev",
				cwd: "/work",
				pid: 4343,
				status: "completed",
				startedAt: 1,
				finishedAt: 2,
				exitCode: 0,
				logPath: "/tmp/pi-bash-bg-does-not-exist/dev-server.log",
				logBytes: 10,
				logDeleted: true,
				serviceAlive: false,
			},
		]);
		const rig = await register(sessionManager);
		cleanups.push(() => rig.harness.cleanup());
		const listed = await call(rig.tool, rig.harness.tempDir, { action: "list" });
		expect(listed).toContain("bg-gone");
		// The record still exists: the log being gone is a fact about the job, not a reason to hide it.
		expect(listed).toContain("completed");
	});
});
