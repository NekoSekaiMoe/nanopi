import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";

function countingText(text: string, paddingX = 0, paddingY = 0) {
	const component = new Text(text, paddingX, paddingY);
	let renders = 0;
	const render = component.render.bind(component);
	component.render = (width: number) => {
		renders++;
		return render(width);
	};
	return { component, renders: () => renders };
}

const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

describe("Text render cache", () => {
	it("re-renders the same text after invalidate()", () => {
		const component = new Text("hello", 0, 0);
		const first = component.render(20);
		assert.strictEqual(component.render(20), first);

		component.invalidate();
		const second = component.render(20);
		assert.deepStrictEqual(second, first);
		assert.notStrictEqual(second, first);
	});

	it("keeps the wrapped lines when setText() receives the same string", () => {
		const { component, renders } = countingText(long);

		const first = component.render(30);
		assert.strictEqual(renders(), 1);

		component.setText(long);
		assert.strictEqual(component.render(30), first);
		assert.strictEqual(renders(), 2);

		component.setText(`${long}\nline 40`);
		const grown = component.render(30);
		assert.notStrictEqual(grown, first);
		assert.strictEqual(grown.length, first.length + 1);
	});

	it("renders again after invalidate() when the text was set ahead of the render", () => {
		const { component, renders } = countingText("hello");
		component.setText("goodbye");
		const first = component.render(20);
		assert.deepStrictEqual(
			first.map((line) => line.trim()),
			["goodbye"],
		);
		assert.strictEqual(renders(), 1);

		component.invalidate();
		assert.deepStrictEqual(component.render(20), first);
		assert.strictEqual(renders(), 2);
	});

	it("keeps the wrapped lines across invalidate() calls", () => {
		const { component, renders } = countingText(long);
		assert.strictEqual(component.render(30).length, 40);
		component.invalidate();
		// The text is unchanged, so the second pass re-renders the same lines: no state was
		// carried over to make them stale.
		assert.strictEqual(component.render(30).length, 40);
		assert.strictEqual(renders(), 2);
	});

	it("still drops the wrapped lines when only the width changes", () => {
		const component = new Text("a b c", 0, 0);
		const wide = component.render(20);
		const narrow = component.render(5);
		assert.notDeepStrictEqual(wide, narrow);
		assert.strictEqual(component.render(5), narrow);
	});
});
