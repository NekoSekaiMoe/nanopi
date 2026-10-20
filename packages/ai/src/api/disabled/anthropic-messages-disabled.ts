/**
 * Stand-in for `anthropic-messages.lazy.ts` in a build whose API set leaves anthropic-messages out
 * (buildconfig.json `apiSets`).
 *
 * The build aliases the `.lazy` module to this file at resolve time
 * (scripts/build-apis.mjs) instead of filtering the registry at runtime: a
 * runtime filter keeps the lazy module's dynamic `import()` in the graph, so
 * the implementation and every client SDK it pulls (the Google, AWS, Anthropic
 * or OpenAI package) still ships in a build that never calls it.
 *
 * The export names and signatures match `anthropic-messages.lazy.ts`; only the body
 * differs. A call reports the build flavor instead of loading anything.
 */

import type { ProviderStreams } from "../../types.ts";

function disabled(): never {
	throw new Error("anthropic-messages is not included in this build (buildconfig.json apiSets)");
}

export const anthropicMessagesApi = (): ProviderStreams => ({ stream: disabled, streamSimple: disabled });
