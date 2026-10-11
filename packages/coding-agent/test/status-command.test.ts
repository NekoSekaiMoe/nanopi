import { describe, expect, it } from "vitest";
import { collectStatusRows } from "../src/extensions/builtin-commands/status.ts";
import type { ExtensionCommandContext } from "../src/index.ts";
import { initTheme } from "../src/index.ts";
import { renderWelcomeBox, renderWelcomeTip, WelcomeHeader } from "../src/modes/interactive/components/welcome-box.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

initTheme("dark");

function createStatusCtx(): ExtensionCommandContext {
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
	} as unknown as ExtensionCommandContext;
}

describe("welcome box", () => {
	it("renders π title, model/provider/thinking/directory rows, and keeps the tip", () => {
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
		expect(text).toContain("π nanopi v0.99.0");
		expect(text).toContain("model:");
		expect(text).toContain("gpt-test");
		expect(text).toContain("/model to change");
		expect(text).toContain("provider:");
		expect(text).toContain("thinking: high");
		expect(text).toContain("directory: ~");
		expect(stripAnsi(renderWelcomeTip())).toContain("/status");

		const header = new WelcomeHeader(() => ({
			version: "0.99.0",
			modelId: "gpt-test",
			provider: "openai",
			thinkingLevel: "high",
			showThinking: true,
			cwd: "~",
		}));
		expect(header.render(80).map(stripAnsi).join("\n")).toContain("π nanopi v0.99.0");
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
