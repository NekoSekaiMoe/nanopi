import {
	type AgentRequestIdentity,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { calculateTool } from "./utils/calculate.ts";

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

describe("Agent request identity", () => {
	// #9481
	it("shares one identity across tools and rotates it for a follow-up", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		const identities: AgentRequestIdentity[] = [];
		let agent: Agent;
		faux.setResponses([
			(_context, options) => {
				identities.push(options?.requestIdentity as AgentRequestIdentity);
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }));
			},
			(_context, options) => {
				identities.push(options?.requestIdentity as AgentRequestIdentity);
				agent.followUp({ role: "user", content: "next", timestamp: Date.now() });
				return fauxAssistantMessage("4");
			},
			(_context, options) => {
				identities.push(options?.requestIdentity as AgentRequestIdentity);
				return fauxAssistantMessage("done");
			},
		]);
		agent = new Agent({
			sessionId: "session",
			streamFn: streamSimple,
			initialState: { model: faux.getModel(), tools: [calculateTool] },
		});

		await agent.prompt("start");

		expect(identities[1]).toEqual(identities[0]);
		expect(identities[2].turnId).not.toBe(identities[0].turnId);
		expect(identities[0]).toMatchObject({
			threadId: "session",
			requestKind: "turn",
		});
		expect(identities[0].sessionId).not.toBe(identities[0].threadId);
	});

	// #9481
	it("preserves identity when continuing a failed request", async () => {
		const faux = registerFauxProvider();
		registrations.push(faux);
		const identities: AgentRequestIdentity[] = [];
		faux.setResponses([
			(_context, options) => {
				identities.push(options?.requestIdentity as AgentRequestIdentity);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "retry" });
			},
			(_context, options) => {
				identities.push(options?.requestIdentity as AgentRequestIdentity);
				return fauxAssistantMessage("done");
			},
		]);
		const agent = new Agent({
			sessionId: "session",
			streamFn: streamSimple,
			initialState: { model: faux.getModel() },
		});

		await agent.prompt("start");
		agent.state.messages = agent.state.messages.slice(0, -1);
		await agent.continue();

		expect(identities[1]).toEqual(identities[0]);
	});
});
