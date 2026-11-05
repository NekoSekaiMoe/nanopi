// `export *` per source, not a hand-maintained whitelist: every name below the
// source is this package's public name already, so the list would be one row per
// source with nothing to decide — except whether it was updated when that source
// gained an export. It was not, and the drift was invisible.
//
// A symbol that should not be public loses its `export` at the declaration:
// `getDefaultStreamFn` and the `request-metadata.ts` helpers are used by
// `agent.ts`, `agent-loop.ts` and the tests, none of them published. The
// wildcard cannot carry them out (#517 measured the same move on the
// coding-agent root). The cost of the wildcard stays a number in
// `scripts/check-entry-graphs.mjs`.

export * from "./agent.ts";
export * from "./agent-loop.ts";
export * from "./proxy.ts";
export { setDefaultStreamFn } from "./stream-fn.ts";
export * from "./types.ts";
