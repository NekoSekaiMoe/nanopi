import { describe, expect, test } from "vitest";
import type { PermissionCallInfo, PermissionOutcome } from "../src/permission-types.ts";
import { PermissionBroker, PermissionGate } from "../src/permissions.ts";
import type { PermissionDecision } from "../src/types.ts";

function info(overrides: Partial<PermissionCallInfo> = {}): PermissionCallInfo {
	return {
		callId: "call-1",
		toolName: "bash",
		summary: "rm -rf build",
		args: { command: "rm -rf build" },
		firstCommand: "rm",
		...overrides,
	};
}

describe("PermissionGate", () => {
	test("allow once permits the call without memory", async () => {
		const gate = new PermissionGate(
			async () => "allow" as PermissionDecision,
			async () => ({ action: "allow" }),
		);
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
	});

	test("allow session remembers the tool for the session", async () => {
		const answers: PermissionDecision[] = ["allow_session", "deny"];
		let asked = 0;
		const gate = new PermissionGate(
			async () => answers[asked++],
			async () => ({ action: "allow" }),
		);
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
		// Second call does not prompt anymore.
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
		expect(asked).toBe(1);
	});

	test("deny reports the rejection", async () => {
		const gate = new PermissionGate(
			async () => "deny",
			async () => ({ action: "allow" }),
		);
		const outcome = await gate.check(info());
		expect(outcome.action).toBe("deny");
		if (outcome.action !== "deny") throw new Error("unreachable");
		expect(outcome.reason).toContain("declined");
	});

	test("dismissed prompts deny", async () => {
		const gate = new PermissionGate(
			async () => undefined,
			async () => ({ action: "allow" }),
		);
		const outcome = await gate.check(info());
		expect(outcome.action).toBe("deny");
		if (outcome.action !== "deny") throw new Error("unreachable");
		expect(outcome.reason).toContain("dismissed");
	});

	test("ai decide caches the verdict per tool+first command class", async () => {
		let judged = 0;
		const verdicts: PermissionOutcome[] = [{ action: "deny", reason: "risky" }, { action: "allow" }];
		const gate = new PermissionGate(
			async () => "ai_decide",
			async () => {
				judged++;
				return verdicts[judged - 1] ?? { action: "allow" };
			},
		);
		// First call: judged deny.
		expect(await gate.check(info())).toEqual({ action: "deny", reason: "risky" });
		// Same class (bash + rm): cached deny, no new judgment.
		expect(await gate.check(info({ callId: "call-2" }))).toEqual({ action: "deny", reason: "risky" });
		// Different first command: a fresh judgment (allow).
		expect(await gate.check(info({ callId: "call-3", firstCommand: "make", args: { command: "make" } }))).toEqual({
			action: "allow",
		});
		expect(judged).toBe(2);
	});

	test("approveOnce runs that call only and keeps no memory", async () => {
		let asked = 0;
		const gate = new PermissionGate(
			async () => {
				asked++;
				return "deny" as PermissionDecision;
			},
			async () => ({ action: "allow" }),
		);
		gate.approveOnce("call-1");
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
		// The approval was spent: the next call of the same kind asks again.
		await expect(gate.check(info({ callId: "call-2" }))).resolves.toEqual({
			action: "deny",
			reason: "The user declined this bash call",
		});
		expect(asked).toBe(1);
	});

	test("an approval also answers a hazard, which a session allowance does not cover", async () => {
		let asked = 0;
		const gate = new PermissionGate(
			async () => {
				asked++;
				return "deny" as PermissionDecision;
			},
			async () => ({ action: "allow" }),
		);
		gate.approveOnce("call-1");
		const hazardous = info({ hazard: "git reset --hard discards uncommitted changes" });
		await expect(gate.check(hazardous)).resolves.toEqual({ action: "allow" });
		expect(asked).toBe(0);
	});

	test("an approval that lands while the prompt is up wins over a dismissal", async () => {
		const gate = new PermissionGate(
			async (call) => {
				// The user pressed "explain" and continued: the approval arrives
				// before the prompt listener resolves.
				gate.approveOnce(call.callId);
				return undefined;
			},
			async () => ({ action: "allow" }),
		);
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
	});

	test("a hazard is gated even after the tool was allowed for the session", async () => {
		let asked = 0;
		const gate = new PermissionGate(
			async () => {
				asked++;
				return "allow_session";
			},
			async () => ({ action: "allow" }),
		);
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
		// Same tool, no hazard: the session answer stands.
		await expect(gate.check(info({ callId: "call-2", summary: "ls" }))).resolves.toEqual({ action: "allow" });
		expect(asked).toBe(1);
		// A destructive command is not what the user allowed for the session.
		await expect(
			gate.check(info({ callId: "call-3", summary: "git reset --hard", hazard: "git reset --hard ..." })),
		).resolves.toEqual({ action: "allow" });
		expect(asked).toBe(2);
	});

	test("allow_once runs one call and is asked again next time", async () => {
		const answers: Array<PermissionDecision | undefined> = ["allow_once", "allow_once", undefined];
		let asked = 0;
		const gate = new PermissionGate(
			async () => answers[asked++],
			async () => ({ action: "allow" }),
		);
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
		// Nothing was remembered: the next call of the same kind prompts again.
		await expect(gate.check(info({ callId: "call-2" }))).resolves.toEqual({ action: "allow" });
		expect(asked).toBe(2);
		const dismissed = await gate.check(info({ callId: "call-3" }));
		expect(dismissed.action).toBe("deny");
	});

	test("allow_once is single-shot even for a hazard", async () => {
		const gate = new PermissionGate(
			async () => "allow_once" as PermissionDecision,
			async () => ({ action: "allow" }),
		);
		const hazardous = info({ hazard: "git reset --hard discards uncommitted changes" });
		await expect(gate.check(hazardous)).resolves.toEqual({ action: "allow" });
		// A hazard is not covered by a session allowance, and allow_once made none:
		// the next call of the same kind goes back to the prompt.
		await expect(gate.check(hazardous)).resolves.toEqual({ action: "allow" });
	});

	test("ai_decide keeps covering the class after the answer", async () => {
		let judged = 0;
		const gate = new PermissionGate(
			async () => "ai_decide" as PermissionDecision,
			async () => {
				judged++;
				return { action: "allow" };
			},
		);
		await expect(gate.check(info())).resolves.toEqual({ action: "allow" });
		await expect(gate.check(info({ callId: "call-2" }))).resolves.toEqual({ action: "allow" });
		expect(judged).toBe(1);
	});

	test("a hazard gets its own judgment class", async () => {
		let judged = 0;
		const gate = new PermissionGate(
			async () => "ai_decide",
			async () => {
				judged++;
				return { action: "deny", reason: "destroys uncommitted work" };
			},
		);
		// The plain class is judged once and cached.
		await gate.check(info());
		await gate.check(info({ callId: "call-2" }));
		expect(judged).toBe(1);
		// The same command carrying a hazard is judged for itself, not answered by that cache.
		const outcome = await gate.check(info({ callId: "call-3", hazard: "git stash warning" }));
		expect(outcome.action).toBe("deny");
		expect(judged).toBe(2);
	});
});

describe("PermissionBroker", () => {
	test("queues prompts and resolves answers in order", async () => {
		const broker = new PermissionBroker();
		const events: string[] = [];
		broker.subscribe((event) => events.push(event.type));

		const first = broker.prompter(info({ callId: "a" }));
		const second = broker.prompter(info({ callId: "b" }));

		await settle();
		expect(events).toEqual(["prompt"]);

		expect(broker.answer("b", undefined, "allow")).toBe(false); // wrong call id
		expect(broker.answer("a", undefined, "deny")).toBe(true);
		await expect(first).resolves.toBe("deny");

		expect(broker.answer(undefined, "bash", "allow_session")).toBe(true);
		await expect(second).resolves.toBe("allow_session");
		expect(events).toEqual(["prompt", "resolved", "prompt", "resolved"]);
	});

	test("explain pauses the prompt, and the card's next answer settles it", async () => {
		const broker = new PermissionBroker();
		const events: string[] = [];
		broker.subscribe((event) => events.push(event.type));

		const pending = broker.prompter(info({ callId: "a" }));
		await settle();

		// "explain" reaches the gate as an answer of its own, not as a decision:
		// the gate pauses on it and asks again through `explanationPrompter`.
		expect(broker.answer("a", undefined, "explain")).toBe(true);
		await expect(pending).resolves.toBe("explain");
		const paused = broker.explanationPrompter(info({ callId: "a" }));
		// A second explanation on the same prompt would stack turns on one call.
		expect(broker.answer("a", undefined, "explain")).toBe(false);

		// The prompt is still outstanding: the answer after the explanation is.
		expect(broker.answer("a", undefined, "allow_once")).toBe(true);
		await expect(paused).resolves.toBe("allow_once");
		expect(events).toEqual(["prompt", "explain", "resolved"]);
	});

	test("cancelAll resolves pending prompts as dismissed", async () => {
		const broker = new PermissionBroker();
		const pending = broker.prompter(info());
		await settle();
		broker.cancelAll();
		await expect(pending).resolves.toBeUndefined();
	});
});

// The webui has no editor, so its "explain" answer arrives through the broker
// while the gate is parked on the card. Regressions behind issue #293: the pause
// was taken before the prompt was shown (so the card never appeared) and an
// unanswered pause was read as a dismissal, which failed every gated call with
// "the permission prompt for this bash call was dismissed".
describe("webui explanation handshake", () => {
	/** Exactly what extension.ts wires for a webui session. */
	function webuiGate() {
		const broker = new PermissionBroker();
		const events: string[] = [];
		broker.subscribe((event) => events.push(event.type));
		const gate = new PermissionGate(
			broker.prompter,
			async () => ({ action: "deny", reason: "no" }),
			broker.explanationPrompter,
		);
		return { broker, events, gate };
	}

	test("the card is shown and its first answer settles the call", async () => {
		const { broker, events, gate } = webuiGate();
		const run = gate.check(info({ callId: "call-1" }));
		await settle();
		expect(events).toEqual(["prompt"]);

		expect(broker.answer("call-1", "bash", "allow_once")).toBe(true);
		await expect(run).resolves.toEqual({ action: "allow" });
		expect(events).toEqual(["prompt", "resolved"]);
	});

	test("explain pauses the call, and the answer after it still runs once", async () => {
		const { broker, events, gate } = webuiGate();
		const run = gate.check(info({ callId: "call-1" }));
		await settle();

		expect(broker.answer("call-1", "bash", "explain")).toBe(true);
		await settle();
		expect(events).toEqual(["prompt", "explain"]);
		// Nothing ran while the explanation was in flight, and the card cannot
		// be asked to explain itself twice.
		expect(broker.answer("call-1", "bash", "explain")).toBe(false);

		expect(broker.answer("call-1", "bash", "allow_once")).toBe(true);
		await expect(run).resolves.toEqual({ action: "allow" });
		expect(events).toEqual(["prompt", "explain", "resolved"]);
	});

	test("allow once after an explanation leaves the next call gated", async () => {
		const { broker, events, gate } = webuiGate();
		const first = gate.check(info({ callId: "call-1" }));
		await settle();
		broker.answer("call-1", "bash", "allow_once");
		await expect(first).resolves.toEqual({ action: "allow" });

		const second = gate.check(info({ callId: "call-2" }));
		await settle();
		expect(events).toEqual(["prompt", "resolved", "prompt"]);
		broker.answer("call-2", "bash", "deny");
		await expect(second).resolves.toMatchObject({ action: "deny", reason: expect.stringContaining("declined") });
	});

	test("allow this session after an explanation remembers the tool", async () => {
		const { broker, gate } = webuiGate();
		const first = gate.check(info({ callId: "call-1" }));
		await settle();
		broker.answer("call-1", "bash", "explain");
		await settle();
		broker.answer("call-1", "bash", "allow_session");
		await expect(first).resolves.toEqual({ action: "allow" });
		await expect(gate.check(info({ callId: "call-9" }))).resolves.toEqual({ action: "allow" });
	});

	test("a settled prompt is not paused again", async () => {
		const { broker, events, gate } = webuiGate();
		const run = gate.check(info({ callId: "call-1" }));
		await settle();
		broker.answer("call-1", "bash", "explain");
		await settle();
		// A late "explain" for a prompt that is gone must not start a pause.
		expect(await gate.explain(info({ callId: "missing" }))).toBeUndefined();
		expect(broker.answer("call-1", "bash", "allow_once")).toBe(true);
		await expect(run).resolves.toEqual({ action: "allow" });
		expect(events).toEqual(["prompt", "explain", "resolved"]);
	});
});

/**
 * Let the call reach its prompt: `explain()` awaits the prompter before it can
 * land on one, and the broker's prompter queues the entry synchronously, so one
 * macrotask is enough for the card to be outstanding.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
