import { strictEqual } from "node:assert";
import { describe, it } from "vitest";
import type { ModuleCommandContext } from "../src/index.ts";
import { formatSkillsForPrompt, initTheme } from "../src/index.ts";
import {
	capParts,
	collectContextBreakdown,
	formatTokens,
	resolveUsedTokens,
} from "../src/modules/builtin-commands/context.ts";
import type { ContextPart } from "../src/modules/builtin-commands/context-dialog.ts";

initTheme("dark");

describe("formatTokens", () => {
	it("formats small, thousands, and large values", () => {
		strictEqual(formatTokens(42), "42");
		strictEqual(formatTokens(12_300), "12.3k");
		strictEqual(formatTokens(272_000), "272k");
	});
});

describe("capParts", () => {
	const parts: ContextPart[] = [
		{ label: "System prompt", tokens: 100, color: "accent" },
		{ label: "Memory", tokens: 50, color: "error" },
		{ label: "Tool results", tokens: 400, color: "customMessageLabel" },
		{ label: "Context", tokens: 600, color: "warning" },
	];

	it("keeps parts untouched when the estimate fits the target", () => {
		strictEqual(capParts(parts, 2_000, 2), parts);
	});

	it("caps only the variable parts, proportionally, keeping the total", () => {
		const capped = capParts(parts, 500, 2);
		strictEqual(capped[0].tokens, 100);
		strictEqual(capped[1].tokens, 50);
		const total = capped.reduce((sum, part) => sum + part.tokens, 0);
		strictEqual(total, 500);
	});

	it("zeroes the variable parts when the fixed parts already exceed the target", () => {
		const capped = capParts(parts, 100, 2);
		strictEqual(capped[2].tokens, 0);
		strictEqual(capped[3].tokens, 0);
	});
});

describe("resolveUsedTokens", () => {
	it("prefers the reported token count", () => {
		strictEqual(resolveUsedTokens({ tokens: 900, percent: null }, 100, 10_000), 900);
	});

	it("derives from percent when tokens are missing", () => {
		strictEqual(resolveUsedTokens({ tokens: null, percent: 50 }, 100, 10_000), 5_000);
	});

	it("trusts the percentage when the reported total disagrees beyond tolerance", () => {
		strictEqual(resolveUsedTokens({ tokens: 1_000, percent: 90 }, 100, 10_000), 9_000);
	});

	it("falls back to the estimate when usage is implausibly small", () => {
		strictEqual(resolveUsedTokens({ tokens: 10, percent: null }, 1_000, 10_000), 1_000);
	});
});

describe("collectContextBreakdown", () => {
	it("separates tool definitions, tool results, and conversation without inflating estimates", () => {
		const skills = [{ name: "ok", description: "desc", filePath: "/v" }] as unknown as Parameters<
			typeof formatSkillsForPrompt
		>[0];
		const skillsText = formatSkillsForPrompt(skills).trim();
		const systemPrompt = `${"s".repeat(200)}${"m".repeat(40)}${skillsText}`;
		const ctx = {
			getSystemPromptOptions: () => ({
				cwd: "/repo",
				selectedTools: ["read"],
				contextFiles: [{ path: "AGENTS.md", content: "m".repeat(40) }],
				skills,
			}),
			getSystemPrompt: () => systemPrompt,
			sessionManager: {
				buildContextEntries: () => [
					{
						type: "message",
						message: {
							role: "user",
							content: [{ type: "text", text: "hello world" }],
							timestamp: 1,
						},
						id: "u1",
						timestamp: 1,
					},
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/f" } }],
							timestamp: 2,
						},
						id: "a1",
						timestamp: 2,
					},
					{
						type: "message",
						message: {
							role: "toolResult",
							toolCallId: "t1",
							toolName: "read",
							content: [{ type: "text", text: "file body" }],
							isError: false,
							timestamp: 3,
						},
						id: "r1",
						timestamp: 3,
					},
				],
			},
		} as unknown as ModuleCommandContext;

		const breakdown = collectContextBreakdown(ctx, [
			{ name: "read", description: "Read files", parameters: { type: "object" } },
			{ name: "bash", description: "Run commands", parameters: { type: "object" } },
		] as unknown as Parameters<typeof collectContextBreakdown>[1]);
		const byLabel = new Map(breakdown.parts.map((part) => [part.label, part.tokens]));

		strictEqual((byLabel.get("Tools definition") ?? 0) > 0, true); // only the selected tool
		strictEqual((byLabel.get("Tool results") ?? 0) > 0, true);
		strictEqual((byLabel.get("Context") ?? 0) > 0, true);
		strictEqual((byLabel.get("Memory") ?? 0) > 0, true);
		strictEqual((byLabel.get("Skills") ?? 0) > 0, true);
		strictEqual(breakdown.previews.contextFiles.includes("hello world"), true);
		strictEqual(breakdown.previews.toolResults.includes("file body"), true);
	});
});
