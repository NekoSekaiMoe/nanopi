import { join } from "node:path";
import { hasOAuthFlows, isNoBuiltinProviderBuild } from "../build-components.ts";
import { getDocsPath, getModelsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return [
		hasOAuthFlows()
			? "Use /login to log into a provider via OAuth or API key. See:"
			: "Use /login to store a provider API key, or add one to models.json. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

/**
 * A build with no built-in provider has nothing to log into: every model comes
 * from `models.json`, so point at the file and the two fields it needs instead
 * of sending the user to a `/login` list that is empty by construction.
 */
function getCustomProviderHelp(): string {
	return [
		`This build ships no built-in provider. Add an endpoint and key to ${getModelsPath()}:`,
		"",
		"  {",
		'    "providers": {',
		'      "my-endpoint": {',
		'        "baseUrl": "https://api.example.com/v1",',
		'        "api": "openai-completions",',
		'        "apiKey": "$MY_ENDPOINT_API_KEY",',
		'        "models": [{ "id": "my-model" }]',
		"      }",
		"    }",
		"  }",
		"",
		`Then use /model to select it. See: ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

function getModelSetupHelp(): string {
	return isNoBuiltinProviderBuild() ? getCustomProviderHelp() : getProviderLoginHelp();
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getModelSetupHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getModelSetupHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getModelSetupHelp()}`;
}
