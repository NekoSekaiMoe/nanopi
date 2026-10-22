import { afterEach, describe, expect, it } from "vitest";
import type { ModuleApi, ToolDefinition } from "../../../src/core/modules/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import subagentMini, { dependentBrief, type Job } from "../../../src/extras/pi-subagent-mini/src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * The two orchestration primitives from the DAG discussion.
 *
 * 1. A dependent starts with its dependencies' reports in its brief. Before this,
 *    `dependsOn` only ordered the starts: the main agent had to copy B's report into
 *    C's brief by hand, one hop at a time.
 * 2. The edges are archived. Before this a restore rebuilt the jobs but not
 *    `dependsOn`, so a restart left a bag of reports with no topology, and a job
 *    that was still waiting never ran at all.
 *
 * A child is a real subprocess, so the assertions stop at what the tool decided:
 * the brief it would launch with, and the archive it wrote. No child is launched.
 */

type SubagentTool = ToolDefinition<never, unknown, never>;

/** The subagent tool as the registry receives it. */
async function register(sessionManager?: SessionManager): Promise<{
	harness: Harness;
	tool: SubagentTool;
	cwd: string;
}> {
	const captured: { tool?: SubagentTool } = {};
	const harness = await createHarness({
		...(sessionManager ? { sessionManager } : {}),
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
	return { harness, tool: captured.tool, cwd: harness.tempDir };
}

type Rig = Awaited<ReturnType<typeof register>>;

async function call(rig: Rig, params: Record<string, unknown>): Promise<string> {
	const ctx = {
		cwd: rig.cwd,
		ui: { setWidget: () => {}, setStatus: () => {} },
		model: rig.harness.getModel(),
	} as never;
	const result = await rig.tool.execute("call-1", params as never, undefined, undefined, ctx);
	return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

type ArchiveData = {
	id: string;
	status: string;
	task: string;
	dependsOn?: string[];
	scope: string;
	report: string;
	sessionId?: string;
	startedAt: number;
};

/** The `subagent-job` entries the session holds, in order. */
function archived(harness: Harness): ArchiveData[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "subagent-job")
		.map((entry) => (entry as { data?: ArchiveData }).data)
		.filter((data): data is ArchiveData => data !== undefined);
}

/** A session whose archive already holds `entries`, as a restart would find it. */
function archivedSession(cwd: string, entries: ArchiveData[]): SessionManager {
	const sessionManager = SessionManager.inMemory(cwd);
	for (const entry of entries) sessionManager.appendCustomEntry("subagent-job", { version: 2, ...entry });
	return sessionManager;
}

/** Wait until `predicate` holds; the tool's settle path is async by design. */
async function until(predicate: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("subagent dependency reports", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("pastes each dependency's settled report into the dependent's brief", () => {
		const jobs = new Map<string, Job>();
		const dependency = (id: string, status: Job["status"], report: string): Job =>
			({
				id,
				status,
				task: `Task: ${id}`,
				finalOutput: report,
				dependsOn: [],
				pendingDependencies: [],
			}) as unknown as Job;
		jobs.set("sa-1", dependency("sa-1", "completed", "found the call sites"));
		jobs.set("sa-2", dependency("sa-2", "completed", "typed the helper"));
		const dependent = {
			id: "sa-3",
			status: "queued",
			task: "Task: wire it up",
			finalOutput: "",
			dependsOn: ["sa-1", "sa-2"],
			pendingDependencies: [],
		} as unknown as Job;
		jobs.set("sa-3", dependent);
		const brief = dependentBrief(dependent, jobs);
		expect(brief).toContain("### sa-1 (completed)\nfound the call sites");
		expect(brief).toContain("### sa-2 (completed)\ntyped the helper");
		// The brief itself is still the payload, at the end, where a child reads it last.
		expect(brief.endsWith("Task: wire it up")).toBe(true);
	});

	it("says so when a dependency settled without a report instead of inlining a blank", () => {
		const jobs = new Map<string, Job>();
		jobs.set("sa-1", { id: "sa-1", status: "completed", task: "Task: a", finalOutput: "" } as Job);
		const dependent = { id: "sa-2", status: "queued", task: "Task: b", dependsOn: ["sa-1"] } as unknown as Job;
		expect(dependentBrief(dependent, jobs)).toContain("### sa-1 (completed)\n(no report)");
	});

	it("leaves a brief without dependencies untouched", () => {
		const jobs = new Map<string, Job>();
		const job = { id: "sa-1", status: "queued", task: "Task: alone", dependsOn: [] } as unknown as Job;
		expect(dependentBrief(job, jobs)).toBe("Task: alone");
	});

	it("refuses a dependency that does not exist instead of waiting forever", async () => {
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());
		const text = await call(rig, { action: "spawn", task: "Task: x", dependsOn: ["sa-404"] });
		expect(text).toContain("unknown dependency: sa-404");
	});
});

describe("subagent archive restore", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("does not re-queue a job that already settled", async () => {
		const cwd = process.cwd();
		const sessionManager = archivedSession(cwd, [
			{ id: "sa-1", status: "completed", task: "Task: done", scope: "done", report: "the result", startedAt: 1 },
		]);
		const rig = await register(sessionManager);
		cleanups.push(() => rig.harness.cleanup());
		// Start the session the way a resume does, so the restore path runs.
		await rig.harness.session.bindModules({});
		const text = await call(rig, { action: "status", jobId: "sa-1" });
		expect(text).toContain("subagent sa-1: completed");
		expect(text).toContain("the result");
	});

	it("marks a job that was running when the parent died as interrupted, and archives it", async () => {
		const cwd = process.cwd();
		const sessionManager = archivedSession(cwd, [
			{ id: "sa-1", status: "running", task: "Task: was running", scope: "was running", report: "", startedAt: 1 },
		]);
		const rig = await register(sessionManager);
		cleanups.push(() => rig.harness.cleanup());
		await rig.harness.session.bindModules({});
		await until(() => archived(rig.harness).some((entry) => entry.status === "interrupted"), "the interruption");
		const text = await call(rig, { action: "status", jobId: "sa-1" });
		expect(text).toContain("subagent sa-1: interrupted");
		expect(text).toContain("the parent session ended before this job settled");
	});

	it("blocks a dependent whose dependency was interrupted, instead of waiting forever", async () => {
		const cwd = process.cwd();
		const sessionManager = archivedSession(cwd, [
			{ id: "sa-1", status: "running", task: "Task: was running", scope: "was running", report: "", startedAt: 1 },
			{
				id: "sa-2",
				status: "queued",
				task: "Task: waits on it",
				scope: "waits on it",
				report: "",
				dependsOn: ["sa-1"],
				startedAt: 2,
			},
		]);
		const rig = await register(sessionManager);
		cleanups.push(() => rig.harness.cleanup());
		await rig.harness.session.bindModules({});
		await until(() => {
			const entries = archived(rig.harness);
			return entries.some((entry) => entry.id === "sa-2" && entry.status === "blocked");
		}, "the dependent to be blocked");
		const text = await call(rig, { action: "status", jobId: "sa-2" });
		expect(text).toContain("subagent sa-2: blocked");
		expect(text).toContain("dependency sa-1 interrupted");
	});
});
