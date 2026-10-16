import { describe, expect, test } from "vitest";
import type { AskBrokerEvent, AskBrokerQuestion } from "../src/ask-broker.ts";
import { AskBroker } from "../src/ask-broker.ts";

const questions: AskBrokerQuestion[] = [
	{
		header: "Scope",
		question: "Which packages should the plan cover?",
		mode: "single",
		options: [{ label: "coding-agent" }, { label: "all" }],
	},
];

describe("AskBroker", () => {
	test("publishes a prompt with a request id and resolves on answer", async () => {
		const broker = new AskBroker();
		const events: AskBrokerEvent[] = [];
		broker.subscribe((event) => events.push(event));

		const pending = broker.ask(questions);
		expect(events).toEqual([{ type: "prompt", requestId: 1, questions }]);

		expect(broker.answer(1, { type: "single", answer: { declined: false, selected: ["all"], text: null } })).toBe(
			true,
		);
		await expect(pending).resolves.toEqual({
			type: "single",
			answer: { declined: false, selected: ["all"], text: null },
		});
		expect(events.at(-1)).toEqual({ type: "resolved", requestId: 1 });
	});

	test("rejects an answer whose request id does not match", async () => {
		const broker = new AskBroker();
		const pending = broker.ask(questions);

		expect(broker.answer(99, { type: "single", answer: { declined: true, selected: [], text: null } })).toBe(false);
		expect(broker.answer(1, { type: "single", answer: { declined: true, selected: [], text: null } })).toBe(true);
		await pending;
	});

	test("serializes concurrent requests, one prompt at a time", async () => {
		const broker = new AskBroker();
		const prompts: number[] = [];
		broker.subscribe((event) => {
			if (event.type === "prompt") prompts.push(event.requestId);
		});

		const first = broker.ask(questions);
		const second = broker.ask(questions);
		expect(prompts).toEqual([1]);

		broker.answer(1, { type: "single", answer: { declined: true, selected: [], text: null } });
		await first;
		expect(prompts).toEqual([1, 2]);

		broker.answer(2, { type: "batch", answers: [] });
		await expect(second).resolves.toEqual({ type: "batch", answers: [] });
	});

	test("an empty questionnaire resolves immediately without prompting", async () => {
		const broker = new AskBroker();
		const events: AskBrokerEvent[] = [];
		broker.subscribe((event) => events.push(event));

		await expect(broker.ask([])).resolves.toBeUndefined();
		expect(events).toEqual([]);
	});

	test("cancelAll drops the queue and resolves pending asks as dropped", async () => {
		const broker = new AskBroker();
		const first = broker.ask(questions);
		const second = broker.ask(questions);

		broker.cancelAll();

		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		// Nothing left to answer.
		expect(broker.answer(1, { type: "batch", answers: [] })).toBe(false);
	});
});
