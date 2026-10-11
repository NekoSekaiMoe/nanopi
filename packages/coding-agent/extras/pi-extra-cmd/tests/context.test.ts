/**
 * /context tests — data layer ported from pi-cc-extensions plus keyboard-driven
 * dialog behavior (render, navigation, preview scrolling).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import {
	capParts,
	collectContextBreakdown,
	resolveUsedTokens,
} from "../src/context.ts";
import { showContextDialog, showTextPreview } from "../src/context-dialog.ts";

initTheme("dark");

// ---------------------------------------------------------------------------
// Data layer (ported from pi-cc-extensions tests/context-dialog.test.ts)
// ---------------------------------------------------------------------------

test("context breakdown separates tools, results, and conversation without inflating estimates", () => {
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [{ path: "AGENTS.md", content: "cccc" }],
			skills: [
				{ name: "ok", description: "desc", filePath: "/v" },
				{
					name: "hidden",
					description: "x".repeat(100),
					filePath: "/hidden",
					disableModelInvocation: true,
				},
			],
		}),
		getSystemPrompt: () => "s".repeat(200),
		sessionManager: {
			buildContextEntries: () => [
				{ type: "message", message: { role: "user", content: "uuuuuuuu", timestamp: 0 } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "aaaa" },
							{ type: "toolCall", id: "1", name: "read", arguments: { path: "a" } },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "1",
						toolName: "read",
						content: "rrrrrrrr",
						timestamp: 0,
					},
				},
				{ type: "compaction", summary: "ssss" },
			],
		},
	} as any;
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object" },
			promptGuidelines: [],
			sourceInfo: {},
		},
	] as any;

	const breakdown = collectContextBreakdown(ctx, tools);
	const parts = breakdown.parts;
	assert.deepEqual(
		parts.map(({ label, color }) => [label, color]),
		[
			["System prompt", "accent"],
			["Memory", "error"],
			["Skills", "warning"],
			["Tools definition", "success"],
			["Tool results", "customMessageLabel"],
			["Context", "warning"],
		],
	);
	assert.equal(parts.find((part) => part.label === "System prompt")?.tokens, 50);
	assert.equal(parts.find((part) => part.label === "Memory")?.tokens, 0);
	assert.equal(parts.find((part) => part.label === "Skills")?.tokens, 0);
	assert.match(breakdown.previews.memoryFiles, /## AGENTS\.md/);
	assert.match(breakdown.previews.memoryFiles, /cccc/);
	assert.match(breakdown.previews.skills, /<name>ok<\/name>/);
	assert.doesNotMatch(breakdown.previews.skills, /hidden/);
	assert.equal(parts.find((part) => part.label === "Tool results")?.tokens, 2);
	assert.equal(parts.find((part) => part.label === "Context")?.tokens, 8);
	assert.match(breakdown.previews.tools, /Definition: read/);
	assert.match(breakdown.previews.tools, /"parameters"/);
	assert.doesNotMatch(breakdown.previews.tools, /Call: read/);
	assert.match(breakdown.previews.toolResults, /Result: read/);
	assert.match(breakdown.previews.toolResults, /rrrrrrrr/);
	assert.match(breakdown.previews.contextFiles, /uuuuuuuu/);
	assert.match(breakdown.previews.contextFiles, /Assistant tool call: read/);
	assert.match(breakdown.previews.contextFiles, /"path": "a"/);
	assert.match(breakdown.previews.contextFiles, /Compaction/);

	const fitted = capParts(parts, parts.reduce((sum, part) => sum + part.tokens, 0) + 10);
	assert.deepEqual(fitted, parts, "estimates are not inflated to fill provider usage");
	const fixedTokens = parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
	const capped = capParts(parts, fixedTokens + 5, 4);
	assert.deepEqual(
		capped.slice(0, 4),
		parts.slice(0, 4),
		"system prompt, memory, skills and tools definition stay stable",
	);
	assert.equal(
		capped.reduce((sum, part) => sum + part.tokens, 0),
		fixedTokens + 5,
	);
});

test("context breakdown attributes embedded memory and skills once", () => {
	const memory = "cccc";
	const skills = [{ name: "ok", description: "desc", filePath: "/v" }];
	const skillsText = formatSkillsForPrompt(skills as any).trim();
	const systemPrompt = `base\n<project_instructions>\n${memory}\n</project_instructions>\n${skillsText}`;
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: [],
			contextFiles: [{ path: "AGENTS.md", content: memory }],
			skills,
		}),
		getSystemPrompt: () => systemPrompt,
		sessionManager: { buildContextEntries: () => [] },
	} as any;

	const breakdown = collectContextBreakdown(ctx, []);
	const systemTokens = breakdown.parts.find((part) => part.label === "System prompt")?.tokens ?? -1;
	const memoryTokens = breakdown.parts.find((part) => part.label === "Memory")?.tokens ?? -1;
	const skillsTokens = breakdown.parts.find((part) => part.label === "Skills")?.tokens ?? -1;
	assert.equal(memoryTokens, Math.ceil(memory.length / 4));
	assert.equal(skillsTokens, Math.ceil(skillsText.length / 4));
	assert.equal(systemTokens + memoryTokens + skillsTokens, Math.ceil(systemPrompt.length / 4));
	assert.ok(systemTokens < Math.ceil(systemPrompt.length / 4));
});

test("resolveUsedTokens rejects inconsistent or implausibly small provider usage", () => {
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 7 }, 20_000, 272_000), 19_040);
	assert.equal(resolveUsedTokens({ tokens: 19_000, percent: 7 }, 20_000, 272_000), 19_000);
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 1 / 2_720 }, 20_000, 272_000), 20_000);
	assert.equal(resolveUsedTokens({ tokens: null, percent: null }, 20_000, 272_000), 20_000);
});

test("capParts never produces negative tokens when estimates exceed usage", () => {
	const parts = Array.from({ length: 8 }, (_, index) => ({
		label: String(index),
		tokens: 1,
		color: "dim" as const,
	}));
	const fitted = capParts(parts, 5);
	assert.equal(
		fitted.reduce((sum, part) => sum + part.tokens, 0),
		5,
	);
	assert.ok(fitted.every((part) => part.tokens >= 0));
});

// ---------------------------------------------------------------------------
// Dialog TUI (keyboard harness)
// ---------------------------------------------------------------------------

const stubTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_color: string, text: string) => text,
};

/** Minimal ui.custom harness: mounts each factory's component, exposes it live. */
function dialogHarness() {
	let component: any;
	const ui = {
		custom: async (factory: any) =>
			await new Promise<any>((resolve) => {
				component = factory(
					{ terminal: { columns: 80, rows: 24 }, requestRender() {} },
					stubTheme,
					null,
					resolve,
				);
			}),
	};
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
	return {
		ui,
		tick,
		/** Live component reference — replaced whenever a new dialog mounts. */
		get component() {
			return component;
		},
	};
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const END = "\x1b[F";

const dialogData = {
	used: 20_000,
	contextWindow: 272_000,
	parts: [
		{ label: "System prompt", tokens: 5_000, color: "accent" as const },
		{ label: "Memory", tokens: 3_000, color: "error" as const },
		{ label: "Skills", tokens: 2_000, color: "warning" as const },
		{ label: "Tools definition", tokens: 4_000, color: "success" as const },
		{ label: "Tool results", tokens: 3_000, color: "customMessageLabel" as const },
		{ label: "Context", tokens: 2_000, color: "warning" as const },
		{ label: "Other", tokens: 1_000, color: "muted" as const },
		{ label: "Free space", tokens: 252_000, color: "dim" as const },
	],
	previews: [
		{ key: "systemPrompt", label: "System prompt", title: "System Prompt", content: "# system" },
		{ key: "memoryFiles", label: "Memory", title: "Memory Files", content: "## AGENTS.md" },
	],
};

test("main dialog renders ask-lite chrome and navigates with the keyboard", async () => {
	const harness = dialogHarness();
	const finished = showContextDialog({ ui: harness.ui } as any, dialogData);

	const out = harness.component.render(80).join("\n");
	assert.match(out, /Context Usage/);
	assert.match(out, /20\.0k \/ 272k tokens \(7\.4%\)/);
	assert.match(out, /System prompt/);
	assert.match(out, /Free space/);
	assert.match(out, /Enter to preview · ↑\/↓ to navigate · Esc to close/);
	assert.match(out, /› ■ System prompt/, "first preview row starts selected");

	harness.component.handleInput(DOWN);
	assert.match(harness.component.render(80).join("\n"), /› ■ Memory/);
	harness.component.handleInput(UP);
	assert.match(harness.component.render(80).join("\n"), /› ■ System prompt/);

	// Enter opens the preview of the selected row; Esc backs out, Esc closes.
	harness.component.handleInput(ENTER);
	await harness.tick();
	assert.match(harness.component.render(80).join("\n"), /System Prompt/);
	harness.component.handleInput(ESC);
	await harness.tick();
	assert.match(harness.component.render(80).join("\n"), /Context Usage/);
	harness.component.handleInput(ESC);
	await finished;
});

test("text preview scrolls and shows overflow markers + line counters", async () => {
	const harness = dialogHarness();
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const finished = showTextPreview({ ui: harness.ui } as any, "Context", content);

	const initial = harness.component.render(80).join("\n");
	// 24 rows terminal → pageSize 19.
	assert.match(initial, /1-19 \/ 100 lines/);
	assert.doesNotMatch(initial, /^ ↑ +$/m, "no overflow-up marker at the top");

	harness.component.handleInput(END);
	const scrolled = harness.component.render(80).join("\n");
	assert.match(scrolled, /82-100 \/ 100 lines/);
	assert.match(scrolled, /^ ↑ +$/m, "overflow-up marker replaces the first visible row");
	assert.match(scrolled, /Esc to back/);
	assert.match(scrolled, /line 100/);

	harness.component.handleInput(ESC);
	await finished;
});

test("text preview strips markdown fence marker lines", async () => {
	const harness = dialogHarness();
	const content = "## Result: read\n\n```json\n{\"path\": \"a\"}\n```";
	const finished = showTextPreview({ ui: harness.ui } as any, "Tool Results", content);
	const out = harness.component.render(80).join("\n");
	assert.doesNotMatch(out, /```json/);
	assert.match(out, /"path": "a"/);
	harness.component.handleInput(ESC);
	await finished;
});
