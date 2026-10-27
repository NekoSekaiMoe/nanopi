# Agent Note: the vendored highlight.js and marked captures are rebuilt, not downloaded

Status: implemented

## Problem

`packages/coding-agent/src/core/export-html/vendor/` holds three minified files
with no generation step. Two of them were captures of upstream release builds,
made years apart from the packages the repo declares:

- `highlight.min.js` was highlight.js **11.9.0**, `hljs` v11's *common* build (36
  grammars), while `package.json` still pinned the dependency at **10.7.3**.
  Nothing at runtime in Node read that 10.7.3 grammar set for the export: the
  file was the whole highlight story for an exported HTML file.
- `marked.min.js` was **18.0.5**, `marked-cjk-friendly.min.js` was already the
  UMD stand-in that the vendored `marked` global needs, and the package depends
  on `marked` **18.1.2** since #303. The capture and the dependency had drifted
  one patch apart, so a fix in marked's 18.1.x line reached the TUI's markdown and
  not the exported HTML.

The result was three-way drift: the declared dependency, the capture in the repo,
and the grammar set the export document actually ran. Any of the three could be
"the version" depending on who asked.

## Decision

The captures are generated from the packages the repo already installs, by a
one-off esbuild IIFE build, and committed as the same three files:

- `highlight.min.js`: `highlight.js/lib/core` plus the exact 36 grammars v11's
  `lib/common` registers, bundled for the browser, `globalName: "hljs"`.
- `marked.min.js`: `marked` 18.1.2, `globalName: "marked"`.
- `marked-cjk-friendly.min.js`: unchanged. It is a UMD-free stand-in this repo
  wrote itself, not an upstream build, so there is nothing to regenerate; it
  attaches `globalThis.markedCjkFriendly` and the template keeps using that.

Two details force the shape:

- **`footer: { js: "hljs = hljs.default || hljs;" }` (`marked = marked.default ||
  marked;`).** `highlight.js/lib/core` and `marked` are ES modules, so the IIFE's
  `hljs` global is the module namespace object, not the API. Without the footer
  the template's `hljs.highlight(...)` is `undefined`, in the browser and in the
  `vm` context the CJK test uses.
- **`var hljs = (() => ...)()`, not a `return` wrapper.** The capture is pasted
  into an inline `<script>` through a `String.prototype.replace` callback;
  `$`-sequences in the file would otherwise be read as replacement patterns.

The v11 capture is Terser-style dense but not byte-identical to upstream's
release file: 163 KB against 122 KB for the 11.9.0 common build, because esbuild
repeats fewer string constants across grammars. Size is not the constraint here
(the export document inlines it either way); reproducibility is, and it is now
"build from the installed package" instead of "whoever downloaded it last".

## Consequences

The dependency bump that came with it (`highlight.js` 10.7.3 → 11.12.0) is not
free, because the Node side reads the same package:

- v11 owns its export map and only lists subpaths **without** the extension:
  `./lib/languages/*` maps to `./lib/languages/*.js`, so
  `highlight.js/lib/languages/bash.js` now names a file that does not exist and
  fails to resolve. Every specifier in `utils/syntax-highlight.ts` and in
  `scripts/build-components.test.mjs` dropped the `.js`, and `lib/index.js`
  (register-everything escape hatch) became `lib/common` on the same rule.
- The package ships real TypeScript declarations, so `utils/highlight-js.d.ts`
  no longer declares an API shape. It only re-routes the extensionless subpaths at
  the package's own types; the `LanguageFn` type comes from `highlight.js`.
- `c-like`, `htmlbars` and `sql_more` were removed upstream, so the on-demand
  table loses all three and the `syntax-highlight` test's sample language
  `sql_more` became `csharp`. `c-like` and `sql_more` already only had meaning as
  spellings of `c`/`cpp` and `sql`; `htmlbars` was an alias of `handlebars`.
- v11 tightens the core: `ignoreIllegals` now defaults to `true`, and HTML
  auto-passthru is out of core. `renderHighlightedHtml` escapes what it emits and
  the export always passes `language` or uses `highlightAuto`, so neither changes
  a rendered block — the 36 shared grammars emit byte-identical spans on the
  samples checked (typescript, javascript, bash, python, rust, xml, json, yaml,
  plus `highlightAuto`).
- The scoped `.hljs` CSS that v11 introduced was already handled: the template
  styles `.hljs-*` child spans, not `pre.hljs`.

## Alternatives considered

- **Regenerate `highlight.min.js` as the full 190-grammar build.** One number
  looks tidier (the capture and the on-demand table would agree, and a file
  export would color any language the session could color). It also makes the
  export document carry 1.03 MB of grammar for a file a human opens once; the
  capture has always been the common set, and a language outside it still renders
  as plain text, which is the fallback the template already has.
- **Keep the captures and only bump the dependency.** That is what the repo was
  already doing, and it is exactly the drift #307 is about: the export keeps
  rendering marked 18.0.5 after a fix lands in 18.1.x, and the highlight story in
  the export keeps a version nothing declares.
- **Build the captures at package build time.** It would remove the committed
  blobs, but `template.html` inlines all three via string replacement, so the
  build would gain a browser-bundle step for a file whose freshness nobody can
  diff in review. A committed artifact that a reviewer can regenerate locally is
  the cheaper contract.
- **Pin `highlight.js` at 10.7.x and leave the Node side alone.** The 11.9.0
  capture already proved the export was running v11 semantics, so the dependency
  would keep declaring a version that only the generated file was allowed to
  leave behind.

## Verification

- `pnpm exec vitest --run test/export-html-cjk.test.ts test/export-html-xss.test.ts
  test/export-html-whitespace.test.ts test/export-html-skill-block.test.ts
  test/export-html-cost.test.ts test/export-cli-theme.test.ts
  test/syntax-highlight.test.ts`: 37 passed. The CJK test is the one that matters
  for the marked swap: `marked-cjk-friendly` 0.1.3 still supplies `emStrong` to
  `marked` 18.1.2.
- `pnpm run check`: biome, pinned deps, runtime deps, TS imports, entry-graph
  budgets and the browser smoke build are green. `tsc --noEmit` reports one
  pre-existing error in `src/utils/sidecars.ts` (`ReadableStream` variance against
  `@types/node` 22.20.5) that also fails on a clean `main`; the `highlight.js`
  upgrade adds none.
- The grammar chunks stay out of the entry graph: esbuild splitting puts 189
  grammar chunks beside the core, ~9.6 KB each, and the entry imports none of
  them until a code block asks.
