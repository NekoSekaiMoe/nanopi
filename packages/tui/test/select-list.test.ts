import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

/** PageUp/PageDown as the terminal sends them (xterm CSI 5~/6~). */
const PAGE_UP = "\u001b[5~";
const PAGE_DOWN = "\u001b[6~";

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});

	it("moves the selection by a window on PageUp/PageDown", () => {
		const items = Array.from({ length: 20 }, (_, index) => ({ value: `item-${index}`, label: `item-${index}` }));
		const list = new SelectList(items, 5, testTheme);

		list.handleInput(PAGE_DOWN);
		assert.equal(list.getSelectedItem()?.value, "item-5");

		list.handleInput(PAGE_DOWN);
		assert.equal(list.getSelectedItem()?.value, "item-10");

		list.handleInput(PAGE_UP);
		assert.equal(list.getSelectedItem()?.value, "item-5");
	});

	it("wraps PageUp/PageDown like the arrow keys do", () => {
		const items = Array.from({ length: 8 }, (_, index) => ({ value: `item-${index}`, label: `item-${index}` }));
		const list = new SelectList(items, 5, testTheme);

		list.handleInput(PAGE_UP);
		assert.equal(list.getSelectedItem()?.value, "item-3");

		list.handleInput(PAGE_DOWN);
		assert.equal(list.getSelectedItem()?.value, "item-0");
	});

	it("wraps the mouse wheel at the ends like the arrows do", () => {
		const items = Array.from({ length: 3 }, (_, index) => ({ value: `item-${index}`, label: `item-${index}` }));
		const list = new SelectList(items, 5, testTheme);
		list.setSelectedIndex(2);

		// One notch past the last row used to be a no-op while ↓ jumped back to the top.
		const result = list.handleMouse({
			type: "wheel",
			button: "none",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 20,
			height: 5,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 1,
		});
		assert.equal(result?.render, true);
		assert.equal(list.getSelectedItem()?.value, "item-0");
	});

	it("notifies selection changes from paging", () => {
		const items = Array.from({ length: 20 }, (_, index) => ({ value: `item-${index}`, label: `item-${index}` }));
		const list = new SelectList(items, 5, testTheme);
		const changes: string[] = [];
		list.onSelectionChange = (item) => changes.push(item.value);

		list.handleInput(PAGE_DOWN);

		assert.deepStrictEqual(changes, ["item-5"]);
	});
});
