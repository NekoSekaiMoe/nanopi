import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageLedgerIndex } from "../src/core/usage-ledger.ts";
import { formatUsageLedgerRow } from "../src/modules/builtin-commands/status.ts";

const dirs: string[] = [];

function makeSessionsRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "nanopi-usage-ledger-"));
	dirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type UsageLines = { input: number; output: number; cacheRead?: number; cacheWrite?: number; total: number };

function assistantEntry(timestamp: number, usage: UsageLines, model = "claude-sonnet") {
	return {
		type: "message",
		id: `m-${timestamp}`,
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			provider: "anthropic",
			model,
			responseModel: model,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				totalTokens: usage.input + usage.output,
				cost: { input: usage.total, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.total },
			},
		},
	};
}

function writeSession(root: string, project: string, name: string, entries: unknown[]): string {
	const directory = join(root, project);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, name);
	const header = {
		type: "session",
		version: 3,
		id: name.replace(".jsonl", "").split("_").pop(),
		timestamp: new Date().toISOString(),
		cwd: "/repo",
	};
	writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

describe("UsageLedgerIndex", () => {
	it("sums usage across every project directory", async () => {
		const root = makeSessionsRoot();
		writeSession(root, "--repo--", "2026-11-01T00-00-00-000Z_a.jsonl", [
			assistantEntry(1, { input: 100, output: 20, cacheRead: 300, total: 0.5 }),
		]);
		writeSession(root, "--other--", "2026-11-02T00-00-00-000Z_b.jsonl", [
			assistantEntry(2, { input: 50, output: 10, total: 0.25 }),
		]);

		const index = new UsageLedgerIndex();
		await index.refresh(root);
		const ledger = index.totals();

		expect(ledger.files).toBe(2);
		expect(ledger.totals.input).toBe(150);
		expect(ledger.totals.output).toBe(30);
		expect(ledger.totals.cacheRead).toBe(300);
		expect(ledger.totals.cost).toBeCloseTo(0.75);
		expect(ledger.totals.responses).toBe(2);
		expect(ledger.totals.models).toBe(1);
		expect(ledger.totals.reportedCacheFiles).toBe(1);
	});

	it("re-parses only the files whose size or mtime moved", async () => {
		const root = makeSessionsRoot();
		const first = writeSession(root, "--repo--", "2026-11-01T00-00-00-000Z_a.jsonl", [
			assistantEntry(1, { input: 100, output: 20, total: 0.5 }),
		]);
		writeSession(root, "--repo--", "2026-11-02T00-00-00-000Z_b.jsonl", [
			assistantEntry(2, { input: 10, output: 5, total: 0.1 }),
		]);

		const index = new UsageLedgerIndex();
		await index.refresh(root);
		expect(index.totals().totals.input).toBe(110);

		// Appending grows mtime and size for exactly one file.
		const appended = `${JSON.stringify(assistantEntry(3, { input: 40, output: 4, total: 0.2 }))}\n`;
		writeFileSync(first, appended, { flag: "a" });

		await index.refresh(root);
		expect(index.totals().totals.input).toBe(150);
		expect(index.totals().totals.cost).toBeCloseTo(0.8);
	});

	it("drops files that disappeared", async () => {
		const root = makeSessionsRoot();
		const file = writeSession(root, "--repo--", "2026-11-01T00-00-00-000Z_a.jsonl", [
			assistantEntry(1, { input: 100, output: 20, total: 0.5 }),
		]);

		const index = new UsageLedgerIndex();
		await index.refresh(root);
		expect(index.totals().files).toBe(1);

		rmSync(file);
		await index.refresh(root);
		expect(index.totals().files).toBe(0);
		expect(index.totals().totals.input).toBe(0);
	});

	it("reports an empty ledger for a missing sessions directory", async () => {
		const index = new UsageLedgerIndex();
		await index.refresh(join(tmpdir(), "nanopi-usage-ledger-does-not-exist"));
		expect(index.totals()).toEqual({
			updatedAt: null,
			files: 0,
			totals: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				reportedCacheFiles: 0,
				models: 0,
				responses: 0,
			},
		});
	});
});

describe("formatUsageLedgerRow", () => {
	it("says indexing while the first pass is running", () => {
		expect(formatUsageLedgerRow(undefined)).toBe("indexing...");
	});

	it("renders tokens, cost, and the cache hit rate", () => {
		const row = formatUsageLedgerRow({
			updatedAt: null,
			files: 2,
			totals: {
				input: 900,
				output: 100,
				cacheRead: 1_000,
				cacheWrite: 0,
				cost: 1.5,
				reportedCacheFiles: 1,
				models: 2,
				responses: 4,
			},
		});
		expect(row).toBe("1.0k tokens, $1.50 over 2 sessions (4 responses), cache hit 52.6%");
	});

	it("distinguishes 'no provider reported cache' from 'cache always missed'", () => {
		const row = formatUsageLedgerRow({
			updatedAt: null,
			files: 1,
			totals: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.1,
				reportedCacheFiles: 0,
				models: 1,
				responses: 1,
			},
		});
		expect(row).toContain("cache not reported");
		expect(row).not.toContain("0.0%");
	});

	it("says so when there are no sessions", () => {
		expect(
			formatUsageLedgerRow({
				updatedAt: null,
				files: 0,
				totals: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					reportedCacheFiles: 0,
					models: 0,
					responses: 0,
				},
			}),
		).toBe("no sessions yet");
	});
});
