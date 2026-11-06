export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

// Core only, side-effect free: no generated catalogs, no provider factories,
// no api-registry, no OAuth implementations, no compat. Provider factories
// live under "@nanopi/pi-ai/providers/*", API implementations under
// "@nanopi/pi-ai/api/*", the old global API under
// "@nanopi/pi-ai/compat".
//
// Mixed by kind, not by policy. A wildcard is preferred wherever it can be
// taken: a named list over `./utils/retry.ts` would be a second copy of that
// module's export table. The sources above and below stop being wildcardable for
// one reason each — `./api/*` mixes provider-specific option shapes into a
// namespace whose core is pipeline types, `providers/` is the generated catalog
// and stays off this entry on purpose, and the `./compat` case is the one time a
// list was tried and lost a name: this entry used to re-export by name, stopped
// reaching `./providers/faux.ts` when the file moved, and published `fauxProvider`
// and `createFauxCore` as nothing until someone noticed. So the rule is the
// opposite of "list what looks safe": every line below is named for a reason
// visible in the comment next to it.
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./api/anthropic-messages.ts";
export type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
export type { BedrockOptions, BedrockThinkingDisplay } from "./api/bedrock-converse-stream.ts";
export type { GoogleOptions } from "./api/google-generative-ai.ts";
export type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./api/google-shared.ts";
export type { GoogleVertexOptions } from "./api/google-vertex.ts";
export * from "./api/lazy.ts";
export type { NanoPiMessagesEvent, NanoPiMessagesOptions, NanoPiMessagesRewriteImpact } from "./api/nanopi-messages.ts";
export type {
	OpenAICodexRequestIdentity,
	OpenAICodexResponsesOptions,
	OpenAICodexSimpleStreamOptions,
	OpenAICodexWebSocketDebugStats,
} from "./api/openai-codex-responses.ts";
export type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
export type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
export * from "./auth/context.ts";
export * from "./auth/credential-store.ts";
export * from "./auth/helpers.ts";
export * from "./auth/types.ts";
export type {
	OAuthAuthInfo,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
export * from "./models.ts";
export * from "./models-store.ts";
// Re-exported by name, not by `export *`: `."/compat"` kept `./providers/faux.ts` when this entry
// stopped reaching it, and a wildcard here would drag the whole providers folder back in.
export {
	createFauxCore,
	type FauxContentBlock,
	type FauxModelDefinition,
	type FauxProviderHandle,
	type FauxProviderRegistration,
	type FauxProviderState,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type RegisterFauxProviderOptions,
	registerFauxProvider,
} from "./providers/faux.ts";
export * from "./session-resources.ts";
export * from "./types.ts";
export * from "./utils/assistant-message-frame.ts";
export * from "./utils/diagnostics.ts";
export * from "./utils/event-stream.ts";
export { createAssistantMessageEventStream } from "./utils/event-stream.ts";
export * from "./utils/json-parse.ts";
export * from "./utils/overflow.ts";
export * from "./utils/retry.ts";
export { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./utils/text.ts";
export * from "./utils/transcript.ts";
export * from "./utils/typebox-helpers.ts";
export { uuidv7 } from "./utils/uuid.ts";
export * from "./utils/validation.ts";
