/**
 * What a module author needs from the message stream, without the model runtime.
 *
 * `@nanopi/pi-ai`'s root barrel is the host surface: it carries model collections, auth, catalog
 * refresh and the api registry. A coding-agent module that renders or measures messages only wants
 * the transcript helpers, so it imports them here and pays for these two files instead of the root
 * graph.
 */

export { calculateCost } from "./utils/cost.ts";
export {
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
} from "./utils/retry.ts";
export { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./utils/text.ts";
export {
	getCurrentSystemMessage,
	getCurrentTools,
	getInitialSystemMessage,
	normalizeContext,
	withoutInitialSystemMessage,
} from "./utils/transcript.ts";
export { uuidv7 } from "./utils/uuid.ts";
