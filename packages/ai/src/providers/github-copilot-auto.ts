/**
 * Copilot Auto model-selection protocol.
 *
 * Copilot Free and Student plans only offer Auto model selection: the account's
 * model picker no longer allows direct model choice, and direct chat requests to
 * normally selectable models fail with `400 model_not_supported`. Auto clients
 * open a model session, ask the Copilot router which model fits the prompt, and
 * send the chat request for the chosen model with that session's token.
 *
 * Verified against the VS Code Copilot client behavior and `POST /models/session`
 * / `POST /models/session/intent` responses (`DomainService.capiAutoModelURL` and
 * `capiModelRouterURL` in @vscode/copilot-api). The router response is advisory:
 * VS Code gives it a short timeout and falls back to the session's pool.
 */

import type { FetchFunction, ProviderHeaders } from "../types.ts";

/** Identity headers every Copilot CAPI request carries; mirror the OAuth flow's client identity. */
const COPILOT_IDENTITY_HEADERS: ProviderHeaders = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

const COPILOT_API_VERSION = "2026-06-01";

/** An open Copilot Auto model session. */
export interface CopilotAutoSession {
	/** Sent as `Copilot-Session-Token` on chat requests routed through Auto. */
	sessionToken: string;
	/** Epoch milliseconds when the session expires. */
	expiresAt: number;
	/** Model ids Copilot reports usable under this session. */
	availableModelIds: string[];
	/** The server's own initial selection, when it reports one. */
	selectedModelId?: string;
}

/** The Copilot router's advisory decision for one prompt. */
export interface CopilotAutoRouterDecision {
	chosenModelId?: string;
	/** Ordered fallbacks for the chosen model. */
	candidateModelIds: string[];
}

/** The prompt facts the router classifies. */
export interface CopilotAutoRouterRequest {
	prompt: string;
	availableModelIds: readonly string[];
	previousModelId?: string;
	turnNumber?: number;
	referenceCount?: number;
}

export interface CopilotAutoRequestOptions {
	fetch?: FetchFunction;
	signal?: AbortSignal;
	/** Hard deadline for this control request. Session requests default to 15s, router requests to 1s. */
	timeoutMs?: number;
}

const DEFAULT_SESSION_TIMEOUT_MS = 15_000;
const DEFAULT_ROUTER_TIMEOUT_MS = 1_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const deadline = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function controlHeaders(apiKey: string, sessionToken?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"X-GitHub-Api-Version": COPILOT_API_VERSION,
	};
	for (const [name, value] of Object.entries(COPILOT_IDENTITY_HEADERS)) {
		if (value !== null) headers[name] = value;
	}
	if (sessionToken) headers["Copilot-Session-Token"] = sessionToken;
	return headers;
}

async function errorForResponse(response: Response, operation: string): Promise<Error> {
	const statusText = response.statusText ? ` ${response.statusText}` : "";
	const body = await response.text().catch(() => "");
	return new Error(`${operation} failed with HTTP ${response.status}${statusText}${body ? `: ${body}` : ""}`);
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

/** `selected_model` arrives either as a plain id or as an object with an `id` field. */
function parseSelectedModelId(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	const id = asRecord(value)?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Open or refresh a Copilot Auto model session (`POST /models/session`).
 * Rejects on HTTP errors, invalid payloads, and caller aborts.
 */
export async function fetchCopilotAutoSession(
	baseUrl: string,
	apiKey: string,
	options?: CopilotAutoRequestOptions,
): Promise<CopilotAutoSession> {
	const response = await (options?.fetch ?? globalThis.fetch)(`${normalizeBaseUrl(baseUrl)}/models/session`, {
		method: "POST",
		headers: controlHeaders(apiKey),
		body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
		signal: requestSignal(options?.signal, options?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS),
	});
	if (!response.ok) throw await errorForResponse(response, "Copilot Auto session request");

	const data = asRecord(await response.json().catch(() => undefined));
	const sessionToken = typeof data?.session_token === "string" ? data.session_token : undefined;
	if (!data || !sessionToken) {
		throw new Error("Copilot Auto returned an invalid session response");
	}
	const expiresAt =
		typeof data.expires_at === "number" && Number.isFinite(data.expires_at)
			? data.expires_at * 1000
			: Date.now() + 30 * 60_000;
	return {
		sessionToken,
		expiresAt,
		availableModelIds: stringArray(data.available_models),
		selectedModelId: parseSelectedModelId(data.selected_model),
	};
}

/**
 * Ask the Copilot router which model fits the prompt (`POST /models/session/intent`).
 * The decision is advisory: HTTP errors, invalid payloads, and timeouts resolve to
 * undefined so callers can fall back to the session pool. Caller aborts still reject.
 */
export async function fetchCopilotAutoRouterDecision(
	baseUrl: string,
	apiKey: string,
	sessionToken: string,
	request: CopilotAutoRouterRequest,
	options?: CopilotAutoRequestOptions,
): Promise<CopilotAutoRouterDecision | undefined> {
	let response: Response;
	try {
		response = await (options?.fetch ?? globalThis.fetch)(`${normalizeBaseUrl(baseUrl)}/models/session/intent`, {
			method: "POST",
			headers: controlHeaders(apiKey, sessionToken),
			body: JSON.stringify({
				prompt: request.prompt,
				available_models: request.availableModelIds,
				previous_model: request.previousModelId,
				turn_number: request.turnNumber,
				reference_count: request.referenceCount,
				prompt_char_count: request.prompt.length,
			}),
			signal: requestSignal(options?.signal, options?.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS),
		});
	} catch (error) {
		if (options?.signal?.aborted) throw error;
		return undefined;
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		return undefined;
	}
	const data = asRecord(await response.json().catch(() => undefined));
	if (!data) return undefined;
	const chosenModelId =
		typeof data.chosen_model === "string" && data.chosen_model.length > 0
			? data.chosen_model
			: parseSelectedModelId(data.selected_model);
	const candidateModelIds = stringArray(data.candidate_models);
	if (chosenModelId === undefined && candidateModelIds.length === 0) return undefined;
	return { chosenModelId, candidateModelIds };
}
