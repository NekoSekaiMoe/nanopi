/**
 * esbuild wiring for the `openai` SDK in a build whose API set is
 * openai-completions alone.
 *
 * `createApiStubPlugin` (build-apis.mjs) already drops every API implementation
 * outside the flavor's set, and with each one the client SDK it imports. What it
 * cannot drop is the SDK's own bulk inside the one API that stays:
 * `openai-completions.ts` imports `OpenAI` from the package root, whose barrel
 * aggregates every resource (responses, assistants, realtime, beta, admin,
 * vector stores, ...). In the minimal single file that is 1379 KiB of inputs
 * where the chat-completions path runs ~180 KiB, and the excess grows with
 * every SDK release.
 *
 * The fix here is a narrow entry: `packages/ai/src/api/openai-chat-completions-client.ts`
 * keeps the SDK client and its request path, so retries, timeouts, error status
 * mapping and SSE decoding are still the SDK's own code, and instantiates only
 * the chat-completions resource. The plugin swaps the bare `openai` specifier
 * for that module, which leaves the barrel and the resources behind it
 * unreferenced.
 *
 * Scope: only a build whose API set is exactly `["openai-completions"]` gets
 * the swap. `openai-responses`, `azure-openai-responses`,
 * `openai-codex-responses` and `openrouter-images` all use other parts of the
 * SDK, and `base`/`full` ship them, so those flavors keep the full client. The
 * API-set list is the same value the build already resolves, so a flavor whose
 * set changes gains or loses the narrow client with no second switch.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The only API set whose runtime path the narrow client covers. */
export const NARROW_CLIENT_API_SET = ["openai-completions"];

/** Module the bare `openai` specifier is redirected to, inside packages/ai/src. */
const NARROW_CLIENT_MODULE = "api/openai-chat-completions-client.ts";

/**
 * Whether this build can ship the narrow client. `builtinApiIds` is the
 * resolved API set (`resolveBuiltinApiIds`), so `__ALL__` keeps the full SDK.
 *
 * @param {readonly string[]} builtinApiIds
 * @returns {boolean}
 */
export function usesNarrowOpenAIClient(builtinApiIds) {
	return (
		builtinApiIds.length === NARROW_CLIENT_API_SET.length &&
		NARROW_CLIENT_API_SET.every((apiId) => builtinApiIds.includes(apiId))
	);
}

/**
 * Redirects the bare `openai` specifier to the narrow client.
 *
 * The target is the compiled sibling of the importing module: this build runs
 * from `packages/ai/dist`, and resolving the stand-in from `packages/ai/src`
 * would put a second copy of the AI package's modules in the graph.
 *
 * @param {{ aiDistDir: string, enabled: boolean }} options
 * @returns {import("esbuild").Plugin}
 */
export function createNarrowOpenAIClientPlugin({ aiDistDir, enabled }) {
	if (!enabled) return { name: "narrow-openai-client", setup() {} };
	const target = join(aiDistDir, NARROW_CLIENT_MODULE.replace(/\.ts$/, ".js"));
	if (!existsSync(target)) {
		throw new Error(
			`Narrow openai client is missing: ${target}. Build the workspace packages first.`,
		);
	}
	// Anchored: `openai/resources/chat/completions.js` and the other subpaths
	// already name one module, and the types come from those same paths.
	const barrel = /^openai$/;
	return {
		name: "narrow-openai-client",
		setup(build) {
			build.onResolve({ filter: barrel }, (args) => (barrel.test(args.path) ? { path: target } : undefined));
		},
	};
}
