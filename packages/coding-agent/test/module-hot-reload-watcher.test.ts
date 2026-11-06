import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODULE_WATCH_DEBOUNCE_MS, ModuleHotReloadWatcher } from "../src/core/modules/hot-reload.ts";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ModuleHotReloadWatcher", () => {
	let root: string;
	let watcher: ModuleHotReloadWatcher | undefined;

	beforeEach(() => {
		root = join(tmpdir(), `nanopi-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "extensions"), { recursive: true });
	});

	afterEach(() => {
		watcher?.close();
		watcher = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	it("coalesces a burst of writes into one change", async () => {
		let changes = 0;
		watcher = new ModuleHotReloadWatcher(() => {
			changes += 1;
		});
		watcher.start([join(root, "extensions")]);

		const file = join(root, "extensions", "one.ts");
		for (let index = 0; index < 5; index++) {
			writeFileSync(file, `export default {}; // ${index}`);
		}
		await settle(MODULE_WATCH_DEBOUNCE_MS * 6);

		expect(changes).toBe(1);
	});

	it("reports a deletion and an addition, not just a modification", async () => {
		let changes = 0;
		watcher = new ModuleHotReloadWatcher(() => {
			changes += 1;
		});
		const file = join(root, "extensions", "one.ts");
		writeFileSync(file, "export default {};");
		watcher.start([join(root, "extensions")]);

		rmSync(file);
		await settle(MODULE_WATCH_DEBOUNCE_MS * 6);
		const afterDelete = changes;
		writeFileSync(join(root, "extensions", "two.ts"), "export default {};");
		await settle(MODULE_WATCH_DEBOUNCE_MS * 6);

		expect(afterDelete).toBeGreaterThan(0);
		expect(changes).toBeGreaterThan(afterDelete);
	});

	it("watches the nearest ancestor when the directory does not exist yet", async () => {
		let changes = 0;
		watcher = new ModuleHotReloadWatcher(() => {
			changes += 1;
		});
		watcher.start([join(root, "extensions")]);
		const missing = join(root, "later");
		watcher.start([missing]);

		mkdirSync(missing, { recursive: true });
		await settle(MODULE_WATCH_DEBOUNCE_MS * 6);

		expect(changes).toBeGreaterThan(0);
	});

	it("stops reporting after close", async () => {
		let changes = 0;
		watcher = new ModuleHotReloadWatcher(() => {
			changes += 1;
		});
		watcher.start([join(root, "extensions")]);
		watcher.close();

		writeFileSync(join(root, "extensions", "one.ts"), "export default {};");
		await settle(MODULE_WATCH_DEBOUNCE_MS * 6);

		expect(changes).toBe(0);
	});
});
