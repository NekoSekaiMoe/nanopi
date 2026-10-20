import {
	getBedrockMantleAnthropicMessagesProviderModule,
	getBedrockMantleOpenAIResponsesProviderModule,
	getBedrockProviderModule,
} from "@nanopi/pi-ai/bedrock-provider";
import { registerBundledOAuthFlows } from "@nanopi/pi-ai/bundled-oauth";
import {
	setBedrockMantleAnthropicMessagesProviderModule,
	setBedrockMantleOpenAIResponsesProviderModule,
	setBedrockProviderModule,
} from "@nanopi/pi-ai/compat";
import { isApiIncluded } from "../build-components.ts";

/**
 * Registers variable-specifier lazy modules (OAuth flows, Bedrock APIs)
 * statically. Single-file bundles cannot follow variable imports to on-disk
 * module files, so the bundle registers the implementations directly.
 *
 * Imported for its side effects before the CLI entrypoint so every lazy
 * loader sees the overrides before the first session starts.
 */
registerBundledOAuthFlows();
// The Bedrock registrations are gated on the build's API set: a build that
// drops those APIs (buildconfig.json `apiSets`) has no implementation to hand
// over, and asking for one would pull the AWS SDK back into the bundle.
if (isApiIncluded("bedrock-converse-stream")) {
	setBedrockProviderModule(getBedrockProviderModule());
}
if (isApiIncluded("bedrock-mantle-openai-responses")) {
	setBedrockMantleOpenAIResponsesProviderModule(getBedrockMantleOpenAIResponsesProviderModule());
}
if (isApiIncluded("bedrock-mantle-anthropic-messages")) {
	setBedrockMantleAnthropicMessagesProviderModule(getBedrockMantleAnthropicMessagesProviderModule());
}
