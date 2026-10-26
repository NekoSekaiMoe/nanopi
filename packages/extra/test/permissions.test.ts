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

		await Promise.resolve();
		expect(events).toEqual(["prompt"]);

		expect(broker.answer("b", undefined, "allow")).toBe(false); // wrong call id
		expect(broker.answer("a", undefined, "deny")).toBe(true);
		await expect(first).resolves.toBe("deny");

		expect(broker.answer(undefined, "bash", "allow_session")).toBe(true);
		await expect(second).resolves.toBe("allow_session");
		expect(events).toEqual(["prompt", "resolved", "prompt", "resolved"]);
	});

	test("cancelAll resolves pending prompts as dismissed", async () => {
		const broker = new PermissionBroker();
		const pending = broker.prompter(info());
		await Promise.resolve();
		broker.cancelAll();
		await expect(pending).resolves.toBeUndefined();
	});
});
