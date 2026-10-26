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
import { fetchModelListing, type ListedModel } from "./model-listing.ts";

/** Re-ask the endpoint at most this often, so a restart does not cost a request per provider. */
const LIVE_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Join a listing id onto the provider's baseline models. A listed id that the
 * snapshot already knows keeps its cost/context/thinking metadata; the endpoint
 * only contributes membership. A listed id the snapshot misses gets the
 * baseline's shape, which is how a newly shipped model becomes usable.
 */
export function modelsFromListing(baseline: readonly AnyModel[], listing: readonly ListedModel[]): AnyModel[] {
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

function apiKeyFromCredential(credential: Credential | undefined): string | undefined {
	return credential?.type === "api_key" ? credential.key : undefined;
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

	let listing: ListedModel[] | undefined;
	try {
		listing = await fetchModelListing({
			baseUrl: context.baseUrl ?? provider.baseUrl ?? "",
			// The provider's own headers, not a separate protocol flag: a models.json
			// `anthropic-version` header is what marks a gateway as Anthropic-shaped.
			headers: provider.headers,
			apiKey: apiKeyFromCredential(context.credential),
			signal: context.signal,
		});
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
