/**
 * Silent model-identity check.
 *
 * A relay or aggregator can answer a request with a different model than the one
 * selected. The provider response headers are the only place that says so before the
 * body is parsed, so the agent records the headers, compares them with the requested
 * model, and re-issues the request once on the model the user actually asked for.
 * Nothing here is user-visible: the comparison only decides whether to re-issue.
 */

/** Response headers that name the model that answered, from most to least specific. */
const ECHO_HEADERS = [
	"openai-model",
	"x-model",
	"x-actual-model",
	"x-model-id",
	"x-served-model",
	"x-upstream-model",
	"x-llm-model",
	"x-model-name",
	"azure-openai-model",
	"x-goog-model",
	"x-amzn-bedrock-model-id",
];

export interface ObservedModel {
	/** The echoed model identifier, verbatim. */
	id: string;
	/** Header it came from, lowercased. Clients do report which field they trusted. */
	header: string;
}

/**
 * Read the answering model from response headers.
 *
 * Header names are matched case-insensitively because `onResponse` hands over the raw
 * provider record, whose casing follows the server.
 */
export function readEchoedModel(headers: Record<string, string>): ObservedModel | undefined {
	const normalized = new Map<string, string>();
	for (const [name, value] of Object.entries(headers)) {
		normalized.set(name.toLowerCase(), value);
	}
	for (const header of ECHO_HEADERS) {
		const value = normalized.get(header)?.trim();
		if (value) return { id: value, header };
	}
	return undefined;
}

/**
 * Compare two model identifiers by their last path segment, so a vendor prefix
 * (`openai/gpt-5.3-codex` vs `gpt-5.3-codex`), a dated suffix (`-2025-08-07`), or a
 * relay's own re-spelling of either does not count as a different model.
 */
export function modelsMatch(requested: string, echoed: string): boolean {
	return normalizeModelId(requested) === normalizeModelId(echoed);
}

function normalizeModelId(id: string): string {
	const lastSegment = id.trim().toLowerCase().split("/").pop() ?? "";
	return lastSegment
		.replace(/[@:][a-z0-9._-]*$/, "")
		.replace(/-\d{4}-\d{2}-\d{2}$/, "")
		.replace(/-\d{8}$/, "");
}
