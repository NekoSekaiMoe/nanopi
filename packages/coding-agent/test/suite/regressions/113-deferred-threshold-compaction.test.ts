import type { AgentMessage } from "@nanopi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function seedTokens(harness: Harness, tokens: number): void {
	const model = harness.session.model!;
	harness.sessionManager.appendMessage({ role: "user", content: "history", timestamp: Date.now() - 2000 });
	const assistant = fauxAssistantMessage("old answer", { timestamp: Date.now() - 1000 });
	harness.sessionManager.appendMessage({
		...assistant,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...assistant.usage, input: tokens, totalTokens: tokens },
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages as AgentMessage[];
}

describe("issue #113: deferred threshold compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("does not summarize a session that ending the run left above the threshold", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		// Answer inside the window, then report usage far above it: the run ends above the
		// threshold, and nothing else needs the context.
		let calls = 0;
		harness.session.agent.streamFunction = (model) => {
			calls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					...fauxAssistantMessage("answer"),
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 9000,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 9000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		await harness.session.prompt("hello");

		expect(calls).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("compacts before the next request once the pending input needs the context", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedTokens(harness, 9000);
		harness.setResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("next answer")]);

		await harness.session.prompt("next");

		// Seeded usage is above the window, so the pre-run check classifies it as overflow.
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({ willRetry: false });
		expect(harness.session.getLastAssistantText()).toBe("next answer");
	});
});
