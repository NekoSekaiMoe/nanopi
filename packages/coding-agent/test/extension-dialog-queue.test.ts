import { describe, expect, it } from "vitest";
import { createDialogQueue } from "../src/modes/interactive/extension-dialog-queue.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Ported from earendil-works/pi#11166: two extension dialogs shared the editor slot, so the
// second replaced the first and the first promise never settled.
describe("extension dialog queue", () => {
	it("opens the second dialog only after the first resolves", async () => {
		const enqueue = createDialogQueue();
		const events: string[] = [];
		let resolveFirst: (value: string) => void = () => {};

		const first = enqueue(
			() =>
				new Promise<string>((resolve) => {
					events.push("open 1");
					resolveFirst = resolve;
				}),
		);
		const second = enqueue(async () => {
			events.push("open 2");
			return "second";
		});

		await tick();
		expect(events).toEqual(["open 1"]);

		resolveFirst("first");
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");
		expect(events).toEqual(["open 1", "open 2"]);
	});

	it("opens the next dialog after a rejected one", async () => {
		const enqueue = createDialogQueue();
		const failed = enqueue(async () => {
			throw new Error("boom");
		});
		const next = enqueue(async () => "ok");

		await expect(failed).rejects.toThrow("boom");
		await expect(next).resolves.toBe("ok");
	});

	it("settles every queued dialog in order", async () => {
		const enqueue = createDialogQueue();
		const order: number[] = [];
		const dialogs = [1, 2, 3].map((value) =>
			enqueue(async () => {
				await tick();
				order.push(value);
				return value;
			}),
		);

		await expect(Promise.all(dialogs)).resolves.toEqual([1, 2, 3]);
		expect(order).toEqual([1, 2, 3]);
	});
});
