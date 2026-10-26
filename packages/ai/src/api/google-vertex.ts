import { GoogleGenAI, type HttpOptions, ResourceScope } from "@google/genai";
import type { Model, ProviderEnv, ProviderHeaders, SimpleStreamOptions } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getNanoPiUserAgent } from "../utils/nanopi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import {
	createGoogleStream,
	type GoogleSharedStreamOptions,
	type GoogleStreamFunction,
} from "./google-shared-stream.ts";

/** Vertex adds the project/location that Application Default Credentials need. */
export interface GoogleVertexOptions extends GoogleSharedStreamOptions {
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const shared = createGoogleStream("google-vertex", {
	adapterName: "Google Vertex",
	// Either a Vertex API key or ADC (project + location) is enough; the client below picks one.
	assertCredentials: () => {},
	createClient: (model, _context, options) => {
		const apiKey = resolveApiKey(options);
		// Create the client using either a Vertex API key, if provided, or ADC with project and location
		return apiKey
			? createClientWithApiKey(model, apiKey, options?.headers)
			: createClient(model, resolveProject(options), resolveLocation(options), options?.headers, options?.env);
	},
});

/** Typed with the adapter's own option shape; the shared binder returns a generic signature. */
export const stream: GoogleStreamFunction<"google-vertex", GoogleVertexOptions> = shared.stream;
export const streamSimple: GoogleStreamFunction<"google-vertex", SimpleStreamOptions> = shared.streamSimple;

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: ProviderHeaders,
	env?: ProviderEnv,
): GoogleGenAI {
	const googleAuthOptions = buildGoogleAuthOptions(env);
	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		...(googleAuthOptions ? { googleAuthOptions } : {}),
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function buildHttpOptions(model: Model<"google-vertex">, optionsHeaders?: ProviderHeaders): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (baseUrlIncludesApiVersion(baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}

	const headers = providerHeadersToRecord({ "User-Agent": getNanoPiUserAgent(), ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	return keyFilename ? { keyFilename } : undefined;
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env);
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env);
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}
