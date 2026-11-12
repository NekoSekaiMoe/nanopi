import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * A `.jsonl` file that is not a session ends the read loop on its first line, while the stream is
 * still open. Aborting the listing afterwards used to destroy that stream with nobody listening for
 * `'error'`, and the uncaught `AbortError` killed the process.
 */
describe("SessionManager listing with non-session files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-listing-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("survives an abort after a non-session file ended the read early", async () => {
		const notASession = join(tempDir, "notes.jsonl");
		writeFileSync(notASession, `${"not a session header ".repeat(64 * 1024)}\ntrailing line\n`);

		const controller = new AbortController();
		const sessions = await SessionManager.list(tempDir, tempDir, undefined, controller.signal);
		expect(sessions).toEqual([]);

		// The rejected listing is already settled; the stream it left behind must not emit later.
		controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	it("still rejects a listing cancelled through the signal", async () => {
		writeFileSync(join(tempDir, "notes.jsonl"), "not a session header\n");

		const controller = new AbortController();
		controller.abort();

		await expect(SessionManager.list(tempDir, tempDir, undefined, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
