/**
 * Statically imported Bedrock implementations, handed to the APIs that
 * otherwise load them through a variable specifier.
 *
 * The single-file build cannot follow a variable-specifier import (see
 * `api/bedrock-converse-stream.lazy.ts`), so `standalone/runtime-setup.ts`
 * registers these values with the lazy wrappers before the first session. The
 * getters load the implementation on first read: a flavor whose API set leaves
 * Bedrock out never reaches them, and the AWS SDK stays out of its bundle.
 */

import type { ProviderStreams } from "./types.ts";

let bedrockModule: ProviderStreams | undefined;
let bedrockMantleOpenAIResponsesModule: ProviderStreams | undefined;
let bedrockMantleAnthropicMessagesModule: ProviderStreams | undefined;

export function getBedrockProviderModule(): ProviderStreams {
	bedrockModule ??= requireBedrockModule(() => import("./api/bedrock-converse-stream.ts"), "bedrock-converse-stream");
	return bedrockModule;
}

export function getBedrockMantleOpenAIResponsesProviderModule(): ProviderStreams {
	bedrockMantleOpenAIResponsesModule ??= requireBedrockModule(
		() => import("./api/bedrock-mantle-openai-responses.ts"),
		"bedrock-mantle-openai-responses",
	);
	return bedrockMantleOpenAIResponsesModule;
}

export function getBedrockMantleAnthropicMessagesProviderModule(): ProviderStreams {
	bedrockMantleAnthropicMessagesModule ??= requireBedrockModule(
		() => import("./api/bedrock-mantle-anthropic-messages.ts"),
		"bedrock-mantle-anthropic-messages",
	);
	return bedrockMantleAnthropicMessagesModule;
}

/**
 * Starts the implementation load and returns a stream pair that fails clearly
 * while it is still in flight. `runtime-setup.ts` reads these values
 * synchronously, before the first session, so the load always wins the race in
 * practice; a build whose API set drops the implementation has no static
 * registration at all and never calls this.
 */
function requireBedrockModule(load: () => Promise<ProviderStreams>, api: string): ProviderStreams {
	let loaded: ProviderStreams | undefined;
	void load().then(
		(module) => {
			loaded = module;
		},
		() => {},
	);
	return {
		stream: (...args) => {
			if (!loaded) throw new Error(`${api} is still loading or is not included in this build`);
			return loaded.stream(...args);
		},
		streamSimple: (...args) => {
			if (!loaded) throw new Error(`${api} is still loading or is not included in this build`);
			return loaded.streamSimple(...args);
		},
	};
}
