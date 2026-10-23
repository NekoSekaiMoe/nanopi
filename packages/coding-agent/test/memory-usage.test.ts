import { strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createFileLogger,
	DEFAULT_DEBUG_INTERVAL_MS,
	formatDebugHeader,
	formatMemorySample,
	formatMiB,
	isDebugEnabled,
	type MemorySample,
	MemorySampler,
	resolveDebugIntervalMs,
	resolveDebugLogPath,
	sampleMemory,
} from "../src/core/memory-usage.ts";
import { formatMemoryRow } from "../src/modules/builtin-commands/status.ts";

const MiB = 1024 * 1024;

function sample(overrides: Partial<MemorySample> = {}): MemorySample {
	return {
		rss: 140 * MiB,
		rssPeak: 148 * MiB,
		heapUsed: 12 * MiB,
		heapTotal: 34 * MiB,
		external: 8 * MiB,
		arrayBuffers: 1 * MiB,
		at: 0,
		...overrides,
	};
}

describe("debug flag", () => {
	it("accepts 1/true/yes and nothing else", () => {
		strictEqual(isDebugEnabled({ NANOPI_DEBUG: "1" }), true);
		strictEqual(isDebugEnabled({ NANOPI_DEBUG: "TRUE" }), true);
		strictEqual(isDebugEnabled({ NANOPI_DEBUG: "yes" }), true);
		strictEqual(isDebugEnabled({ NANOPI_DEBUG: "0" }), false);
		strictEqual(isDebugEnabled({}), false);
	});

	it("ignores the old memory-only flag", () => {
		strictEqual(isDebugEnabled({ NANOPI_MEM_DEBUG: "1" }), false);
	});

	it("falls back to the default interval for missing or absurd values", () => {
		strictEqual(resolveDebugIntervalMs({}), DEFAULT_DEBUG_INTERVAL_MS);
		strictEqual(resolveDebugIntervalMs({ NANOPI_DEBUG_INTERVAL_MS: "50" }), DEFAULT_DEBUG_INTERVAL_MS);
		strictEqual(resolveDebugIntervalMs({ NANOPI_DEBUG_INTERVAL_MS: "nope" }), DEFAULT_DEBUG_INTERVAL_MS);
		strictEqual(resolveDebugIntervalMs({ NANOPI_DEBUG_INTERVAL_MS: "250" }), 250);
	});

	it("points the log at nanopi-debug.log in the requested directory", () => {
		strictEqual(resolveDebugLogPath("/tmp/x"), "/tmp/x/nanopi-debug.log");
		strictEqual(resolveDebugLogPath(), join(process.cwd(), "nanopi-debug.log"));
	});

	it("labels the header with version, pid and cwd", () => {
		strictEqual(
			formatDebugHeader({ version: "v20261022.abc1234", pid: 42, cwd: "/repo" }),
			"debug start version v20261022.abc1234 pid 42 cwd /repo",
		);
	});
});

describe("file logger", () => {
	it("appends one timestamped line per sample", () => {
		const directory = mkdtempSync(join(tmpdir(), "nanopi-debug-"));
		try {
			const path = join(directory, "logs", "nanopi-debug.log");
			const log = createFileLogger(path);
			log("mem rss 1MiB");
			log("mem rss 2MiB");
			const lines = readFileSync(path, "utf8").trimEnd().split("\n");
			strictEqual(lines.length, 2);
			expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\] mem rss 1MiB$/);
			expect(lines[1]).toContain("mem rss 2MiB");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("formatting", () => {
	it("keeps one decimal below 1 MiB and rounds above", () => {
		strictEqual(formatMiB(MiB * 1.44), "1MiB");
		strictEqual(formatMiB(MiB * 0.44), "0.4MiB");
		strictEqual(formatMiB(140.4 * MiB), "140MiB");
	});

	it("renders a one-line sample with peak and external memory apart", () => {
		strictEqual(formatMemorySample(sample()), "mem rss 140MiB peak 148MiB heap 12MiB/34MiB ext 8MiB ab 1MiB");
	});

	it("summarises the /status row and drops an empty external figure", () => {
		strictEqual(formatMemoryRow(sample()), "rss 140MiB, peak 148MiB, heap 12MiB, external 8MiB");
		strictEqual(formatMemoryRow(sample({ external: 0 })), "rss 140MiB, peak 148MiB, heap 12MiB");
	});

	it("samples on demand when the mode keeps no sample", () => {
		const row = formatMemoryRow();
		expect(row).toMatch(/^rss .*MiB, peak .*MiB, heap .*MiB/);
	});
});

describe("MemorySampler", () => {
	it("does not start a timer when the flag is off", () => {
		const samples: string[] = [];
		const sampler = new MemorySampler({ env: {}, log: (line) => samples.push(line) });
		const stop = sampler.start();
		expect(sampler.enabled).toBe(false);
		stop();
		expect(samples).toEqual([]);
	});

	it("samples immediately even when the flag is off", () => {
		const sampler = new MemorySampler({ env: {}, log: () => {} });
		const first = sampler.sample();
		expect(first.rss).toBeGreaterThan(0);
		strictEqual(sampler.last, first);
	});

	it("logs periodic samples when enabled and stops on request", async () => {
		const samples: string[] = [];
		const sampler = new MemorySampler({
			env: { NANOPI_DEBUG: "1", NANOPI_DEBUG_INTERVAL_MS: "100" },
			log: (line) => samples.push(line),
		});
		const stop = sampler.start();
		expect(sampler.enabled).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 260));
		stop();
		expect(samples.length).toBeGreaterThanOrEqual(2);
		expect(samples[0]).toContain("rss ");
		const after = samples.length;
		await new Promise((resolve) => setTimeout(resolve, 200));
		strictEqual(samples.length, after);
	});
});

describe("sampleMemory", () => {
	it("reports rss and a peak at least as large as the current rss", () => {
		const current = sampleMemory();
		expect(current.rss).toBeGreaterThan(0);
		expect(current.heapTotal).toBeGreaterThan(0);
		if (current.rssPeak > 0) expect(current.rssPeak).toBeGreaterThanOrEqual(current.rss);
	});
});
