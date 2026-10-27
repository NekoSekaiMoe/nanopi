# Agent Note: highlight.js grammars load on demand

Status: implemented

## Problem

Issue #252 asked whether `import("highlight.js/lib/index.js")` was a missing
exception to the no-inline-imports rule. It was, but the rule was the smaller
half of the question: 128 grammars were also static imports, registered at
startup, for a session that may never render one of them.

Measured on the built module, one grammar loaded versus all of them:

```
191 grammars at startup   heap 8.81 MB   rss 65.82 MB   +74.9 ms
1 grammar on demand       heap 4.33 MB   rss 50.38 MB   +13.4 ms
```

Once one grammar is deferred, the deferral has to go through the bundler entry
`highlight.js/lib/index.js`, which registers all 191. So the eager 128 did not
save anything a deferred 191 would not: they only decided *when* the cost was
paid, and paid it in the common case.

## Decision

`utils/syntax-highlight.ts` imports no grammar at module scope. It carries
`BUNDLED_LANGUAGES`, the 188 language tags highlight.js 11.12.0 bundles, and one
`import("highlight.js/lib/languages/<name>")` per tag inside
`preloadLanguage`'s switch. esbuild emits one 4 KiB chunk per grammar plus a
4 KiB chunk for `index.js`; none of them is in the entry graph.

`supportsLanguage(name)` reports a bundled tag as supported without importing
anything and starts its load; an unloaded grammar used to answer "no", which
would have fallen back to a plain render for every first code block ever
rendered. `highlight()` stays synchronous: a grammar that has not arrived yet
renders plain, and the load registers it for the next paint.

`pendingHighlightLanguages()` replaces `loadAllHighlightLanguages()`. The
interactive mode waits on the loads the *first render* started instead of
prefetching all 191, so the repaint after startup only waits for what the
session is actually showing.

## Alternatives considered

- **Keep the 128-grammar eager table and only fix the docs.** The issue that
  started this was about a documentation gap, and the instant memory win was
  not the reason it was filed. But a session showing shell and TypeScript still
  paid 8.81 MB of heap to register 191 parsers, and `full` is the default
  flavor: the common path was the expensive one.
- **Defer only the 63 grammars the eager table did not carry.** ~76 ms and
  8.81 MB remain, and the eager 128 keep the bundler entry and every grammar in
  the entry graph. Half the domains, all of the cost.
- **Register grammars from source text at runtime** (`vm.runInNewContext` over
  each grammar file). Would have kept everything out of the graph without the
  switch, but it is code execution from strings, and it measured no faster than
  191 dynamic imports: 96 ms against 76 ms.
- **Fully async `highlight()`.** Correct color for the very first render of any
  language, at the cost of an async API on the markdown theme's synchronous
  `highlightCode` hook. The first-block plain render is one paint on a rare
  path (a language never seen before in the session); the second render is
  colored.
- **A second module with a top-level `for` over a variable specifier.** esbuild
  cannot resolve variable specifiers, so the `import()` would have to be
  written out anyway; splitting it into a second module buys nothing.

## Consequences

- Startup registers no grammar. The first render of each new language is plain
  and the next one is colored: the interactive mode re-renders once the loads
  it started settle.
- A language never rendered costs nothing, in heap or in chunks read. Reading
  one costs ~0.4 ms of module load (0.6 ms for the largest grammar).
- `BUNDLED_LANGUAGES` and the switch are two lists to keep in step; the
  `syntax-highlight` test loads a sample of them, including `csharp`, so a
  name that does not resolve to a module fails the suite.
- The disabled component stub keeps the same export names, so a build without
  `syntax-highlight` still swaps cleanly.
- `utils/syntax-highlight.ts` no longer has an inline import to excuse in
  `AGENTS.md`; that exception clause now points at the grammars that are still
  deferred, the same ones this module loads.
