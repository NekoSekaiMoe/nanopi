import { fauxAssistantMessage, fauxToolCall } from "@nanopi/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModuleApi } from "../../../src/core/modules/types.ts";
import { registerBashBg } from "../../../src/extras/pi-smart-flow/src/bash-bg.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

/**
 * Regression for the background job completion hand-off (issue #404).
 *
 * `bash_bg` announced a finished job with `sendMessage(..., { triggerTurn: true })`.
 * Between `agent_settled` and the session going idle, `isStreaming` is already
 * false while a run is still unwinding; that second `agent.prompt()` rejected,
 * `sendMessage` dropped the rejection, and the completion message was never
 * shown. `start` and `run` were the same bug through two exits.
 *
 * The hand-off now goes through `deliverMessage`, which settles for "queued" or
 * "pending" instead of starting a second run. It also stays retryable: a job
 * whose message never went out is handed over again on the next status/wait/kill.
 */
const createBashBgHarness = (api?: (pi: ModuleApi) => ModuleApi): Promise<Harness> =>
	createHarness({
		modules: [
			{
				name: "bash-bg-under-test",
				factory: (pi: ModuleApi) => registerBashBg(api ? api(pi) : pi),
			},
		],
		excludedToolNames: ["bash", "read", "write", "edit", "find", "grep", "ls"],
		initialActiveToolNames: ["bash_bg"],
	});

const customTexts = (harness: Harness, customType: string): string[] =>
	harness.session.messages
		.filter((message) => message.role === "custom" && message.customType === customType)
		.map((message) => getMessageText(message));

/** Poll until `check` holds: the hand-off runs off the tool-result path. */
const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition not reached");
};

describe("bash_bg completion delivery", () => {
	it("hands a settled `run` over without starting a second run", async () => {
		const outcomes: Array<"started" | "queued" | "pending"> = [];
		const harness = await createBashBgHarness((pi) => ({
			...pi,
			deliverMessage: async (message, options) => {
				const outcome = await pi.deliverMessage(message, options);
				outcomes.push(outcome);
				return outcome;
			},
		}));
		try {
			harness.setResponses([
				// Long enough that the process's close event lands after the tool
				// result, which is when a second turn used to be started from
				// inside the first one.
				fauxAssistantMessage(fauxToolCall("bash_bg", { action: "run", command: "sleep 0.2" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("run it");
			await harness.session.waitForIdle();
			await until(() => customTexts(harness, "bash-bg-complete").length > 0);

			// Delivered exactly once: `sendMessage` used to fire into a session that
			// was still finishing the turn it came from, and the rejection was lost.
			expect(customTexts(harness, "bash-bg-complete")).toHaveLength(1);
			expect(outcomes).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("hands a finished `start` job over through deliverMessage", async () => {
		const outcomes: Array<"started" | "queued" | "pending"> = [];
		const harness = await createBashBgHarness((pi) => ({
			...pi,
			deliverMessage: async (message, options) => {
				const outcome = await pi.deliverMessage(message, options);
				outcomes.push(outcome);
				return outcome;
			},
		}));
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash_bg", { action: "start", command: "echo finished" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("started"),
				fauxAssistantMessage("completion handled"),
			]);

			await harness.session.prompt("start it");
			await until(() => customTexts(harness, "bash-bg-complete").length > 0);
			await harness.session.waitForIdle();

			const delivered = customTexts(harness, "bash-bg-complete");
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain("echo finished");
			expect(delivered[0]).toContain("completed");
			expect(outcomes).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("retries the hand-off when delivery throws", async () => {
		let attempts = 0;
		let failure: string | undefined;
		const harness = await createBashBgHarness((pi) => ({
			...pi,
			deliverMessage: async (message, options) => {
				attempts += 1;
				if (attempts === 1) throw new Error("no reader attached");
				return pi.deliverMessage(message, options);
			},
			appendEntry: (customType, data) => {
				if (customType === "bash-bg-complete-undelivered") {
					failure = (data as { message: string }).message;
				}
				pi.appendEntry(customType, data);
			},
		}));
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash_bg", { action: "start", command: "echo again" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("started"),
				fauxAssistantMessage("completion handled"),
			]);

			await harness.session.prompt("start it");
			await until(() => failure !== undefined);
			expect(failure).toBe("no reader attached");
			// The failed hand-off left the job retryable instead of marked as sent.
			expect(customTexts(harness, "bash-bg-complete")).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});
});
