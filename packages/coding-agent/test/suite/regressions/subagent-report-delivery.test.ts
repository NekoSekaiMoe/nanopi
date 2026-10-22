import type { AgentTool } from "@nanopi/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@nanopi/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleApi } from "../../../src/core/modules/types.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

/**
 * Regression for the subagent report hand-off.
 *
 * `pi-subagent-mini` delivered a finished child's report with
 * `{ deliverAs: "steer", triggerTurn: true }`. Between `agent_settled` and the
 * webui calling `finish()`, `isStreaming` is already false while the agent is
 * still unwinding, so the steer fell through to `_startRun`, whose
 * `agent.prompt()` rejected on the run already in flight. That rejection was
 * caught and dropped: the report never reached the user, and only an archive
 * entry recorded the loss.
 *
 * A delivery now reports where it landed, and it starts a turn only when the
 * session is idle -- so a report that races a settling turn is queued for the
 * next prompt instead of colliding with it.
 */
function createGateTool(): { tool: AgentTool; reached: Promise<void>; release: () => void } {
	const reached = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "gate",
		label: "Gate",
		description: "Hold the turn open",
		parameters: Type.Object({}),
		execute: async () => {
			reached.resolve();
			await released.promise;
			return { content: [{ type: "text", text: "opened" }], details: {} };
		},
	};
	return { tool, reached: reached.promise, release: () => released.resolve() };
}

const customTexts = (harness: Harness): string[] =>
	harness.session.messages.filter((message) => message.role === "custom").map((message) => getMessageText(message));

describe("subagent report delivery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("delivers a report that arrives while a turn is settling", async () => {
		const outcomes: string[] = [];
		const harness = await createHarness({
			modules: [
				{
					name: "test-module-1",
					factory: (nanopi: ModuleApi) => {
						nanopi.on("agent_settled", () => {
							// The window the old code lost reports in: settled, but prompt() has not
							// resolved, so a producer still thinks a turn is running.
							if (outcomes.length > 0) return;
							void nanopi
								.deliverMessage(
									{ customType: "subagent-complete", content: "child report", display: true },
									{ startTurn: true },
								)
								.then((outcome) => outcomes.push(outcome));
						});
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("main turn done"), fauxAssistantMessage("report handled")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(outcomes).toEqual(["started"]);
		expect(customTexts(harness)).toContain("child report");
	});

	it("queues a report that arrives during a turn instead of starting a second run", async () => {
		const gate = createGateTool();
		const harness = await createHarness({ tools: [gate.tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after the tool"),
			fauxAssistantMessage("report handled"),
		]);

		const prompting = harness.session.prompt("start");
		await gate.reached;
		const outcome = await harness.session.deliverCustomMessage(
			{ customType: "subagent-complete", content: "child report", display: true },
			{ startTurn: true },
		);
		expect(outcome).toBe("queued");
		gate.release();
		await prompting;
		await harness.session.waitForIdle();

		expect(customTexts(harness)).toContain("child report");
	});

	it("a quiet report waits for the next prompt instead of starting a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("carried the report")]);

		const outcome = await harness.session.deliverCustomMessage({
			customType: "subagent-complete",
			content: "quiet report",
			display: true,
		});
		expect(outcome).toBe("pending");

		await harness.session.prompt("next question");
		expect(customTexts(harness)).toContain("quiet report");
	});
});
