import type { ProviderHeaders, ProviderStreams, StreamOptions } from "../types.ts";

/** OpenCode's per-conversation routing header. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";
/** OpenCode's client flavor header. */
export const OPENCODE_CLIENT_HEADER = "x-opencode-client";

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	const expected = name.toLowerCase();
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}

/** The headers OpenCode needs, minus the ones the caller already set. */
function missingOpenCodeHeaders<TOptions extends StreamOptions>(options: TOptions | undefined): ProviderHeaders {
	const headers: ProviderHeaders = {};
	if (options?.sessionId && !hasHeader(options.headers, OPENCODE_SESSION_HEADER)) {
		headers[OPENCODE_SESSION_HEADER] = options.sessionId;
	}
	if (!hasHeader(options?.headers, OPENCODE_CLIENT_HEADER)) headers[OPENCODE_CLIENT_HEADER] = "nanopi";
	return headers;
}

/** Adds OpenCode's required routing headers before API dispatch. */
export function withOpenCodeSessionHeader(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) => {
			const headers = missingOpenCodeHeaders(options);
			const decorated =
				Object.keys(headers).length === 0 ? options : { ...options, headers: { ...options?.headers, ...headers } };
			return streams.stream(model, context, decorated);
		},
		streamSimple: (model, context, options) => {
			const headers = missingOpenCodeHeaders(options);
			const decorated =
				Object.keys(headers).length === 0 ? options : { ...options, headers: { ...options?.headers, ...headers } };
			return streams.streamSimple(model, context, decorated);
		},
	};
}
