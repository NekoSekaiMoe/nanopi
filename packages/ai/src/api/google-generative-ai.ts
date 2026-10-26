import { GoogleGenAI, type HttpOptions } from "@google/genai";
import type { Model, ProviderHeaders, SimpleStreamOptions } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getNanoPiUserAgent } from "../utils/nanopi-user-agent.ts";
import {
	createGoogleStream,
	type GoogleSharedStreamOptions,
	type GoogleStreamFunction,
} from "./google-shared-stream.ts";

export type GoogleOptions = GoogleSharedStreamOptions;

const shared = createGoogleStream("google-generative-ai", {
	adapterName: "Google Generative AI",
	assertCredentials,
	createClient: (model, _context, options) => createClient(model, requireApiKey(model, options), options?.headers),
});

/** Typed with the adapter's own option shape; the shared binder returns a generic signature. */
export const stream: GoogleStreamFunction<"google-generative-ai", GoogleOptions> = shared.stream;
export const streamSimple: GoogleStreamFunction<"google-generative-ai", SimpleStreamOptions> = shared.streamSimple;

function requireApiKey(model: Model<"google-generative-ai">, options?: GoogleOptions): string {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}
	return apiKey;
}

function assertCredentials(model: Model<"google-generative-ai">, options?: GoogleOptions): void {
	requireApiKey(model, options);
}

function createClient(
	model: Model<"google-generative-ai">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	const httpOptions: HttpOptions = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	const headers = providerHeadersToRecord({ "User-Agent": getNanoPiUserAgent(), ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}
