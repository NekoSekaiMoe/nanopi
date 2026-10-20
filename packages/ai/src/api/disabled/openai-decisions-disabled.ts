/**
 * Stand-in for `openai-decisions.lazy.ts` in a build whose API set leaves openai-decisions out
 * (buildconfig.json `apiSets`).
 *
 * The build aliases the `.lazy` module to this file at resolve time
 * (scripts/build-apis.mjs) instead of filtering the registry at runtime: a
 * runtime filter keeps the lazy module's dynamic `import()` in the graph, so
 * the implementation and every client SDK it pulls (the Google, AWS, Anthropic
 * or OpenAI package) still ships in a build that never calls it.
 *
 * The export names and signatures match `openai-decisions.lazy.ts`; only the body
 * differs. A call reports the build flavor instead of loading anything.
 */

import type { ProviderClassifier } from "../../types.ts";

export const openAIDecisionsApi = (): ProviderClassifier => ({
	classify: async () => {
		throw new Error("openai-decisions is not included in this build (buildconfig.json apiSets)");
	},
});
