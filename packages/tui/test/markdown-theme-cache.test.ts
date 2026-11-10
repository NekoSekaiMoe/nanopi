import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";

/** A theme whose every style call wraps the text in a marker instead of ANSI. */
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

describe("Markdown render cache and the theme", () => {
	it("re-renders rows that a previous theme produced", () => {
		const component = new Markdown("# title", 0, 0, markedTheme("«old»"));
		const before = component.render(40);
		assert.ok(before.some((line) => line.includes("«old»")));

		component.setTheme(markedTheme("«new»"));
		const after = component.render(40);

		assert.ok(after.some((line) => line.includes("«new»")));
		assert.ok(!after.some((line) => line.includes("«old»")));
	});

	it("keeps the cached rows while the theme object stays the same", () => {
		const theme = markedTheme("«t»");
		const component = new Markdown("hello", 0, 0, theme);
		const first = component.render(20);

		assert.strictEqual(component.render(20), first);
		component.setTheme(theme);
		assert.strictEqual(component.render(20), first);
	});
});
