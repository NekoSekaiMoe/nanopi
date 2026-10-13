import { describe, expect, it } from "vitest";
import type { ModuleCommandContext } from "../src/index.ts";
import { initTheme } from "../src/index.ts";
import { renderWelcomeBox, renderWelcomeTip, WelcomeHeader } from "../src/modes/interactive/components/welcome-box.ts";
import { collectStatusRows, collectStatusSections } from "../src/modules/builtin-commands/status.ts";
import { wrapStatusText } from "../src/modules/builtin-commands/status-dialog.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

initTheme("dark");

function createStatusCtx(): ModuleCommandContext {
	return {
		model: { id: "gpt-test", provider: "openai", contextWindow: 200_000, reasoning: true },
		thinkingLevel: "high",
		cwd: "/home/user/project",
		sessionManager: {
			getSessionName: () => "demo",
			getSessionId: () => "sess-1",
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				},
			],
		},
		getContextUsage: () => ({ tokens: 12_300, percent: 6.1, contextWindow: 200_000 }),
	} as unknown as ModuleCommandContext;
}

describe("welcome box", () => {
	it("renders π title, model/provider/thinking/directory rows without the /model hint", () => {
		const lines = renderWelcomeBox(
			{
				version: "0.99.0",
				modelId: "gpt-test",
				provider: "openai",
				thinkingLevel: "high",
				showThinking: true,
				cwd: "~",
			},
			80,
		).map(stripAnsi);
		const text = lines.join("\n");
		expect(text).toContain("π NanoPi v0.99.0");
		expect(text).toContain("model:");
		expect(text).toContain("gpt-test");
		expect(text).not.toContain("/model to change");
		expect(text).toContain("provider:");
		expect(text).toContain("thinking: high");
		expect(text).toContain("directory: ~");
		expect(stripAnsi(renderWelcomeTip(200))).toContain("/status");
		expect(stripAnsi(renderWelcomeTip(200))).toContain("loaded extensions and skills");

		const prefixed = renderWelcomeBox(
			{
				version: "0.99.0",
				modelId: "openai/gpt-5.2",
				provider: "openai",
				thinkingLevel: "high",
				showThinking: true,
				cwd: "~",
			},
			80,
		)
			.map(stripAnsi)
			.join("\n");
		expect(prefixed).toContain("model:     gpt-5.2");
		expect(prefixed).not.toContain("openai/gpt-5.2");
		expect(prefixed).toContain("provider:  openai");

		const header = new WelcomeHeader(() => ({
			version: "0.99.0",
			modelId: "gpt-test",
			provider: "openai",
			thinkingLevel: "high",
			showThinking: true,
			cwd: "~",
		}));
		expect(header.render(80).map(stripAnsi).join("\n")).toContain("π NanoPi v0.99.0");
	});

	it("truncates the tip to the terminal width", () => {
		const tip = stripAnsi(renderWelcomeTip(40));
		expect(tip.length).toBeLessThanOrEqual(40);
		expect(tip.endsWith("…")).toBe(true);
	});
});

describe("collectStatusRows", () => {
	it("maps nanopi fields without the Codex Visit row", () => {
		const rows = collectStatusRows(createStatusCtx(), []);
		const labels = rows.map((row) => row.label);
		expect(labels).toEqual([
			"Model:",
			"Model provider:",
			"Directory:",
			"Session:",
			"Thinking:",
			"Token usage:",
			"Context:",
		]);
		const byLabel = new Map(rows.map((row) => [row.label, row.value]));
		expect(byLabel.get("Model:")).toBe("gpt-test");
		expect(byLabel.get("Model provider:")).toBe("openai");
		expect(byLabel.get("Thinking:")).toBe("high");
		expect(byLabel.get("Token usage:")).toContain("150 total");
		expect(byLabel.get("Context:")).toContain("12.3k / 200k");
		expect(labels.some((label) => label.toLowerCase().includes("visit"))).toBe(false);
	});
});

describe("wrapStatusText", () => {
	it("wraps on spaces and keeps overlong words on their own line", () => {
		expect(wrapStatusText("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
		expect(wrapStatusText("alpha", 3)).toEqual(["alpha"]);
		expect(wrapStatusText("", 10)).toEqual([""]);
	});
});

describe("collectStatusSections", () => {
	it("lists context files, skills, prompts, and extensions from getLoadedResources", () => {
		const ctx = {
			...createStatusCtx(),
			cwd: "/repo",
			getLoadedResources: () => ({
				contextFiles: [{ path: "/repo/.nanopi/SYSTEM.md" }, { path: "/repo/AGENTS.md" }],
				skills: [{ name: "zeta", path: "/repo/.nanopi/skills/zeta/SKILL.md" }],
				prompts: [{ name: "review", path: "/repo/.nanopi/prompts/review.md" }],
				extensions: [
					{
						path: "/repo/.nanopi/extensions/plan-mode/index.ts",
						sourceInfo: {
							path: "/repo/.nanopi/extensions/plan-mode/index.ts",
							source: "local",
							scope: "project",
							origin: "top-level",
						},
					},
				],
			}),
		} as unknown as ModuleCommandContext;

		const sections = collectStatusSections(ctx);
		expect(sections).toEqual([
			{ title: "Context", items: [".nanopi/SYSTEM.md", "AGENTS.md"] },
			{ title: "Skills", items: ["zeta"] },
			{ title: "Prompts", items: ["/review"] },
			{ title: "Extensions", items: ["plan-mode"] },
		]);
	});

	it("omits empty sections", () => {
		const ctx = {
			...createStatusCtx(),
			cwd: "/repo",
			getLoadedResources: () => ({ contextFiles: [], skills: [], prompts: [], extensions: [] }),
		} as unknown as ModuleCommandContext;

		expect(collectStatusSections(ctx)).toEqual([]);
	});
});
