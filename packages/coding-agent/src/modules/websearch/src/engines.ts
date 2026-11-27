/**
 * Engine adapters: four search APIs behind one shape.
 *
 * Two of them (Firecrawl, Keenable) answer without a key, which is why a fresh
 * install searches at all. The rest need one. Every adapter returns ranked
 * items and no written answer, so the summary a caller sees is mechanical and
 * the caller reads `items` for evidence.
 *
 * Key rotation lives in the request helper: one engine with N keys is tried N
 * times before the chain moves on, and only auth, rate-limit, and quota
 * failures burn a key. A 500 or a network error says nothing about the key, so
 * it fails over to the next engine instead of retrying the same wall.
 */

import type { EngineName, EngineRole, WebsearchConfig } from "./config.ts";

export interface SearchItem {
	title: string;
	url: string;
	snippet: string;
	source: string;
	publishedAt?: string;
}

export interface SearchAttempt {
	engine: EngineName;
	/** 1-based position of the key that answered or failed; absent for keyless and single-key calls. */
	keyIndex?: number;
	ok: boolean;
	error?: string;
}

export interface SearchOutcome {
	items: SearchItem[];
	/** The engine whose response produced `items`. */
	engine: EngineName;
	keyIndex?: number;
	/** Every engine+key that was tried before this one answered, failures included. */
	attempts: SearchAttempt[];
	/** Prose the provider returned when it ships one (Tavily's answer field). */
	answer?: string;
}

export interface FetchOutcome {
	url: string;
	title?: string;
	content: string;
	truncated: boolean;
	engine: EngineName;
	keyIndex?: number;
	attempts: SearchAttempt[];
}

export interface FetchedPage {
	title?: string;
	content: string;
	truncated: boolean;
}

/** Characters of page text one fetch may return; a longer page is cut, not dropped. */
export const MAX_CONTENT_CHARS = 60_000;

/** Split a comma-separated key setting into the keys to try, in order. */
export function splitKeys(value: string): string[] {
	return value
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key.length > 0);
}

/**
 * A failure tied to the key that was used: auth, rate limit, or quota. The
 * chain burns the key and moves to the next one. `exhausted` marks the quota
 * class, which also cools the key down so the next call skips it.
 */
export class KeyFailureError extends Error {
	readonly exhausted: boolean;
	constructor(message: string, exhausted = false) {
		super(message);
		this.name = "KeyFailureError";
		this.exhausted = exhausted;
	}
}

/** Every engine and key failed for one call. */
export class EngineChainError extends Error {
	readonly attempts: SearchAttempt[];
	constructor(message: string, attempts: SearchAttempt[]) {
		super(message);
		this.name = "EngineChainError";
		this.attempts = attempts;
	}
}

export interface EngineContext {
	config: WebsearchConfig;
	signal: AbortSignal;
	/** Budget for one attempt, already clamped to the run deadline. */
	timeoutMs: number;
	/** Base URLs per engine override via config; this resolves the effective one. */
}

const QUOTA_PATTERNS = [
	/\bquota\b/i,
	/\bpayment required\b/i,
	/\b(?:out of|insufficient|not enough)\s+(?:account\s+)?(?:balance|credits?)\b/i,
	/\b(?:balance|credits?)\s+(?:is\s+)?(?:insufficient|exhausted|depleted|empty|too low|used up)\b/i,
	/\b(?:credit|usage)\s+(?:limit|cap)\s+(?:reached|exceeded)\b/i,
];

/** Whether a provider's error text describes an exhausted quota rather than a bad request. */
export function isQuotaFailureMessage(text: string): boolean {
	return QUOTA_PATTERNS.some((pattern) => pattern.test(text));
}

function safeHostname(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

function joinEndpoint(base: string, path: string): string {
	return `${base.replace(/\/+$/, "")}${path}`;
}

/** One HTTP request whose body is read under the same deadline as its headers. */
async function requestJson(
	label: string,
	url: string,
	init: RequestInit,
	context: EngineContext,
): Promise<{ status: number; ok: boolean; text: string }> {
	const signal = AbortSignal.any([context.signal, AbortSignal.timeout(context.timeoutMs)]);
	let response: Response;
	try {
		response = await fetch(url, { ...init, signal });
	} catch (error) {
		// A thrown KeyFailureError is a deliberate signal from the caller's
		// layer; wrapping it would turn a spent key into a plain transport
		// error and hide the rotation decision.
		if (error instanceof KeyFailureError) throw error;
		if (context.signal.aborted) throw new Error(`${label} cancelled`);
		if (signal.aborted) throw new Error(`${label} timed out after ${context.timeoutMs} ms`);
		throw new Error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		if (!response.ok) return { status: response.status, ok: false, text: "" };
		throw new Error(`${label} response body failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { status: response.status, ok: response.ok, text };
}

/**
 * Turn a non-2xx response into an error the chain can classify. 402 and any
 * quota wording mean the key is spent; 401/403 a bad key; 429 a rate limit.
 * Everything else is the request's or the provider's problem, not the key's.
 */
function statusError(engine: EngineName, status: number, text: string): Error {
	const detail = text.trim().slice(0, 300);
	const message = `${engine} returned ${status}${detail ? `: ${detail}` : ""}`;
	if (status === 402 || isQuotaFailureMessage(detail)) return new KeyFailureError(message, true);
	if (status === 401 || status === 403 || status === 429) return new KeyFailureError(message);
	return new Error(message);
}

export interface AdapterResult {
	items: SearchItem[];
	answer?: string;
}

interface EngineAdapter {
	name: EngineName;
	roles: readonly EngineRole[];
	/** Without a key the engine still may answer, on a shared anonymous allowance. */
	keyless: boolean;
	search?: (query: string, limit: number, key: string | null, context: EngineContext) => Promise<AdapterResult>;
	fetch?: (url: string, key: string | null, context: EngineContext) => Promise<{ title?: string; content: string }>;
}

function firecrawlBase(config: WebsearchConfig): string {
	return config.firecrawl?.baseUrl ?? "https://api.firecrawl.dev";
}

const firecrawl: EngineAdapter = {
	name: "firecrawl",
	roles: ["search", "fetch"],
	keyless: true,
	async search(query, limit, key, context) {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (key) headers.authorization = `Bearer ${key}`;
		const response = await requestJson(
			"firecrawl",
			joinEndpoint(firecrawlBase(context.config), "/v2/search"),
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					query,
					limit,
					sources: ["web"],
					timeout: Math.min(Math.max(context.timeoutMs, 1_000), 300_000),
				}),
			},
			context,
		);
		if (!response.ok) throw statusError("firecrawl", response.status, response.text);
		const body = JSON.parse(response.text) as {
			success?: boolean;
			data?: { web?: Array<{ title?: string; description?: string; url?: string }> };
		};
		// Firecrawl reports failures inside a 200. Read `success !== true` as a
		// failure rather than as "no hits", which would look like an answer.
		if (body.success !== true) throw new Error("firecrawl reported success: false");
		return {
			items: (body.data?.web ?? []).map((entry) => ({
				title: entry.title ?? "",
				url: entry.url ?? "",
				snippet: entry.description ?? "",
				source: entry.url ? safeHostname(entry.url) : "",
			})),
		};
	},
	async fetch(url, key, context) {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (key) headers.authorization = `Bearer ${key}`;
		const response = await requestJson(
			"firecrawl",
			joinEndpoint(firecrawlBase(context.config), "/v2/scrape"),
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					url,
					formats: ["markdown"],
					onlyMainContent: true,
					maxAge: 0,
					storeInCache: false,
					skipTlsVerification: false,
					timeout: Math.min(Math.max(context.timeoutMs, 1_000), 300_000),
				}),
			},
			context,
		);
		if (!response.ok) throw statusError("firecrawl", response.status, response.text);
		const body = JSON.parse(response.text) as {
			success?: boolean;
			data?: { markdown?: string; metadata?: { title?: string; statusCode?: number } };
		};
		if (body.success !== true) throw new Error("firecrawl reported success: false");
		const status = body.data?.metadata?.statusCode;
		if (typeof status === "number" && (status < 200 || status >= 300)) {
			throw new Error(`firecrawl fetched ${url} but the page returned ${status}`);
		}
		return { title: body.data?.metadata?.title, content: body.data?.markdown ?? "" };
	},
};

function keenableBase(config: WebsearchConfig): string {
	return config.keenable?.baseUrl ?? "https://api.keenable.ai";
}

const keenable: EngineAdapter = {
	name: "keenable",
	roles: ["search"],
	keyless: true,
	async search(query, limit, key, context) {
		const headers: Record<string, string> = { "content-type": "application/json" };
		// Keyless calls carry the app name because Keenable caps anonymous
		// traffic per IP and attributes it to the caller that names itself.
		if (key) headers["x-api-key"] = key;
		else headers["x-keenable-title"] = "nanopi";
		const response = await requestJson(
			"keenable",
			joinEndpoint(keenableBase(context.config), key ? "/v1/search" : "/v1/search/public"),
			{
				method: "POST",
				headers,
				body: JSON.stringify({ query, max_results: Math.min(limit, 50) }),
			},
			context,
		);
		if (!response.ok) throw statusError("keenable", response.status, response.text);
		const body = JSON.parse(response.text) as {
			results?: Array<{ title?: string; url?: string; description?: string; snippet?: string; published_at?: string }>;
		};
		return {
			items: (body.results ?? []).map((entry) => ({
				title: entry.title ?? "",
				url: entry.url ?? "",
				snippet: entry.snippet ?? entry.description ?? "",
				source: entry.url ? safeHostname(entry.url) : "",
				...(entry.published_at ? { publishedAt: entry.published_at } : {}),
			})),
		};
	},
};

function tavilyBase(config: WebsearchConfig): string {
	return config.tavily?.baseUrl ?? "https://api.tavily.com";
}

const tavily: EngineAdapter = {
	name: "tavily",
	roles: ["search"],
	keyless: false,
	async search(query, limit, key, context) {
		if (!key) throw new KeyFailureError("tavily needs an API key: TAVILY_API_KEY or websearch.json tavily.apiKey");
		const response = await requestJson(
			"tavily",
			joinEndpoint(tavilyBase(context.config), "/search"),
			{
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
				body: JSON.stringify({ query, max_results: limit }),
			},
			context,
		);
		if (!response.ok) throw statusError("tavily", response.status, response.text);
		const body = JSON.parse(response.text) as {
			answer?: string;
			results?: Array<{ title?: string; url?: string; content?: string }>;
		};
		return {
			items: (body.results ?? []).map((entry) => ({
				title: entry.title ?? "",
				url: entry.url ?? "",
				snippet: entry.content ?? "",
				source: entry.url ? safeHostname(entry.url) : "",
			})),
			...(typeof body.answer === "string" && body.answer.trim() !== "" ? { answer: body.answer } : {}),
		};
	},
};

function exaBase(config: WebsearchConfig): string {
	return config.exa?.baseUrl ?? "https://api.exa.ai";
}

const exa: EngineAdapter = {
	name: "exa",
	roles: ["search"],
	keyless: false,
	async search(query, limit, key, context) {
		if (!key) throw new KeyFailureError("exa needs an API key: EXA_API_KEY or websearch.json exa.apiKey");
		const response = await requestJson(
			"exa",
			joinEndpoint(exaBase(context.config), "/search"),
			{
				method: "POST",
				headers: { "content-type": "application/json", "x-api-key": key },
				body: JSON.stringify({ query, numResults: limit, highlights: { numSentences: 2 } }),
			},
			context,
		);
		if (!response.ok) throw statusError("exa", response.status, response.text);
		const body = JSON.parse(response.text) as {
			results?: Array<{ title?: string; url?: string; publishedDate?: string; highlights?: string[] }>;
		};
		return {
			items: (body.results ?? []).map((entry) => ({
				title: entry.title ?? "",
				url: entry.url ?? "",
				snippet: (entry.highlights ?? []).join(" ").trim(),
				source: entry.url ? safeHostname(entry.url) : "",
				...(entry.publishedDate ? { publishedAt: entry.publishedDate } : {}),
			})),
		};
	},
};

const ADAPTERS: Record<EngineName, EngineAdapter> = { firecrawl, keenable, tavily, exa };

/** Engines that can serve a role, in config order, minus the switched-off ones. */
export function enginesForRole(chain: readonly EngineName[], role: EngineRole): EngineName[] {
	return chain.filter((name) => (ADAPTERS[name]?.roles ?? []).includes(role));
}

export function supportsRole(name: EngineName, role: EngineRole): boolean {
	return (ADAPTERS[name]?.roles ?? []).includes(role);
}

export function isKeyless(name: EngineName): boolean {
	return ADAPTERS[name].keyless;
}

/** Run one engine for a search. Throws KeyFailureError for key-scoped failures. */
export async function runSearchOn(
	engine: EngineName,
	query: string,
	limit: number,
	key: string | null,
	context: EngineContext,
): Promise<AdapterResult> {
	const adapter = ADAPTERS[engine];
	if (!adapter?.search) throw new Error(`The ${engine} engine cannot search`);
	return adapter.search(query, limit, key, context);
}

/** Run one engine for a page fetch, cutting the content at MAX_CONTENT_CHARS. */
export async function runFetchOn(
	engine: EngineName,
	url: string,
	key: string | null,
	context: EngineContext,
): Promise<FetchedPage> {
	const adapter = ADAPTERS[engine];
	if (!adapter?.fetch) throw new Error(`The ${engine} engine cannot fetch pages`);
	const page = await adapter.fetch(url, key, context);
	const truncated = page.content.length > MAX_CONTENT_CHARS;
	return {
		title: page.title,
		content: truncated ? page.content.slice(0, MAX_CONTENT_CHARS) : page.content,
		truncated,
	};
}
