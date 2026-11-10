import type { Component, MarkdownTheme, TuiMouseEvent } from "@nanopi/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 80;

function renderText(component: Component): string {
	return stripAnsi(component.render(WIDTH).join("\n"));
}

function clickRow(component: Component, marker: string): void {
	const lines = component.render(WIDTH);
	const row = lines.findIndex((line) => stripAnsi(line).includes(marker));
	expect(row).toBeGreaterThanOrEqual(0);
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: row,
		screenX: 2,
		screenY: row,
		width: WIDTH,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	expect(component.handleMouse?.(event)?.handled).toBe(true);
}

describe("collapsible message components", () => {
	beforeAll(() => initTheme());

	test("toggles a compaction summary when clicked", () => {
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "compaction details",
			tokensBefore: 1234,
			timestamp: Date.now(),
		});

		expect(renderText(component)).not.toContain("compaction details");
		clickRow(component, "[compaction]");
		expect(renderText(component)).toContain("compaction details");
		clickRow(component, "[compaction]");
		expect(renderText(component)).not.toContain("compaction details");
	});

	test("toggles a branch summary when clicked", () => {
		const component = new BranchSummaryMessageComponent({
			role: "branchSummary",
			summary: "branch details",
			fromId: "entry-1",
			timestamp: Date.now(),
		});

		expect(renderText(component)).not.toContain("branch details");
		clickRow(component, "[branch]");
		expect(renderText(component)).toContain("branch details");
		clickRow(component, "[branch]");
		expect(renderText(component)).not.toContain("branch details");
	});

	test("toggles a skill invocation when clicked", () => {
		const component = new SkillInvocationMessageComponent({
			name: "example-skill",
			location: "/tmp/example-skill.md",
			content: "skill details",
			userMessage: undefined,
		});

		expect(renderText(component)).not.toContain("skill details");
		clickRow(component, "read skill");
		expect(renderText(component)).toContain("skill details");
		clickRow(component, "read skill");
		expect(renderText(component)).not.toContain("skill details");
	});
});

/** A theme whose every style call marks the text, so a row says which theme drew it. */
function markedTheme(marker: string): MarkdownTheme {
	const mark = (text: string) => `${marker}${text}${marker}`;
	return {
		heading: mark,
		link: mark,
		linkUrl: mark,
		code: mark,
		codeBlock: mark,
		codeBlockBorder: mark,
		quote: mark,
		quoteBorder: mark,
		hr: mark,
		listBullet: mark,
		bold: mark,
		italic: mark,
		strikethrough: mark,
		underline: mark,
	};
}

describe("message bodies keep their component and follow the theme", () => {
	beforeAll(() => initTheme());

	test("an expanded skill invocation reuses its body across rebuilds", () => {
		const component = new SkillInvocationMessageComponent(
			{ name: "example-skill", location: "/tmp/example-skill.md", content: "skill details", userMessage: undefined },
			markedTheme("«t»"),
			1,
		);
		component.setExpanded(true);
		const lines = component.render(WIDTH);
		component.setExpanded(false);
		component.setExpanded(true);

		// Collapsing drops the body; expanding again has to bring back the same
		// rows, without the component holding on to the collapsed-state tree.
		const again = component.render(WIDTH);
		expect(again).toEqual(lines);
		expect(stripAnsi(again.join("\n"))).toContain("skill details");
	});

	test("a branch summary redraws its expanded body with a new theme", () => {
		const component = new BranchSummaryMessageComponent(
			{ role: "branchSummary", summary: "branch details", fromId: "entry-1", timestamp: Date.now() },
			markedTheme("«old»"),
			1,
		);
		component.setExpanded(true);
		expect(renderText(component)).toContain("«old»Branch Summary");

		component.setMarkdownTheme(markedTheme("«new»"));

		const rendered = renderText(component);
		expect(rendered).toContain("«new»Branch Summary");
		expect(rendered).not.toContain("«old»");
	});

	test("a compaction summary redraws its expanded body with a new theme", () => {
		const component = new CompactionSummaryMessageComponent(
			{ role: "compactionSummary", summary: "compaction details", tokensBefore: 1234, timestamp: Date.now() },
			markedTheme("«old»"),
			1,
		);
		component.setExpanded(true);
		expect(renderText(component)).toContain("«old»Compacted from 1,234 tokens");

		component.setMarkdownTheme(markedTheme("«new»"));

		const rendered = renderText(component);
		expect(rendered).toContain("«new»Compacted from 1,234 tokens");
		expect(rendered).not.toContain("«old»");
	});
});
