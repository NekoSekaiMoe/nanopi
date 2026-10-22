/**
 * RSS sampling for measuring what nanopi actually costs at runtime.
 *
 * `process.memoryUsage()` is cheap, but the interesting numbers are the peaks
 * (`rss` high-water mark, heap growth after a turn) and those are only visible
 * when someone samples continuously. Sampling is therefore opt-in:
 *
 *   NANOPI_MEM_DEBUG=1   sample every NANOPI_MEM_INTERVAL_MS (default 5000)
 *
 * The last sample is always stored so `/status` can show it, even with
 * sampling off.
 */

export interface MemorySample {
	/** Resident set size: the number the OS (and every memory complaint) reports. */
	rss: number;
	/** Peak RSS since process start. Only available where `process.resourceUsage()` reports it. */
	rssPeak: number;
	heapUsed: number;
	heapTotal: number;
	external: number;
	arrayBuffers: number;
	/** Monotonic timestamp of the sample (`performance.now()`). */
	at: number;
}

export const MEM_DEBUG_ENV = "NANOPI_MEM_DEBUG";
export const MEM_INTERVAL_ENV = "NANOPI_MEM_INTERVAL_MS";
export const DEFAULT_MEM_INTERVAL_MS = 5_000;

export function isMemoryDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[MEM_DEBUG_ENV];
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function resolveMemoryIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env[MEM_INTERVAL_ENV] ?? "", 10);
	return Number.isFinite(parsed) && parsed >= 100 ? parsed : DEFAULT_MEM_INTERVAL_MS;
}

/**
 * Peak RSS in bytes. Linux reports `maxRSS` in KiB, macOS and the BSDs in
 * bytes; there is no flag for which, so the platform decides the unit.
 */
function readRssPeak(): number {
	if (typeof process.resourceUsage !== "function") return 0;
	const maxRSS = process.resourceUsage().maxRSS;
	if (!Number.isFinite(maxRSS) || maxRSS <= 0) return 0;
	return process.platform === "linux" ? maxRSS * 1024 : maxRSS;
}

export function sampleMemory(): MemorySample {
	const usage = process.memoryUsage();
	return {
		rss: usage.rss,
		rssPeak: readRssPeak(),
		heapUsed: usage.heapUsed,
		heapTotal: usage.heapTotal,
		external: usage.external,
		arrayBuffers: usage.arrayBuffers,
		at: performance.now(),
	};
}

export type MemoryLog = (line: string) => void;

/**
 * Samples memory on an interval while enabled. `start()` returns a stop
 * function; repeated `start()` calls re-use the running timer.
 */
export class MemorySampler {
	private timer: NodeJS.Timeout | undefined;
	private lastSample: MemorySample | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly log: MemoryLog;

	constructor(options?: { env?: NodeJS.ProcessEnv; log?: MemoryLog }) {
		this.env = options?.env ?? process.env;
		this.log = options?.log ?? ((line) => process.stderr.write(`${line}\n`));
	}

	get enabled(): boolean {
		return isMemoryDebugEnabled(this.env);
	}

	get last(): MemorySample | undefined {
		return this.lastSample;
	}

	/** Sample now and remember it; returns the fresh sample. */
	sample(): MemorySample {
		this.lastSample = sampleMemory();
		return this.lastSample;
	}

	/** Start periodic sampling when NANOPI_MEM_DEBUG is on. No-op otherwise. */
	start(): () => void {
		if (!this.enabled) return () => {};
		if (this.timer) return () => this.stop();
		const interval = resolveMemoryIntervalMs(this.env);
		this.timer = setInterval(() => {
			const sample = this.sample();
			this.log(formatMemorySample(sample, "mem"));
		}, interval);
		this.timer.unref?.();
		return () => this.stop();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}

/** Compact MiB formatter: sub-MiB values keep one decimal, larger ones round. */
export function formatMiB(bytes: number): string {
	const mib = bytes / (1024 * 1024);
	if (mib < 1) return `${mib.toFixed(1)}MiB`;
	return `${Math.round(mib)}MiB`;
}

/** One-line sample: `mem rss 141MiB peak 141MiB heap 12MiB/34MiB ext 8MiB ab 1MiB`. */
export function formatMemorySample(sample: MemorySample, label = "mem"): string {
	const parts = [
		`${label} rss ${formatMiB(sample.rss)}`,
		`peak ${formatMiB(sample.rssPeak)}`,
		`heap ${formatMiB(sample.heapUsed)}/${formatMiB(sample.heapTotal)}`,
		`ext ${formatMiB(sample.external)}`,
		`ab ${formatMiB(sample.arrayBuffers)}`,
	];
	return parts.join(" ");
}
