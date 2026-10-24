/**
 * The engine chain: key rotation inside an engine, failover across engines.
 *
 * One call walks the chain in config order. For each engine it tries the keys
 * in order; auth, rate-limit, and quota failures move to the next key, while
 * any other failure (5xx, timeout, bad request) says nothing about the key and
 * moves straight to the next engine. The first engine that answers ends the
 * walk, and the outcome reports every attempt before it, so a silent downgrade
 * to another engine cannot happen.
 *
 * A cooldown cache remembers keys that reported an exhausted quota, so the next
 * call starts with the healthy ones and reaches the spent ones last. It is a
 * cache, not a state machine: losing it costs one wasted call.
 */

import fs from "node:fs";
import { dirname, join } from "node:path";
import {
	configDeadlineMs,
	configTimeoutMs,
	engineChain,
	engineKeyValue,
	type EngineName,
	type WebsearchConfig,
} from "./config.ts";
import {
	EngineChainError,
	type EngineContext,
	enginesForRole,
	type FetchOutcome,
	type FetchedPage,
	KeyFailureError,
	type SearchAttempt,
	type SearchItem,
	type SearchOutcome,
	isKeyless,
	runFetchOn,
	runSearchOn,
	splitKeys,
} from "./engines.ts";

/** A rate limit or spent plan lifts within the hour; a monthly budget does not. */
export const DEFAULT_COOLDOWN_MS = 45 * 60 * 1000;
export const MONTHLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

interface CooldownEntry {
	until: number;
	reason: string;
}

type CooldownState = Record<string, CooldownEntry>;

/** Cooldown cache path inside the host's agent dir; see `ctx.getAgentDir()`. */
export function getCooldownPath(agentDir: string): string {
	return join(agentDir, "websearch-state.json");
}

function cooldownKey(engine: EngineName, keyIndex: number | undefined): string {
	return keyIndex === undefined ? engine : `${engine}::key${keyIndex}`;
}

function readCooldowns(path: string): CooldownState {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf-8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const state: CooldownState = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const record = value as Record<string, unknown>;
			if (typeof record.until === "number" && record.until > Date.now()) {
				state[key] = { until: record.until, reason: typeof record.reason === "string" ? record.reason : "" };
			}
		}
		return state;
	} catch {
		return {};
	}
}

function writeCooldowns(path: string, state: CooldownState): void {
	try {
		fs.mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		fs.renameSync(temp, path);
	} catch {
		// A cache that cannot be written is not worth failing a search over.
	}
}

export interface SearchOptions {
	limit?: number;
	config?: WebsearchConfig;
	/** Agent dir the cooldown cache is written under; omitted disables the cache. */
	agentDir?: string;
	cooldownPath?: string;
	signal?: AbortSignal;
}

export const DEFAULT_LIMIT = 8;
/** Ask the engine for more than requested, so dedupe still fills the caller's limit. */
const OUTBOUND_LIMIT_FACTOR = 2;
export const MAX_LIMIT = 20;

/** Keys to try for one engine, in order. Keyless engines get a single null key. */
function keysFor(config: WebsearchConfig, engine: EngineName): Array<string | null> {
	const keys = splitKeys(engineKeyValue(config, engine));
	if (keys.length > 0) return keys;
	return isKeyless(engine) ? [null] : [];
}

/**
 * Order the chain so a fully-cooling engine is tried last. Config order is
 * kept inside each group: the point is to avoid rediscovering a spent quota,
 * not to load-balance healthy engines.
 */
export function orderChain(chain: readonly EngineName[], cooldowns: CooldownState): EngineName[] {
	const cooling = (engine: EngineName): boolean =>
		cooldownKey(engine, undefined) in cooldowns ||
		Object.keys(cooldowns).some((key) => key.startsWith(`${engine}::key`));
	return [...chain.filter((engine) => !cooling(engine)), ...chain.filter((engine) => cooling(engine))];
}

interface WalkResult<T> {
	value: T;
	engine: EngineName;
	keyIndex?: number;
	attempts: SearchAttempt[];
}

/**
 * Walk the chain once. `use` runs one engine+key; it either returns a value or
 * throws, and the throw's class decides whether the key or the engine is done.
 */
async function walkChain<T>(
	role: "search" | "fetch",
	config: WebsearchConfig,
	signal: AbortSignal,
	cooldownPath: string | undefined,
	use: (engine: EngineName, key: string | null, context: EngineContext) => Promise<T>,
): Promise<WalkResult<T>> {
	const deadline = Date.now() + configDeadlineMs(config);
	const perAttempt = configTimeoutMs(config);
	// No agent dir means no cache: a call that only had a key and a URL still runs.
	const cooldowns = cooldownPath ? readCooldowns(cooldownPath) : {};

	const chain = enginesForRole(engineChain(config), role);
	if (chain.length === 0) {
		throw new Error(
			`No engine in websearch.json can ${role} pages. Enabled engines: ${engineChain(config).join(", ") || "none"}.`,
		);
	}

	const attempts: SearchAttempt[] = [];
	for (const engine of orderChain(chain, cooldowns)) {
		const keys = keysFor(config, engine);
		if (keys.length === 0) {
			attempts.push({ engine, ok: false, error: "no API key configured" });
			continue;
		}
		for (const [index, key] of keys.entries()) {
			if (Date.now() >= deadline) break;
			const keyIndex = keys.length > 1 ? index + 1 : undefined;
			const timeoutMs = Math.max(1_000, Math.min(perAttempt, deadline - Date.now()));
			const context: EngineContext = { config, signal, timeoutMs };
			try {
				const value = await use(engine, key, context);
				attempts.push({ engine, keyIndex, ok: true });
				return { value, engine, keyIndex, attempts };
			} catch (error) {
				if (signal.aborted) throw new Error(`${role} cancelled`);
				const message = error instanceof Error ? error.message : String(error);
				attempts.push({ engine, keyIndex, ok: false, error: message });
				if (!(error instanceof KeyFailureError)) break;
				if (error.exhausted) {
					cooldowns[cooldownKey(engine, keyIndex)] = {
						until: Date.now() + (/month|credit|quota|payment/i.test(message) ? MONTHLY_COOLDOWN_MS : DEFAULT_COOLDOWN_MS),
						reason: message.slice(0, 200),
					};
					if (cooldownPath) writeCooldowns(cooldownPath, cooldowns);
				}
			}
		}
	}
	throw new EngineChainError(describeFailure(attempts), attempts);
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

export async function runSearch(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
	const trimmed = query.trim();
	if (trimmed === "") throw new Error("web_search needs a non-empty query");
	const config = options.config ?? {};
	const limit = clampLimit(options.limit);
	const signal = options.signal ?? new AbortController().signal;
	const cooldownPath = options.cooldownPath ?? (options.agentDir ? getCooldownPath(options.agentDir) : undefined);
	const walked = await walkChain("search", config, signal, cooldownPath, (engine, key, context) =>
		runSearchOn(engine, trimmed, limit * OUTBOUND_LIMIT_FACTOR, key, context),
	);
	return {
		items: dedupeItems(walked.value.items),
		...(walked.value.answer ? { answer: walked.value.answer } : {}),
		engine: walked.engine,
		keyIndex: walked.keyIndex,
		attempts: walked.attempts,
	};
}

export async function runFetch(url: string, options: SearchOptions = {}): Promise<FetchOutcome> {
	const target = url.trim();
	if (!/^https?:\/\//i.test(target)) throw new Error("read_page needs an http(s) url");
	const config = options.config ?? {};
	const signal = options.signal ?? new AbortController().signal;
	const cooldownPath = options.cooldownPath ?? (options.agentDir ? getCooldownPath(options.agentDir) : undefined);
	const walked = await walkChain("fetch", config, signal, cooldownPath, (engine, key, context) =>
		runFetchOn(engine, target, key, context),
	);
	const page: FetchedPage = walked.value;
	return {
		url: target,
		engine: walked.engine,
		keyIndex: walked.keyIndex,
		attempts: walked.attempts,
		...page,
	};
}

/**
 * Drop repeated URLs, keeping the first occurrence. Engine screens can surface
 * the same page twice with different `?utm_` tails, and a reader that gets the
 * same link two or three times loses distinct evidence per result slot.
 */
export function dedupeItems(items: readonly SearchItem[]): SearchItem[] {
	const seen = new Set<string>();
	const kept: SearchItem[] = [];
	for (const item of items) {
		const key = canonicalUrl(item.url);
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(item);
	}
	return kept;
}

/** Lowercase host, path without a trailing slash, and no tracking or fragment. */
function canonicalUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const params = [...parsed.searchParams]
			.filter(([name]) => !/^(utm_|ref|fbclid|gclid$)/i.test(name))
			.sort(([a], [b]) => a.localeCompare(b));
		const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
		const path = parsed.pathname.replace(/\/+$/, "");
		return `${parsed.host.toLowerCase()}${path}${query}`;
	} catch {
		return url.trim();
	}
}

function describeFailure(attempts: SearchAttempt[]): string {
	if (attempts.length === 0) return "Ran out of time before any engine was tried";
	const lines = attempts.map((attempt) => {
		const key = attempt.keyIndex === undefined ? "" : ` key #${attempt.keyIndex}`;
		return `${attempt.engine}${key}: ${attempt.ok ? "ok" : (attempt.error ?? "failed")}`;
	});
	return `No engine answered. Tried: ${lines.join("; ")}`;
}
