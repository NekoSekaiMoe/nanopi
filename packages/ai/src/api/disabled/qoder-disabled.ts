/**
 * Stand-in for `qoder.lazy.ts` in a build whose API set leaves qoder out
 * (buildconfig.json `apiSets`).
 *
 * The build aliases the `.lazy` module to this file at resolve time
 * (scripts/build-apis.mjs) instead of filtering the registry at runtime: a
 * runtime filter keeps the lazy module's dynamic `import()` in the graph, so
 * the implementation still ships in a build that never calls it.
 *
 * The export names and signatures match `qoder.lazy.ts`; only the body
 * differs. A call reports the build flavor instead of loading anything.
 */

import type { ProviderStreams } from "../../types.ts";

function disabled(): never {
	throw new Error("qoder is not included in this build (buildconfig.json apiSets)");
}

export const qoderApi = (): ProviderStreams => ({ stream: disabled, streamSimple: disabled });
