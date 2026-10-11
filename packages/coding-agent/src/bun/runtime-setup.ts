import {
	bedrockMantleAnthropicMessagesProviderModule,
	bedrockMantleOpenAIResponsesProviderModule,
	bedrockProviderModule,
} from "@nanopi/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@nanopi/pi-ai/bun-oauth";
import {
	setBedrockMantleAnthropicMessagesProviderModule,
	setBedrockMantleOpenAIResponsesProviderModule,
	setBedrockProviderModule,
} from "@nanopi/pi-ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
setBedrockMantleOpenAIResponsesProviderModule(bedrockMantleOpenAIResponsesProviderModule);
setBedrockMantleAnthropicMessagesProviderModule(bedrockMantleAnthropicMessagesProviderModule);
