/**
 * Statically imported Bedrock implementations, handed to the APIs that
 * otherwise load them through a variable specifier.
 *
 * The single-file build cannot follow a variable-specifier import (see
 * `api/bedrock-converse-stream.lazy.ts`), so `standalone/runtime-setup.ts`
 * registers these values with the lazy wrappers before the first session.
 *
 * The getters hand back a lazy wrapper instead of the implementation: the
 * `import()` starts on the first `stream`/`streamSimple` call, so a session
 * that never picks a Bedrock model never loads the AWS SDK, and registration
 * at startup costs nothing. The load is memoized, so the wrapper and the module
 * cache agree on one implementation per process.
 */

import { lazyApi } from "./api/lazy.ts";
import type { ProviderStreams } from "./types.ts";

let bedrockModule: Promise<ProviderStreams> | undefined;
let bedrockMantleOpenAIResponsesModule: Promise<ProviderStreams> | undefined;
let bedrockMantleAnthropicMessagesModule: Promise<ProviderStreams> | undefined;

export function getBedrockProviderModule(): ProviderStreams {
	bedrockModule ??= import("./api/bedrock-converse-stream.ts");
	return lazyApi(() => bedrockModule as Promise<ProviderStreams>);
}

export function getBedrockMantleOpenAIResponsesProviderModule(): ProviderStreams {
	bedrockMantleOpenAIResponsesModule ??= import("./api/bedrock-mantle-openai-responses.ts");
	return lazyApi(() => bedrockMantleOpenAIResponsesModule as Promise<ProviderStreams>);
}

export function getBedrockMantleAnthropicMessagesProviderModule(): ProviderStreams {
	bedrockMantleAnthropicMessagesModule ??= import("./api/bedrock-mantle-anthropic-messages.ts");
	return lazyApi(() => bedrockMantleAnthropicMessagesModule as Promise<ProviderStreams>);
}
