import { visibleWidth } from "@nanopi/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import {
	FooterComponent,
	formatCwdForFooter,
	resolveFooterUsedTokens,
} from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	contextUsage?: { tokens: number | null; percent: number | null; contextWindow: number };
	usage?: AssistantUsage;
}): AgentSession {
	const entries: Array<Record<string, unknown>> = [];
	if (options.usage !== undefined) {
		entries.push({
			type: "message",
			message: { role: "assistant", usage: options.usage },
		});
	}
	const session = {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => options.contextUsage ?? { tokens: null, percent: 12.3, contextWindow: 200_000 },
		routedModel: undefined,
		modelRuntime: { isUsingSubscription: () => false },
	};
	return session as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("resolveFooterUsedTokens", () => {
	it("prefers reported tokens, then percent, then totals", () => {
		expect(
			resolveFooterUsedTokens(
				{ tokens: 900, percent: 50, contextWindow: 10_000 },
				{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
				10_000,
			),
		).toBe(900);
		expect(
			resolveFooterUsedTokens(
				{ tokens: null, percent: 50, contextWindow: 10_000 },
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				10_000,
			),
		).toBe(5_000);
		expect(
			resolveFooterUsedTokens(
				{ tokens: null, percent: null, contextWindow: 10_000 },
				{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
				10_000,
			),
		).toBe(15);
		expect(
			resolveFooterUsedTokens(
				{ tokens: null, percent: null, contextWindow: 10_000 },
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				10_000,
			),
		).toBe(null);
	});
});

describe("FooterComponent single-line layout", () => {
	beforeAll(() => {
		initTheme();
	});

	it("renders one dim line with used tokens and the details hint", () => {
		const footer = new FooterComponent(createSession({}), createFooterData());
		const lines = footer.render(120);
		expect(lines).toHaveLength(1);
		const text = stripAnsi(lines[0]!);
		expect(text).toContain("used ");
		expect(text).toContain("/ for more details");
		expect(text).not.toContain("100% context left");
		expect(text).not.toContain("? for shortcuts");
	});

	it("derives used from percent when tokens are unknown", () => {
		const footer = new FooterComponent(createSession({}), createFooterData());
		const text = stripAnsi(footer.render(120)[0]!);
		// 12.3% of 200k = 24.6k -> "25k" in compact formatting.
		expect(text).toContain("used 25k/200k");
	});

	it("shows ? when usage is fully unknown", () => {
		const footer = new FooterComponent(
			createSession({ contextUsage: { tokens: null, percent: null, contextWindow: 200_000 } }),
			createFooterData(),
		);
		expect(stripAnsi(footer.render(120)[0]!)).toContain("used ?/200k");
	});

	it("keeps the line within width", () => {
		const footer = new FooterComponent(createSession({}), createFooterData());
		for (const width of [20, 40, 60]) {
			for (const line of footer.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("updates used tokens after an entry is appended", () => {
		const usage = { input: 10_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
		const session = createSession({
			contextUsage: { tokens: null, percent: null, contextWindow: 200_000 },
			usage,
		});
		const footer = new FooterComponent(session, createFooterData());
		expect(stripAnsi(footer.render(120)[0]!)).toContain("used 10k/200k");

		session.sessionManager.getEntries().push({ type: "message", message: { role: "assistant", usage } } as never);
		expect(stripAnsi(footer.render(120)[0]!)).toContain("used 20k/200k");
	});

	it("right-aligns the yellow shell label in shell mode", () => {
		const footer = new FooterComponent(createSession({}), createFooterData());
		footer.setShellMode(true);

		const line = footer.render(60)[0]!;

		expect(stripAnsi(line).endsWith("shell")).toBe(true);
		expect(visibleWidth(line)).toBe(60);
		// The label keeps its own bashMode (yellow) color instead of the dim footer gray.
		expect(line).not.toBe(theme.fg("dim", stripAnsi(line)));
	});

	it("keeps the shell label within narrow widths", () => {
		const footer = new FooterComponent(createSession({}), createFooterData());
		footer.setShellMode(true);
		for (const width of [10, 20, 40]) {
			for (const line of footer.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("hides the shell label when shell mode is off", () => {
		const footer = new FooterComponent(createSession({}), createFooterData());
		expect(stripAnsi(footer.render(120)[0]!)).not.toContain("shell");
	});
});
