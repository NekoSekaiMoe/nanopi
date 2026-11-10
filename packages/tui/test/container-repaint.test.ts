import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component } from "../src/component.ts";
import { Box } from "../src/components/box.ts";
import { Container } from "../src/tui.ts";

/**
 * A component whose drawn line depends on a field, so a rebuild of the tree it
 * sits in is visible in the output.
 */
class Stateful implements Component {
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	invalidate(): void {}
	render(): string[] {
		return [this.text];
	}
}

/** A container that rebuilds its children to repaint, the way the message components do. */
class Rebuilding extends Container {
	readonly built: Stateful[] = [];
	private readonly seed: string;

	constructor(seed: string) {
		super();
		this.seed = seed;
		this.repaintChildren();
	}
	override repaintChildren(): void {
		this.clear();
		const child = new Stateful(`${this.seed} ${this.built.length}`);
		this.built.push(child);
		this.addChild(child);
	}
}

describe("Container repaint", () => {
	it("forwards invalidate to the children instead of rebuilding them", () => {
		const child = new Stateful("child");
		let invalidations = 0;
		child.invalidate = () => invalidations++;
		const container = new Container();
		container.addChild(child);

		container.invalidate();

		assert.strictEqual(invalidations, 1);
		assert.deepStrictEqual(container.children, [child]);
	});

	it("lets a subclass rebuild its subtree to repaint", () => {
		const container = new Rebuilding("row");
		assert.deepStrictEqual(container.render(10), ["row 0"]);

		container.invalidate();

		assert.strictEqual(container.built.length, 2, "the rebuild is what re-reads the theme");
		assert.deepStrictEqual(container.render(10), ["row 1"]);
	});

	it("defers a rebuild that lands while a render is in flight", () => {
		// A render can invalidate the tree it is drawing: a grammar that finishes
		// loading calls back into the renderer, an async diff lands mid-frame.
		// Rebuilding then would swap in a child the frame never drew, so the
		// rebuild waits until the frame is done.
		class Rebuilding extends Container {
			rebuilds = 0;
			override repaintChildren(): void {
				this.rebuilds++;
				this.clear();
				this.addChild(new Invalidating(this));
			}
		}

		class Invalidating implements Component {
			private readonly owner: Rebuilding;
			constructor(owner: Rebuilding) {
				this.owner = owner;
			}
			invalidate(): void {}
			render(): string[] {
				this.owner.invalidate();
				return [`built ${this.owner.rebuilds}`];
			}
		}

		const container = new Rebuilding();
		container.addChild(new Invalidating(container));

		assert.deepStrictEqual(container.render(10), ["built 0"], "the frame keeps the children it started with");
		assert.strictEqual(container.rebuilds, 1, "the deferred rebuild runs once the frame is done");
		assert.deepStrictEqual(container.render(10), ["built 1"], "the next frame draws the rebuilt tree");
	});

	it("repaints a Box subtree the same way", () => {
		class BoxedRebuild extends Box {
			built = 0;
			override repaintChildren(): void {
				this.built++;
				this.clear();
				this.addChild(new Stateful(`boxed ${this.built}`));
			}
		}

		const box = new BoxedRebuild(0, 0);
		box.addChild(new Stateful("ignored"));
		box.invalidate();
		box.invalidate();

		assert.strictEqual(box.built, 2);
		assert.deepStrictEqual(box.render(10), ["boxed 2".padEnd(10)]);
	});
});
