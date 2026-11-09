import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

// Legacy header (no version) makes `open` migrate the entries and rewrite the file.
const LEGACY_HEADER = { type: "session", id: "abc", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" };
const USER_MESSAGE = {
	type: "message",
	id: "00000001",
	parentId: null,
	timestamp: "2025-01-01T00:00:01Z",
	message: { role: "user", content: "hi", timestamp: 1 },
};

describe("session file rewrite", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "nanopi-session-rewrite-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function legacySessionFile(name: string): string {
		const file = join(tempDir, name);
		writeFileSync(file, `${JSON.stringify(LEGACY_HEADER)}\n${JSON.stringify(USER_MESSAGE)}\n`);
		return file;
	}

	it("replaces the file with a rename and leaves no temporary file behind", () => {
		const file = legacySessionFile("session.jsonl");
		const inodeBefore = statSync(file).ino;

		SessionManager.open(file, tempDir);

		// Migration ran, so the file was rewritten.
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]).version).toBe(3);
		expect(JSON.parse(lines[1]).parentId).toBeNull();
		// A rename installs a new file; writing in place would keep the inode.
		expect(statSync(file).ino).not.toBe(inodeBefore);
		expect(readdirSync(tempDir)).toEqual(["session.jsonl"]);
	});
});
