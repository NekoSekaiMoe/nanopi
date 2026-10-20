import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
	buildSessionProjection,
	type CompactionEntry,
	getEntriesAfterLatestCompaction,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

describe("compaction boundary insertion", () => {
	it("inserts the summary as the parent of the kept entry and keeps the leaf", () => {
		const session = SessionManager.inMemory();
		const a = session.appendMessage(userMsg("a"));
		const b = session.appendMessage(userMsg("b"));
		// Recorded before the summary is generated, e.g. a tool result during compaction.
		const c = session.appendMessage(userMsg("c"));

		const compactionId = session.appendCompaction("summary", b, 100);

		expect(session.getEntry(b)?.parentId).toBe(compactionId);
		expect(session.getEntry(compactionId)?.parentId).toBe(a);
		// The leaf does not move, so later appends continue from the previous leaf.
		expect(session.getLeafId()).toBe(c);
		expect(session.getBranch().map((entry) => entry.id)).toEqual([a, compactionId, b, c]);
		// Kept entries are strictly older than the summary, later ones are not.
		// `c` was recorded before the summary even though it sits after the kept boundary.
		expect(getEntriesAfterLatestCompaction(session.getBranch())).toEqual([]);
	});

	it("projects the summary before the entries it keeps", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("dropped"));
		const kept = session.appendMessage(userMsg("kept"));
		session.appendCompaction("summary", kept, 100);
		session.appendMessage(userMsg("after"));

		expect(buildSessionProjection(session.getEntries()).messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"user",
		]);
	});

	it("navigating back to a kept entry still projects the summary", () => {
		const session = SessionManager.inMemory();
		const dropped = session.appendMessage(userMsg("dropped"));
		const kept = session.appendMessage(userMsg("kept"));
		session.appendCompaction("summary", kept, 100);
		const after = session.appendMessage(userMsg("after"));

		expect(session.getBranch(kept).map((entry) => entry.id)).not.toContain(after);
		expect(session.getBranch(kept).some((entry) => entry.type === "compaction")).toBe(true);
		const messages = buildSessionProjection(session.getEntries(), kept).messages;
		expect(messages.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		expect(messages.some((message) => message.role === "user" && message.content === "dropped")).toBe(false);
		expect(session.getEntry(dropped)).toBeDefined();
	});

	it("appends at the leaf when nothing is kept", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("a"));
		const leaf = session.appendMessage(userMsg("b"));

		const compactionId = session.appendCompaction("summary", null, 100);

		expect(session.getEntry(compactionId)?.parentId).toBe(leaf);
		expect(session.getLeafId()).toBe(compactionId);
	});

	it("appends at the leaf when the kept entry is off the active branch", () => {
		const session = SessionManager.inMemory();
		const a = session.appendMessage(userMsg("a"));
		const offBranch = session.appendMessage(userMsg("off"));
		session.createBranchedSession(a);
		const onBranch = session.appendMessage(userMsg("on"));

		const compactionId = session.appendCompaction("summary", offBranch, 100);

		expect(session.getEntry(compactionId)?.parentId).toBe(onBranch);
	});

	it("restores the unchanged leaf when a persisted summary is reloaded", () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-compaction-boundary-"));
		try {
			const session = SessionManager.create(dir, dir);
			const a = session.appendMessage(userMsg("a"));
			const b = session.appendMessage(userMsg("b"));
			const c = session.appendMessage(userMsg("c"));
			const compactionId = session.appendCompaction("summary", b, 100);
			const file = session.getSessionFile();
			expect(file).toBeDefined();

			const lines = readFileSync(file!, "utf8").trim().split("\n");
			expect(lines.at(-1)).toContain(compactionId);

			const reloaded = SessionManager.open(file!, dir, dir);
			expect(reloaded.getLeafId()).toBe(c);
			expect((reloaded.getEntry(compactionId) as CompactionEntry).firstKeptEntryId).toBe(b);
			expect(reloaded.getBranch().map((entry) => entry.id)).toEqual([a, compactionId, b, c]);

			// New entries never predate the inserted summary.
			const d = reloaded.appendMessage(userMsg("d"));
			const compaction = reloaded.getEntry(compactionId)!;
			expect(Date.parse(reloaded.getEntry(d)!.timestamp)).toBeGreaterThanOrEqual(Date.parse(compaction.timestamp));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
