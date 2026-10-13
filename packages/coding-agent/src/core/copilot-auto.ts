/**
 * Built-in `github-copilot/auto` virtual model.
 *
 * Copilot Free and Student accounts force Auto model selection: their model
 * picker catalog no longer offers specific models, and chat requests naming one
 * directly fail with `400 model_not_supported`. The Auto flow instead opens a
 * Copilot model session, asks Copilot's router which model fits the prompt, and
 * sends the chat request for that model with the session's token.
 *
 * Routing follows the virtual-model contract: the selection stays
 * `github-copilot/auto`, every request routes to a physical catalog model, and
 * responses record that model, so usage, cost, and compaction limits match the
 * model that actually answered. The session token rides along per request
 * through `ModelRoute.headers`.
 *
 * The route is sticky: one conversation keeps the model Auto first chose while
 * it stays in the session pool, because a mid-conversation switch discards the
 * prompt cache and provider continuity (thinking signatures, tool history).
 * Only a first selection, an invalidated selection, or a failed request
 * re-consults the router.
 */
import type { Api, AuthResult, Message, Model, ProviderHeaders } from "@nanopi/pi-ai";
import { hasCopilotVisionInput } from "@nanopi/pi-ai/api/github-copilot-headers";
import {
	type CopilotAutoSession,
	fetchCopilotAutoRouterDecision,
	fetchCopilotAutoSession,
} from "@nanopi/pi-ai/providers/github-copilot-auto";
import { isVirtualModel, type ModelRouteRequest, type VirtualModelDefinition } from "./virtual-models.ts";

/** Provider id of the built-in GitHub Copilot provider. */
export const COPILOT_AUTO_PROVIDER_ID = "github-copilot";
/** Model id of the Auto virtual model. */
export const COPILOT_AUTO_MODEL_ID = "auto";

/** Header carrying the Auto session token on routed chat requests. */
const COPILOT_SESSION_TOKEN_HEADER = "Copilot-Session-Token";

/** Refresh a session this long before it expires. */
const SESSION_REFRESH_MARGIN_MS = 5 * 60_000;

/** Access tokens rotate roughly every 30 minutes; a few cached sessions cover concurrent credentials. */
const SESSION_CACHE_MAX_ENTRIES = 8;

const DEFAULT_COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";

/** Router state persisted on the session branch: the model Auto last selected. */
export interface CopilotAutoState {
	modelId?: string;
}

/** The ModelRuntime surface the router needs. */
interface CopilotAutoHost {
	getAuth(providerId: string, overrides?: { signal?: AbortSignal }): Promise<AuthResult | undefined>;
	getModel(provider: string, id: string): Model<Api> | undefined;
}

interface CachedAutoSession {
	session?: CopilotAutoSession;
	pending?: Promise<CopilotAutoSession>;
}

/** Open Auto sessions, keyed by the Copilot access token that opened them. */
const autoSessions = new Map<string, CachedAutoSession>();

function pruneAutoSessions(activeKey: string): void {
	if (autoSessions.size <= SESSION_CACHE_MAX_ENTRIES) return;
	for (const [key, entry] of autoSessions) {
		if (key !== activeKey && !entry.pending && entry.session?.expiresAt !== undefined) {
			if (entry.session.expiresAt <= Date.now()) autoSessions.delete(key);
		}
	}
}

/** Return a live Auto session, opening or refreshing it when missing or expiring. */
function loadAutoSession(
	baseUrl: string,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<CopilotAutoSession> {
	const entry = autoSessions.get(apiKey) ?? {};
	autoSessions.set(apiKey, entry);
	pruneAutoSessions(apiKey);
	if (entry.session && entry.session.expiresAt - Date.now() > SESSION_REFRESH_MARGIN_MS)
		return Promise.resolve(entry.session);
	if (entry.pending) return entry.pending;
	const pending = fetchCopilotAutoSession(baseUrl, apiKey, { signal }).then(
		(session) => {
			entry.session = session;
			entry.pending = undefined;
			return session;
		},
		(error: unknown) => {
			entry.pending = undefined;
			throw error;
		},
	);
	entry.pending = pending;
	return pending;
}

function latestUserPrompt(messages: readonly Message[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content.trim() || undefined;
		return (
			message.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n")
				.trim() || undefined
		);
	}
	return undefined;
}

/**
 * The `github-copilot/auto` virtual model. `host` is the runtime that owns the
 * Copilot credential and the physical model catalog.
 */
export function copilotAutoVirtualModel(host: CopilotAutoHost): VirtualModelDefinition<CopilotAutoState> {
	return {
		provider: COPILOT_AUTO_PROVIDER_ID,
		id: COPILOT_AUTO_MODEL_ID,
		name: "Auto",
		// Conservative until the first route names the model that answers; afterwards the
		// routed model's limits apply because responses record it.
		contextWindow: 128_000,
		maxTokens: 64_000,
		input: ["text", "image"],
		async route(request: ModelRouteRequest<CopilotAutoState>) {
			const auth = await host.getAuth(COPILOT_AUTO_PROVIDER_ID, { signal: request.signal });
			const apiKey = auth?.auth.apiKey;
			if (!apiKey) {
				throw new Error("GitHub Copilot is not authenticated. Run /login and select GitHub Copilot.");
			}
			const baseUrl = auth.auth.baseUrl || DEFAULT_COPILOT_BASE_URL;
			const session = await loadAutoSession(baseUrl, apiKey, request.signal);

			const needsVision = hasCopilotVisionInput(request.messages);
			const eligible = new Map<string, Model<Api>>();
			for (const modelId of session.availableModelIds) {
				const model = host.getModel(COPILOT_AUTO_PROVIDER_ID, modelId);
				if (!model || isVirtualModel(model)) continue;
				if (needsVision && !model.input.includes("image")) continue;
				eligible.set(modelId, model);
			}
			if (eligible.size === 0) {
				const detail = needsVision ? "no vision-capable models" : "no models known to this catalog";
				throw new Error(
					`Copilot Auto returned ${detail} (received: ${session.availableModelIds.join(", ") || "none"}). ` +
						"Update nanopi so its Copilot catalog recognizes the account's Auto pool.",
				);
			}

			const failedModelId = request.failed?.model.id;
			const sticky = request.state?.modelId;
			if (sticky !== undefined && sticky !== failedModelId && eligible.has(sticky)) {
				const { thinkingLevel } = request;
				return {
					model: eligible.get(sticky)!,
					thinkingLevel,
					state: { modelId: sticky },
					headers: sessionTokenHeaders(session.sessionToken),
				};
			}

			const prompt = needsVision ? undefined : latestUserPrompt(request.messages);
			let modelId: string | undefined;
			if (prompt) {
				const decision = await fetchCopilotAutoRouterDecision(
					baseUrl,
					apiKey,
					session.sessionToken,
					{
						prompt,
						availableModelIds: session.availableModelIds,
						previousModelId: sticky ?? request.previous?.model.id,
						turnNumber: request.previous ? 2 : 1,
						referenceCount: 0,
					},
					{ signal: request.signal },
				);
				modelId = [decision?.chosenModelId, ...(decision?.candidateModelIds ?? [])]
					.filter((candidate): candidate is string => candidate !== undefined)
					.filter((candidate) => candidate !== failedModelId)
					.find((candidate) => eligible.has(candidate));
			}
			if (modelId === undefined) {
				const selectedModelId = session.selectedModelId;
				if (selectedModelId !== undefined && selectedModelId !== failedModelId && eligible.has(selectedModelId)) {
					modelId = selectedModelId;
				}
			}
			if (modelId === undefined) {
				modelId = [...eligible.keys()].find((candidate) => candidate !== failedModelId);
			}
			if (modelId === undefined) {
				throw new Error("Copilot Auto could not select a model for this request.");
			}
			return {
				model: eligible.get(modelId)!,
				thinkingLevel: request.thinkingLevel,
				state: { modelId },
				headers: sessionTokenHeaders(session.sessionToken),
			};
		},
	};
}

function sessionTokenHeaders(sessionToken: string): ProviderHeaders {
	return { [COPILOT_SESSION_TOKEN_HEADER]: sessionToken };
}
