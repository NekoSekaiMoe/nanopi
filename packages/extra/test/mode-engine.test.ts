import { describe, expect, test } from "vitest";
import { judgeWithModel } from "../src/ai-judge.ts";
import { badgeLabels, renderFooterLine } from "../src/footer.ts";
import { ModeEngine } from "../src/mode-engine.ts";
import type { PermissionCallInfo } from "../src/permission-types.ts";

describe("ModeEngine", () => {
	test("defaults to standard without yolo", () => {
		const engine = new ModeEngine();
		expect(engine.snapshot()).toEqual({ mode: "standard", yolo: false, reason: undefined });
	});

	test("setMode notifies subscribers and clears the minimal snapshot", () => {
		const engine = new ModeEngine();
		const seen: string[] = [];
		engine.subscribe((snapshot) => seen.push(snapshot.mode));
		engine.setPreMinimalTools(["read", "bash"]);
		engine.setMode("minimal");
		expect(engine.preMinimalTools).toEqual(["read", "bash"]);
		engine.setMode("standard");
		expect(engine.preMinimalTools).toBeUndefined();
		engine.setMode("plan", "/plan");
		expect(seen).toEqual(["minimal", "standard", "plan"]);
		expect(engine.reason).toBe("/plan");
	});

	test("setMode ignores same-value switches and rejects invalid modes", () => {
		const engine = new ModeEngine();
		let notifications = 0;
		engine.subscribe(() => notifications++);
		engine.setMode("standard");
		expect(notifications).toBe(0);
		expect(() => engine.setMode("yolo" as never)).toThrow(/invalid run mode/);
	});

	test("yolo is independent from the mode", () => {
		const engine = new ModeEngine();
		engine.setYolo(true);
		engine.setMode("plan");
		expect(engine.snapshot()).toMatchObject({ mode: "plan", yolo: true });
	});
});

describe("footer badges", () => {
	test("yolo and plan badges can show together", () => {
		const engine = new ModeEngine();
		expect(badgeLabels(engine)).toEqual([]);
		engine.setYolo(true);
		expect(badgeLabels(engine)).toEqual(["yolo"]);
		engine.setMode("plan");
		expect(badgeLabels(engine)).toEqual(["yolo", "plan"]);
		engine.setMode("minimal");
		expect(badgeLabels(engine)).toEqual(["yolo"]);
	});

	test("usage line matches the built-in footer format", () => {
		const ctx = {
			getContextUsage: () => ({ tokens: 12_345, percent: null, contextWindow: 200_000 }),
			model: undefined,
		};
		const theme = { fg: (_c: string, text: string) => text };
		expect(renderFooterLine(ctx, theme, 120)).toBe("used 12k/200k · / for more details");
		const small = {
			getContextUsage: () => ({ tokens: 9_500, percent: null, contextWindow: 20_000 }),
			model: undefined,
		};
		expect(renderFooterLine(small, theme, 120)).toBe("used 9.5k/20k · / for more details");
	});
});

describe("judgeWithModel", () => {
	const info: PermissionCallInfo = {
		callId: "c1",
		toolName: "bash",
		summary: "rm -rf build",
		args: { command: "rm -rf build" },
		firstCommand: "rm",
	};

	test("parses an allow verdict", async () => {
		const registry = {
			complete: async () => ({ content: [{ type: "text", text: '{"allow": true, "reason": "build cleanup"}' }] }),
		};
		await expect(judgeWithModel(info, {}, registry)).resolves.toEqual({ action: "allow" });
	});

	test("parses a deny verdict from fenced output", async () => {
		const registry = {
			complete: async () => ({
				content: [{ type: "text", text: '```json\n{"allow": false, "reason": "destructive"}\n```' }],
			}),
		};
		const outcome = await judgeWithModel(info, {}, registry);
		expect(outcome.action).toBe("deny");
		if (outcome.action !== "deny") throw new Error("unreachable");
		expect(outcome.reason).toContain("destructive");
	});

	test("fails closed on errors and unparsable output", async () => {
		await expect(judgeWithModel(info, undefined, undefined)).resolves.toMatchObject({ action: "deny" });
		const throwing = {
			complete: async () => {
				throw new Error("no key");
			},
		};
		await expect(judgeWithModel(info, {}, throwing)).resolves.toMatchObject({ action: "deny" });
		const garbage = { complete: async () => ({ content: [{ type: "text", text: "sure thing" }] }) };
		await expect(judgeWithModel(info, {}, garbage)).resolves.toMatchObject({ action: "deny" });
	});
});
