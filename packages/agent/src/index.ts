// `export *` per source, not a hand-maintained whitelist: a name cannot go
// missing quietly, and the cost stays a number in `scripts/check-entry-graphs.mjs`
// (see `packages/coding-agent/test/root-barrel-exports.test.ts`). A symbol that
// should not be public loses its `export` at the declaration — here the wildcard
// would carry it out, and no edit to this file can.

export * from "./agent.ts";
export * from "./agent-loop.ts";
export * from "./proxy.ts";
export { setDefaultStreamFn } from "./stream-fn.ts";
export * from "./types.ts";
