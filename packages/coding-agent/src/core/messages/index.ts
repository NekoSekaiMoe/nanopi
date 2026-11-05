/**
 * Runtime message-type registry: what `AgentMessage` cannot do through declaration
 * merging, done at runtime instead.
 */

export { charsToTokens, createBuiltinMessageCodecs, estimateMessageTokens } from "./builtin-codecs.ts";
export {
	type MessageCodecRenderOptions,
	type MessageTypeCodec,
	type MessageTypeCodecMap,
	messageKind,
	resolveMessageCodec,
} from "./codec.ts";
export {
	type CustomMessageRenderer,
	type CustomMessageShape,
	customMessageCodecMap,
	genericCustomMessageCodec,
} from "./custom-message.ts";
export { MessageTypeRegistry } from "./registry.ts";
