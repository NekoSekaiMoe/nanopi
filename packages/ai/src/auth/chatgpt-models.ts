/**
 * Sign in with ChatGPT account model catalog.
 *
 * The bundled catalog lists every model OpenAI publishes. A ChatGPT account only reaches part of
 * it: a Free plan gets none of the paid tiers. `GET /models` on the ChatGPT backend reports what the
 * signed-in account can actually use, so the picker filters to that list instead of offering models
 * that fail on the first turn.
 *
 * The lookup is advisory. An account without the endpoint, an offline run, or an unexpected payload
 * leaves the filtered catalog alone instead of hiding every model.
 */

const CHATGPT_MODELS_URL = "https://chatgpt.com/backend-api/models";
const CATALOG_TIMEOUT_MS = 10_000;

/** Deduplicated ids the signed-in account can use, or undefined when the backend did not answer usefully. */
export async function fetchChatGPTModelIds(accessToken: string, signal: AbortSignal): Promise<string[] | undefined> {
	let response: Response;
	try {
		response = await fetch(CHATGPT_MODELS_URL, {
			headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]),
		});
	} catch {
		return undefined;
	}
	if (!response.ok) {
		await response.body?.cancel();
		return undefined;
	}
	const payload: unknown = await response.json().catch(() => undefined);
	const entries = (payload as { models?: unknown } | undefined)?.models;
	if (!Array.isArray(entries)) return undefined;

	const ids = new Set<string>();
	for (const entry of entries) {
		const id = (entry as { id?: unknown } | undefined)?.id;
		if (typeof id === "string" && id.trim().length > 0) ids.add(id.trim());
	}
	// An empty list means the account exposes nothing, which is a valid answer once the payload
	// carried an array; a missing or malformed array returned undefined above.
	return [...ids];
}
