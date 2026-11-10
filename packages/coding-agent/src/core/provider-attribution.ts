import type { Api, Model, ProviderHeaders } from "@nanopi/pi-ai";
import { OPENCODE_CLIENT_HEADER, OPENCODE_SESSION_HEADER } from "@nanopi/pi-ai/providers/opencode-headers";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";
const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

function isOpenRouterModel(model: Model<Api>): boolean {
	return model.provider === "openrouter" || model.baseUrl.includes(OPENROUTER_HOST);
}

function isNvidiaNimModel(model: Model<Api>): boolean {
	return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

function isCloudflareModel(model: Model<Api>): boolean {
	return (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
		matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
	);
}

/**
 * Whether the model is served by OpenCode's gateway: a built-in OpenCode provider, or any other
 * provider pointed at the host, such as a models.json entry or a proxy.
 */
export function isOpenCodeModel(model: Model<Api>): boolean {
	return OPENCODE_PROVIDERS.has(model.provider) || matchesHost(model.baseUrl, OPENCODE_HOST);
}

function getDefaultAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (isOpenRouterModel(model)) {
		return {
			"HTTP-Referer": "https://github.com/NekoSekaiMoe/nanopi",
			"X-OpenRouter-Title": "nanopi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (isNvidiaNimModel(model)) {
		return {
			"X-BILLING-INVOKE-ORIGIN": "nanopi",
		};
	}

	if (isCloudflareModel(model)) {
		return {
			"User-Agent": "pi-coding-agent",
		};
	}

	return undefined;
}

/** OpenCode's routing identity: which conversation a request belongs to, and who is asking. */
function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (!isOpenCodeModel(model)) return undefined;
	return {
		...(sessionId ? { [OPENCODE_SESSION_HEADER]: sessionId } : {}),
		[OPENCODE_CLIENT_HEADER]: "nanopi",
	};
}

/**
 * Headers every request to `model` in `sessionId` carries: attribution defaults first, then
 * OpenCode's identity. Headers the caller supplies are merged on top, per request.
 */
export function getProviderAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {
		...getDefaultAttributionHeaders(model, settingsManager),
		...getSessionHeaders(model, sessionId),
	};
	return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeProviderAttributionHeaders(
	model: Model<Api> | undefined,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = model ? { ...getProviderAttributionHeaders(model, settingsManager, sessionId) } : {};

	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
