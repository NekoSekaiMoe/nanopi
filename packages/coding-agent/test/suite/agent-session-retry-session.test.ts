import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getRunRecordData, RUN_RECORD_CUSTOM_TYPE } from "../../src/core/run-record.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

function runRecords(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === RUN_RECORD_CUSTOM_TYPE)
		.map((entry) => getRunRecordData(entry));
}

function lastRunRecord(harness: Harness) {
	return runRecords(harness).at(-1);
}

describe("AgentSession run records and /retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records a completed run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");

		const record = lastRunRecord(harness);
		expect(record?.outcome).toBe("completed");
		expect(record?.stopReason).toBe("stop");
		expect(record?.lastEntryId).toBeTypeOf("string");
		expect(harness.session.recoverableRun).toBeUndefined();
	});

	it("records a failure without auto-retry", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("hello");

		expect(lastRunRecord(harness)?.outcome).toBe("failed");
		expect(harness.session.recoverableRun).toMatchObject({ errorMessage: "invalid_api_key" });
	});

	it("records an attempt that auto-retry made and then gave up", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.prompt("hello");

		expect(runRecords(harness).map((record) => record?.attempts)).toContain(1);
		expect(lastRunRecord(harness)?.outcome).toBe("failed");
	});

	it("replays a failure that stayed in the projection", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("hello");
		const recoverable = harness.session.recoverableRun;
		expect(recoverable).toMatchObject({ errorMessage: "invalid_api_key", attempts: 0 });
		const userMessages = harness.session.messages.filter((message) => message.role === "user");

		await harness.session.retryLastRun();

		expect(harness.faux.state.callCount).toBe(2);
		// A replay adds no message: the request repeats the failed turn.
		expect(harness.session.messages.filter((message) => message.role === "user")).toEqual(userMessages);
		expect(lastRunRecord(harness)?.outcome).toBe("completed");
	});

	it("refuses to replay when the last run completed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");

		await expect(harness.session.retryLastRun()).rejects.toThrow("No failed response to retry");
	});

	it("keeps charging retries after a replay", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
		]);

		await harness.session.prompt("hello");
		await harness.session.retryLastRun();

		expect(lastRunRecord(harness)?.outcome).toBe("failed");
		expect(harness.session.recoverableRun).toBeDefined();
	});

	it("recovers a failure from the session file after a restart", async () => {
		const source = await createHarness();
		harnesses.push(source);
		source.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);
		await source.session.prompt("hello");

		// Write out what the process persisted, then reopen it the way `--continue` does.
		const sessionFile = `${source.tempDir}/session.jsonl`;
		const header = source.sessionManager.getHeader();
		const lines = [header, ...source.sessionManager.getEntries()].map((entry) => `${JSON.stringify(entry)}\n`);
		writeFileSync(sessionFile, lines.join(""));

		const restarted = await createHarness({ sessionManager: SessionManager.open(sessionFile) });
		harnesses.push(restarted);
		restarted.setResponses([fauxAssistantMessage("recovered")]);

		expect(restarted.session.recoverableRun).toMatchObject({ errorMessage: "invalid_api_key" });
		await restarted.session.retryLastRun();
		expect(lastRunRecord(restarted)?.outcome).toBe("completed");
	});
});
