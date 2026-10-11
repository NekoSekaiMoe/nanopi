/**
 * Registry of OAuth flows, shared by the bundle and single-file build
 * scripts.
 *
 * The registry must stay in lockstep with two other places, which
 * validateOAuthFlowRegistry enforces at build time:
 *
 * - packages/ai/src/auth/oauth/load.ts: every `importOAuthModule("./<flow>.ts")`
 *   call must have a registry entry, otherwise a new flow ships without a lazy
 *   bundle entry or single-file shim and fails at runtime.
 * - buildconfig.json: every `oauth/<flow>` component must match the registry,
 *   otherwise stale components silently stop matching any build wiring.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** @type {ReadonlyArray<{ module: string, loader: string, exportName: string }>} */
export const OAUTH_FLOWS = [
	{ module: "anthropic", loader: "anthropic", exportName: "anthropicOAuth" },
	{ module: "github-copilot", loader: "githubCopilot", exportName: "githubCopilotOAuth" },
	{ module: "kimi-coding", loader: "kimiCoding", exportName: "kimiCodingOAuth" },
	{ module: "meta", loader: "meta", exportName: "metaOAuth" },
	{ module: "openai-chatgpt", loader: "openaiChatGPT", exportName: "openaiChatGPTOAuth" },
	{ module: "openai-codex", loader: "openaiCodex", exportName: "openaiCodexOAuth" },
	{ module: "openrouter", loader: "openrouter", exportName: "openRouterOAuth" },
	{ module: "xai", loader: "xai", exportName: "xaiOAuth" },
];

export function oauthComponentName(flow) {
	return `oauth/${flow.module}`;
}

function sortedDifference(left, right) {
	const rightSet = new Set(right);
	return left.filter((value) => !rightSet.has(value));
}

/**
 * Cross-checks the registry against load.ts and the resolved buildconfig
 * component map. Throws with the exact drift so fixes are mechanical.
 */
export function validateOAuthFlowRegistry({ repoRoot, components }) {
	const loadPath = join(repoRoot, "packages", "ai", "src", "auth", "oauth", "load.ts");
	const loadModules = [...readFileSync(loadPath, "utf8").matchAll(/importOAuthModule\("\.\/([^"]+)\.ts"\)/g)].map((match) => match[1]);
	const registryModules = OAUTH_FLOWS.map((flow) => flow.module);

	const missingFromRegistry = sortedDifference(loadModules, registryModules);
	if (missingFromRegistry.length > 0) {
		throw new Error(
			`OAuth flows imported by load.ts but missing from scripts/oauth-flows.mjs: ${missingFromRegistry.join(", ")}`,
		);
	}
	const missingFromLoad = sortedDifference(registryModules, loadModules);
	if (missingFromLoad.length > 0) {
		throw new Error(`Registry entries with no importOAuthModule call in load.ts: ${missingFromLoad.join(", ")}`);
	}

	const declaredComponents = Object.keys(components)
		.filter((name) => name.startsWith("oauth/"))
		.map((name) => name.slice("oauth/".length));
	const missingFromConfig = sortedDifference(registryModules, declaredComponents);
	if (missingFromConfig.length > 0) {
		throw new Error(`OAuth flows missing an "oauth/<flow>" component in buildconfig.json: ${missingFromConfig.join(", ")}`);
	}
	const staleConfigEntries = sortedDifference(declaredComponents, registryModules);
	if (staleConfigEntries.length > 0) {
		throw new Error(`buildconfig.json declares oauth components with no OAuth flow: ${staleConfigEntries.join(", ")}`);
	}
}
