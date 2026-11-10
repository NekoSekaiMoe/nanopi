import { afterEach, describe, expect, it } from "vitest";
import type { MarkdownTransformContext, MarkdownTransformer } from "../src/core/modules/types.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { createMarkdownTransform } from "../src/modes/interactive/components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const render = (component: { render(width: number): string[] }): string =>
	component
		.render(120)
		.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.join("\n");

/** A transformer that only touches the row kind it names, like a module would. */
function onlyFor(messageType: MarkdownTransformContext["messageType"], from: string, to: string): MarkdownTransformer {
	return (markdown, context) => (context.messageType === messageType ? markdown.replaceAll(from, to) : markdown);
}

describe("Markdown transformers on the rows they grew into", () => {
	afterEach(() => {
		initTheme();
	});

	it("runs a transformer over a custom message body", () => {
		initTheme();
		const component = new CustomMessageComponent(
			{
				role: "custom",
				customType: "note",
				content: "REWRITE-ME",
				display: true,
				timestamp: Date.now(),
			},
			undefined,
			undefined,
			1,
		);
		component.setMarkdownTransformers([onlyFor("custom", "REWRITE-ME", "custom row rewritten")]);

		expect(render(component)).toContain("custom row rewritten");
	});

	it("runs a transformer over a compaction summary", () => {
		initTheme();
		const component = new CompactionSummaryMessageComponent(
			{ role: "compactionSummary", summary: "REWRITE-ME", tokensBefore: 1234, timestamp: Date.now() },
			undefined,
			1,
			[onlyFor("summary", "REWRITE-ME", "summary row rewritten")],
		);
		component.setExpanded(true);

		expect(render(component)).toContain("summary row rewritten");
	});

	it("runs a transformer over a branch summary", () => {
		initTheme();
		const component = new BranchSummaryMessageComponent(
			{ role: "branchSummary", summary: "REWRITE-ME", fromId: "entry", timestamp: Date.now() },
			undefined,
			1,
			[onlyFor("summary", "REWRITE-ME", "branch row rewritten")],
		);
		component.setExpanded(true);

		expect(render(component)).toContain("branch row rewritten");
	});

	it("passes the row kind and leaves other rows to the next transformer", () => {
		const seen: MarkdownTransformContext["messageType"][] = [];
		const transform = createMarkdownTransform("changelog", false, [
			(markdown, context) => {
				seen.push(context.messageType);
				return onlyFor("custom", "REWRITE-ME", "never")(markdown, context);
			},
		]);

		expect(transform("REWRITE-ME", 80)).toBe("REWRITE-ME");
		expect(seen).toEqual(["changelog"]);
	});

	it("keeps the Mermaid transformer out of custom and summary rows", () => {
		const transformer = createMermaidMarkdownTransformer({
			getMode: () => "streaming",
			messageTypes: ["user", "assistant"],
		});
		const diagram = "```mermaid\nflowchart LR\n  A --> B\n```";
		const context = { isStreaming: false, availableWidth: 100 } as const;

		expect(transformer(diagram, { ...context, messageType: "assistant" })).not.toBe(diagram);
		expect(transformer(diagram, { ...context, messageType: "summary" })).toBe(diagram);
		expect(transformer(diagram, { ...context, messageType: "custom" })).toBe(diagram);
	});
});
