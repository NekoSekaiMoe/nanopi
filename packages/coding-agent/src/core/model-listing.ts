/**
 * Read a model list off an endpoint. Both the settings page ("从接口拉取模型"),
 * which asks about an account before saving it, and the built-in catalog
 * refresh, which asks providers the packaged models.dev snapshot cannot keep up
 * with, need the same request. Keeping one copy means the two never disagree
 * about which path lists models or which header carries the key.
 */

/** One `/models` request may not stall a refresh or a settings form longer than this. */
const MODEL_LISTING_TIMEOUT_MS = 10_000;
/** Endpoints that would hand back thousands of rows; a provider filter is the user's job. */
const MAX_LISTED_MODELS = 500;

export interface ListedModel {
	id: string;
	name?: string;
}

export interface ModelListingRequest {
	baseUrl: string;
	/** The endpoint's protocol: `anthropic` lists behind `x-api-key`, everything else behind a bearer token. */
	type?: string;
	apiKey?: string;
	/** Provider headers pass through verbatim; a `null` value drops that header. */
	headers?: Record<string, string | null>;
	signal?: AbortSignal;
}

/**
 * `data[].id` (OpenAI-compatible) or `models[].id`/`models[].name` (Google-style).
 * Display names are read from the several spellings gateways use.
 */
export function parseModelListing(value: unknown): ListedModel[] {
	if (typeof value !== "object" || value === null) return [];
	const record = value as { data?: unknown; models?: unknown };
	const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
	if (!rows) return [];
	const seen = new Set<string>();
	const models: ListedModel[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const entry = row as { id?: unknown; name?: unknown; display_name?: unknown; displayName?: unknown };
		const id = [entry.id, entry.name, entry.display_name, entry.displayName].find(
			(candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
		);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const display = typeof entry.display_name === "string" ? entry.display_name : undefined;
		models.push({ id, name: display ?? (typeof entry.displayName === "string" ? entry.displayName : undefined) });
		if (models.length >= MAX_LISTED_MODELS) break;
	}
	return models;
}

/**
 * The URLs to try for `baseUrl`, in order: the base itself, then its `/v1`
 * sibling. A gateway's models.json entry may be written either way — the chat
 * request appends `/chat/completions` to whatever baseUrl says, so
 * `https://gw.example` and `https://gw.example/v1` both work there — while its
 * listing lives at one of them. Anthropic-compatible endpoints list under
 * `/v1/models` by convention, so that probe goes first.
 */
export function modelListingUrls(baseUrl: string, type?: string): string[] {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!base) return [];
	const versioned = /\/v\d+$/.test(base) ? base : `${base}/v1`;
	const urls = type === "anthropic" ? [versioned, base] : [base, versioned];
	return urls.map((url) => `${url}/models`);
}

function listingHeaders(request: ModelListingRequest): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json" };
	// Provider-mandated headers, e.g. an API version or account routing, pass through.
	for (const [name, value] of Object.entries(request.headers ?? {})) {
		if (typeof value === "string") headers[name] = value;
	}
	const key = request.apiKey?.trim();
	if (!key) return headers;
	const anthropic = request.type === "anthropic" || request.headers?.["anthropic-version"] !== undefined;
	if (anthropic) headers["x-api-key"] = key;
	else headers.Authorization = `Bearer ${key}`;
	if (anthropic && headers["anthropic-version"] === undefined) headers["anthropic-version"] = "2023-06-01";
	return headers;
}

/**
 * List the models an endpoint serves, or `undefined` when none of the candidate
 * URLs answered. A non-2xx answer on the first candidate is retried on the next,
 * because "wrong path" and "bad key" both come back as an error status; if every
 * candidate rejects, the first rejection is what surfaces.
 */
export async function fetchModelListing(request: ModelListingRequest): Promise<ListedModel[] | undefined> {
	const urls = modelListingUrls(request.baseUrl, request.type);
	if (urls.length === 0) return undefined;
	const headers = listingHeaders(request);
	const signal = request.signal
		? AbortSignal.any([request.signal, AbortSignal.timeout(MODEL_LISTING_TIMEOUT_MS)])
		: AbortSignal.timeout(MODEL_LISTING_TIMEOUT_MS);
	let firstError: unknown;
	for (const url of urls) {
		let response: Response;
		try {
			response = await fetch(url, { headers, signal });
		} catch (error) {
			// A timeout or an aborted caller ends the search: the endpoint is not answering.
			if (request.signal?.aborted || (error instanceof Error && error.name === "TimeoutError")) throw error;
			firstError ??= new ModelListingError(`could not reach ${url}: ${errorMessage(error)}`);
			continue;
		}
		if (!response.ok) {
			firstError ??= new ModelListingError(`${url} answered ${response.status}`);
			continue;
		}
		return parseModelListing(await response.json());
	}
	if (firstError) throw firstError;
	return undefined;
}

/** A listing failure the settings page can show verbatim. */
export class ModelListingError extends Error {}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
