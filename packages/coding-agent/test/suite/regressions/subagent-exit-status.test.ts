import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleApi, ToolDefinition } from "../../../src/core/modules/types.ts";
import subagentMini from "../../../src/extras/pi-subagent-mini/src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * How a child's death is read, and what the caller can see of it afterwards.
 *
 * 1. `close` reported only the exit code, so `code === null` (the process was
 *    ended by a signal) counted as success: a child killed with `kill -9` or by the
 *    OOM killer published a "completed" report with whatever it had printed so far.
 *    It is `killed` now, and a signal nobody here sent does not mean success.
 * 2. A killed job could not be retried away: `onFailure: "retry"` would spawn the
 *    same child again, into the same kill. It is not retried.
 * 3. `status` only ever described the latest attempt, so a retried job looked like
 *    it had never failed. The attempt log keeps each attempt's ending.
 * 4. A dependency that never settles used to hold its dependents forever, with no
 *    way to say so: `dependsOnTimeoutSec` turns that wait into a `blocked` outcome.
 */

type SubagentTool = ToolDefinition<never, unknown, never>;

type Rig = { harness: Harness; tool: SubagentTool; cwd: string };

/**
 * A child entry that pretends to be `nanopi --mode json -p`: it prints one
 * assistant event and then does whatever the fake script says.
 */
function fakeChild(script: string): { dir: string; cmd: string } {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-subagent-fake-"));
	const file = join(dir, "child.sh");
	writeFileSync(file, `#!/bin/sh\n${script}\n`);
	chmodSync(file, 0o755);
	return { dir, cmd: file };
}

const REPORT = `{"type":"message_end","message":{"role":"assistant","stopReason":"endTurn","content":[{"type":"text","text":"child report"}]}}`;

async function register(): Promise<Rig> {
	const captured: { tool?: SubagentTool } = {};
	const harness = await createHarness({
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

async function call(rig: Rig, params: Record<string, unknown>, childCmd: string): Promise<string> {
	const ctx = {
		cwd: rig.cwd,
		ui: { setWidget: () => {}, setStatus: () => {} },
		model: rig.harness.getModel(),
		getAgentDir: () => join(rig.harness.tempDir, "agent"),
		// The child is the fake script; the argv carries the flags, which it ignores.
		resolveHostEntry: () => ({ cmd: childCmd, args: [] }),
	} as never;
	const result = await rig.tool.execute("call-1", params as never, undefined, undefined, ctx);
	return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

/** Wait until `predicate` holds; a child's `close` arrives on the event loop. */
async function until(predicate: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

type ArchiveData = { id: string; status: string; dependsOn?: string[]; report: string; attemptLog?: unknown[] };

function archived(harness: Harness): ArchiveData[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "subagent-job")
		.map((entry) => (entry as { data?: ArchiveData }).data)
		.filter((data): data is ArchiveData => data !== undefined);
}

const childJobs = (harness: Harness, id: string): ArchiveData[] => archived(harness).filter((entry) => entry.id === id);

describe("subagent exit status", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("reports a child killed by a signal as killed, not completed", async () => {
		// Prints a report, then kills itself the way the OOM killer would: the parent
		// sees `code === null`, which used to be treated as a clean exit.
		const child = fakeChild(`echo '${REPORT}'\nkill -9 $$`);
		cleanups.push(() => rmSync(child.dir, { recursive: true, force: true }));
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());

		await call(rig, { action: "spawn", task: "Task: die on a signal" }, child.cmd);
		await until(() => childJobs(rig.harness, "sa-1").length > 0, "the job to settle");
		const [entry] = childJobs(rig.harness, "sa-1");
		expect(entry?.status).toBe("killed");
		expect(entry?.report).toContain("terminated by SIGKILL");
	});

	it("reports a child that exits normally as completed", async () => {
		const child = fakeChild(`echo '${REPORT}'`);
		cleanups.push(() => rmSync(child.dir, { recursive: true, force: true }));
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());

		await call(rig, { action: "spawn", task: "Task: finish normally" }, child.cmd);
		await until(() => childJobs(rig.harness, "sa-1").length > 0, "the job to settle");
		expect(childJobs(rig.harness, "sa-1")[0]?.status).toBe("completed");
	});

	it("does not retry a killed job, even with onFailure: retry", async () => {
		const child = fakeChild(`echo '${REPORT}'\nkill -9 $$`);
		cleanups.push(() => rmSync(child.dir, { recursive: true, force: true }));
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());

		const spawned = await call(
			rig,
			{ action: "spawn", task: "Task: die on a signal", onFailure: "retry" },
			child.cmd,
		);
		expect(spawned).toContain("attempt 1/3");
		await until(() => childJobs(rig.harness, "sa-1").length > 0, "the job to settle");
		// The retry path would have relaunched by now: it settles on the first attempt.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const [entry] = childJobs(rig.harness, "sa-1");
		expect(entry?.status).toBe("killed");
		expect(entry?.attemptLog).toHaveLength(1);
	});

	it("keeps each attempt's ending, so a retried job still shows the failure", async () => {
		// First attempt exits 1 with a report; the retry succeeds. The job's `status`
		// is `completed`, and the attempt log is the only record of attempt 1.
		const child = fakeChild(
			`if [ -f "$(dirname "$0")/attempted" ]; then echo '${REPORT}'; else : > "$(dirname "$0")/attempted"; echo '${REPORT}'; exit 1; fi`,
		);
		cleanups.push(() => rmSync(child.dir, { recursive: true, force: true }));
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());

		await call(rig, { action: "spawn", task: "Task: fail once", onFailure: "retry" }, child.cmd);
		await until(
			() => childJobs(rig.harness, "sa-1").some((entry) => entry.status === "completed"),
			"the retry to settle",
		);
		const [entry] = childJobs(rig.harness, "sa-1");
		expect(entry?.status).toBe("completed");
		expect(entry?.attemptLog).toMatchObject([
			{ attempt: 1, status: "failed", error: "exit 1" },
			{ attempt: 2, status: "completed" },
		]);

		const status = await call(rig, { action: "status", jobId: "sa-1" }, child.cmd);
		expect(status).toContain("attempts: attempt 1 failed: exit 1");
	});
});

describe("subagent dependency timeout", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("blocks a dependent whose dependency never settles", async () => {
		// The first job never finishes (the child sleeps past the test).
		const child = fakeChild("sleep 30");
		cleanups.push(() => rmSync(child.dir, { recursive: true, force: true }));
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());

		await call(rig, { action: "spawn", task: "Task: never settles", timeoutSec: 60 }, child.cmd);
		await call(
			rig,
			{ action: "spawn", task: "Task: wait for it", dependsOn: ["sa-1"], dependsOnTimeoutSec: 0.05 },
			child.cmd,
		);
		await until(() => childJobs(rig.harness, "sa-2").length > 0, "the dependent to give up");
		const [dependent] = childJobs(rig.harness, "sa-2");
		expect(dependent?.status).toBe("blocked");
		expect(dependent?.report).toContain("did not settle in 0.05s");
		await call(rig, { action: "kill", jobId: "sa-1" }, child.cmd);
	});

	it("lets a dependent wait when no timeout is given", async () => {
		const child = fakeChild("sleep 30");
		cleanups.push(() => rmSync(child.dir, { recursive: true, force: true }));
		const rig = await register();
		cleanups.push(() => rig.harness.cleanup());

		await call(rig, { action: "spawn", task: "Task: never settles", timeoutSec: 60 }, child.cmd);
		const spawned = await call(rig, { action: "spawn", task: "Task: wait for it", dependsOn: ["sa-1"] }, child.cmd);
		expect(spawned).toContain("waiting on sa-1");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(childJobs(rig.harness, "sa-2")).toHaveLength(0);
		await call(rig, { action: "kill", jobId: "sa-1" }, child.cmd);
		// The kill is not silent either: its dependent is blocked, not left queued.
		await until(() => childJobs(rig.harness, "sa-2").length > 0, "the dependent to be blocked");
		expect(childJobs(rig.harness, "sa-2")[0]?.status).toBe("blocked");
		expect(childJobs(rig.harness, "sa-2")[0]?.report).toContain("dependency sa-1 killed");
	});
});
