import {
	bedrockMantleAnthropicMessagesProviderModule,
	bedrockMantleOpenAIResponsesProviderModule,
	bedrockProviderModule,
} from "@nanopi/pi-ai/bedrock-provider";
import { registerBundledOAuthFlows } from "@nanopi/pi-ai/bundled-oauth";
import {
	setBedrockMantleAnthropicMessagesProviderModule,
	setBedrockMantleOpenAIResponsesProviderModule,
	setBedrockProviderModule,
} from "@nanopi/pi-ai/compat";

/**
 * Registers variable-specifier lazy modules (OAuth flows, Bedrock APIs)
 * statically. Single-file bundles cannot follow variable imports to on-disk
 * module files, so the bundle registers the implementations directly.
 *
 * Imported for its side effects before the CLI entrypoint so every lazy
 * loader sees the overrides before the first session starts.
 */
registerBundledOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setBedrockMantleOpenAIResponsesProviderModule(bedrockMantleOpenAIResponsesProviderModule);
setBedrockMantleAnthropicMessagesProviderModule(bedrockMantleAnthropicMessagesProviderModule);
