/**
 * Stand-in for `bedrock-converse-stream.lazy.ts` in a build whose API set leaves bedrock-converse-stream out
 * (buildconfig.json `apiSets`).
 *
 * The build aliases the `.lazy` module to this file at resolve time
 * (scripts/build-apis.mjs) instead of filtering the registry at runtime: a
 * runtime filter keeps the lazy module's dynamic `import()` in the graph, so
 * the implementation and every client SDK it pulls (the Google, AWS, Anthropic
 * or OpenAI package) still ships in a build that never calls it.
 *
 * The export names and signatures match `bedrock-converse-stream.lazy.ts`; only the body
 * differs. A call reports the build flavor instead of loading anything.
 */

import type { ProviderStreams } from "../../types.ts";

function disabled(): never {
	throw new Error("bedrock-converse-stream is not included in this build (buildconfig.json apiSets)");
}

/** Kept so the single-file build can register a statically imported module; a disabled build has none. */
export function setBedrockProviderModule(_module: ProviderStreams): void {}

export const bedrockConverseStreamApi = (): ProviderStreams => ({ stream: disabled, streamSimple: disabled });
