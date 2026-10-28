import { describe, expect, test } from "vitest";
import { judgeWithModel } from "../src/ai-judge.ts";
import { narrowsToItself } from "../src/extension.ts";
import { ModeEngine } from "../src/mode-engine.ts";
import type { PermissionCallInfo } from "../src/permission-types.ts";

describe("ModeEngine", () => {
	test("defaults to standard without yolo", () => {
		const engine = new ModeEngine();
		expect(engine.snapshot()).toEqual({ mode: "standard", yolo: false, reason: undefined });
	});

	test("setMode notifies subscribers and drops the minimal snapshot on use", () => {
		const engine = new ModeEngine();
		const seen: string[] = [];
		engine.subscribe((snapshot) => seen.push(snapshot.mode));
		engine.setMode("minimal");
		// Captured by the listener while entering: it survives the switch it was
		// taken on, which is the whole point of the field.
		engine.setPreMinimalTools(["read", "bash"]);
		expect(engine.preMinimalTools).toEqual(["read", "bash"]);
		// Any other mode drops the restore point, so no session keeps a loadout it
		// is no longer restricted to (the restore itself reads it before this call).
		engine.setMode("plan", "/plan");
		expect(engine.preMinimalTools).toBeUndefined();
		expect(seen).toEqual(["minimal", "plan"]);
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

// `/minimal` narrows the loadout to the shell tools. In a shell-only build
// (`toolset: "bash"`, the minimal SKU) that is the set it already has, so the
// mode would narrow to itself: no tools removed on entry, and a snapshot equal
// to the current loadout to "restore" on exit.
describe("minimal mode in a shell-only build", () => {
	test("narrows to itself only when every tool is a shell tool", () => {
		expect(narrowsToItself(["bash", "powershell"])).toBe(true);
		expect(narrowsToItself(["bash", "read"])).toBe(false);
		// No tools at all is `--no-tools`, not a shell-only build.
		expect(narrowsToItself([])).toBe(false);
	});
});
