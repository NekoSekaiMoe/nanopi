/**
 * Point a built-in provider's catalog at the endpoint's own `/models` listing.
 *
 * The packaged catalog is a models.dev snapshot taken when nanopi was built, so
 * it ages: a model the endpoint added is missing, and a model it retired stays
 * listed until a request fails. This wrapper asks the endpoint what it actually
 * serves and stores the answer as the provider's dynamic overlay, the same slot
 * `withRemoteCatalog` publishes into. The snapshot stays the fallback: no
 * credential, no network, or a rejecting endpoint all leave the packaged list in
 * place, and the overlay only replaces it once something answered.
 */

import {
	type AnyModel,
	type Credential,
	isModelType,
	type ModelsStoreEntry,
	type Provider,
	type RefreshModelsContext,
} from "@nanopi/pi-ai";

/** One `/models` request may not stall a refresh for longer than this. */
const LIVE_CATALOG_TIMEOUT_MS = 10_000;
/** Endpoints that would hand back thousands of rows; a provider filter is the user's job. */
const MAX_LIVE_MODELS = 500;
/** Re-ask the endpoint at most this often, so a restart does not cost a request per provider. */
const LIVE_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface LiveModel {
	id: string;
	name?: string;
}

/** `data[].id` (OpenAI-compatible) or `models[].id`/`models[].name` (Google-style). */
export function parseModelListing(value: unknown): LiveModel[] {
	if (typeof value !== "object" || value === null) return [];
	const record = value as { data?: unknown; models?: unknown };
	const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : undefined;
	if (!rows) return [];
	const seen = new Set<string>();
	const models: LiveModel[] = [];
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
		if (models.length >= MAX_LIVE_MODELS) break;
	}
	return models;
}

/**
 * Join a listing id onto the provider's baseline models. A listed id that the
 * snapshot already knows keeps its cost/context/thinking metadata; the endpoint
 * only contributes membership. A listed id the snapshot misses gets the
 * baseline's shape, which is how a newly shipped model becomes usable.
 */
export function modelsFromListing(baseline: readonly AnyModel[], listing: readonly LiveModel[]): AnyModel[] {
	const template = baseline.find((model) => isModelType(model, "chat")) ?? baseline[0];
	if (!template) return [];
	const literal: Record<string, unknown> = { ...template };
	delete literal.type;
	return listing.map((entry) => {
		const known = baseline.find((model) => model.id === entry.id);
		const model = { ...(known ?? literal), id: entry.id, provider: template.provider } as AnyModel;
		if (entry.name) model.name = entry.name;
		return model;
	});
}

function apiKeyFromCredential(credential: Credential | undefined): string | undefined {
	return credential?.type === "api_key" ? credential.key : undefined;
}

function listingHeaders(provider: Provider, credential: Credential | undefined): Record<string, string> {
	const headers: Record<string, string> = { accept: "application/json" };
	// Keep any provider-mandated headers, e.g. API version or account routing.
	for (const [name, value] of Object.entries(provider.headers ?? {})) {
		if (typeof value === "string") headers[name] = value;
	}
	const key = apiKeyFromCredential(credential);
	if (!key) return headers;
	// Anthropic lists models behind x-api-key; everyone else behind a bearer token.
	if (provider.headers?.["anthropic-version"] !== undefined) headers["x-api-key"] = key;
	else headers.Authorization = `Bearer ${key}`;
	return headers;
}

function listingUrl(provider: Provider, baseUrl: string | undefined): string | undefined {
	const base = (baseUrl ?? provider.baseUrl)?.trim().replace(/\/+$/, "");
	if (!base) return undefined;
	return `${base}/models`;
}

async function fetchListing(
	provider: Provider,
	baseUrl: string | undefined,
	credential: Credential | undefined,
	signal: AbortSignal,
): Promise<LiveModel[] | undefined> {
	const url = listingUrl(provider, baseUrl);
	if (!url) return undefined;
	const response = await fetch(url, {
		headers: listingHeaders(provider, credential),
		signal: AbortSignal.any([signal, AbortSignal.timeout(LIVE_CATALOG_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`${url} answered ${response.status}`);
	return parseModelListing(await response.json());
}

/**
 * Wrap `provider` so its network refresh asks `{baseUrl}/models`. `baseline`
 * supplies the model shape (api, cost, context window) for ids the listing
 * introduces; provider metadata such as `filterModels` passes through unchanged,
 * so account-scoped narrowing still runs on top of the live list.
 */
export function withLiveCatalog(provider: Provider): Provider {
	let liveModels: readonly AnyModel[] = [];

	return {
		...provider,
		// A `/models` listing is chat-only, so the overlay replaces the chat rows and
		// leaves image and classifier models to the packaged catalog.
		getModels: () =>
			liveModels.length > 0 ? liveModels.filter((model) => isModelType(model, "chat")) : provider.getModels(),
		getAllModels: () => {
			const base = provider.getAllModels?.() ?? provider.getModels();
			if (liveModels.length === 0) return base;
			return [...liveModels, ...base.filter((model) => !isModelType(model, "chat"))];
		},
		refreshModels: (context: RefreshModelsContext) =>
			refreshWithLiveCatalog(provider, context, (models) => {
				liveModels = models;
			}),
	};
}

async function refreshWithLiveCatalog(
	provider: Provider,
	context: RefreshModelsContext,
	setLiveModels: (models: readonly AnyModel[]) => void,
): Promise<void> {
	const refresh = provider.refreshModels;
	if (refresh) await refresh(context);

	const stored: Readonly<ModelsStoreEntry> | undefined = context.stored;
	const restored = stored?.models.filter((model) => model.provider === provider.id) ?? [];
	await context.publish({
		update: () => {
			setLiveModels(restored);
		},
	});
	if (!context.allowNetwork || context.signal.aborted) return;
	if (
		!context.force &&
		stored?.checkedAt !== undefined &&
		Date.now() - stored.checkedAt < LIVE_CATALOG_REFRESH_INTERVAL_MS
	) {
		return;
	}

	let listing: LiveModel[] | undefined;
	try {
		listing = await fetchListing(provider, context.baseUrl, context.credential, context.signal);
	} catch {
		// Snapshot and any restored overlay stay; a later refresh retries.
		return;
	}
	if (!listing || listing.length === 0 || context.signal.aborted) return;

	const baseline = provider.getAllModels?.() ?? provider.getModels();
	const live = modelsFromListing(baseline, listing);
	if (live.length === 0) return;
	await context.publish({
		// Not persisted: the endpoint is the source of truth and answers again next start,
		// so a cached copy would only go stale in a second place.
		update: () => {
			setLiveModels(live);
		},
	});
}
