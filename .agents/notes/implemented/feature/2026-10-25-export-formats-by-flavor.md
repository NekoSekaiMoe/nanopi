# Agent Note: Export formats follow the flavor ladder, and a PDF is the HTML document printed

Status: implemented

## Problem

Export was one feature with one output: `export-html` was a buildconfig
component, `/export <path>` wrote HTML for every path that did not end in
`.jsonl`, and `--export` did the same. The issue asks for a per-flavor export
surface (minimal: none, base: MD + HTML, full: MD + HTML + PDF on the first
pass), which one switch cannot express.

Two things make this more than a `switch (extension)`:

1. The HTML export is not a renderer that produces text — it is a data payload
   (`<script id="session-data">` + template JS) that the browser renders. A
   Markdown file has to be produced in Node, from the entry list, which nothing
   did before this change.
2. A PDF has to be produced by something that can render that document. The Node
   build cannot, so the question "does export also mean PDF" is really the
   question "does this build carry a rendering engine".

Concrete trace of the old behavior that confused users: `nanopi --export
session.jsonl out.md` wrote an HTML document named `out.md`. Same for
`/export notes.md`.

## Decision

Export is two components, one per format that needs code:

- `export-html` — unchanged: templates plus the browser document. HTML stays the
  default for a path with no export extension, because every existing caller
  (`/share`, `export_html` over RPC, `--export x.jsonl` with no output path)
  expects HTML.
- `export-markdown` — new `src/core/export-markdown/`, a Node renderer over the
  session branch. It keeps tool calls (name + arguments as JSON) and tool
  results (fenced), because a transcript without them hides the half of the
  conversation that did the work. Fences grow when the content contains one.

There is no `export-pdf` component and no PDF writer in the product. The final
flavor matrix (issue [#187](https://cnb.cool/shinytale/nanopi/-/issues/187),
which supersedes the matrix in [#184](https://cnb.cool/shinytale/nanopi/-/issues/184))
is:

| flavor | Markdown | HTML | PDF |
| --- | --- | --- | --- |
| `minimal` | no | no | no |
| `base` | yes | no | no |
| `full` | yes | yes | no (print the HTML) |

`minimal` never carried export at all, so it keeps the `*: false` default; `base`
enables `export-markdown` alone; `full` inherits both from its `*: true`. A
`.jsonl` export is the session file itself and is not gated by any component, so
`minimal` still copies it.

Format resolution is one module, `src/core/session-export-formats.ts`, used by
the CLI, `/export`, and the RPC handler, so "which formats does this build
carry" has one answer. A disabled format fails with `"<FORMAT> export is not
included in this build (buildconfig.json component "<x>" is disabled)"` instead
of writing an empty file.

`pdf` is not a format this build writes, but it still parses to itself so the
three callers can answer with one hint — export HTML, open it, print to PDF —
rather than writing an HTML document under a `.pdf` name. `--export-format pdf`
is an argument error for the same reason; naming `.pdf` in `/export x.pdf` or
`--export session.jsonl out.pdf` is the hint.

The HTML template gains a print block that reveals collapsed tool output,
thinking blocks, and compaction detail, and hides the help bar (keyboard hints,
toggle buttons, JSONL download — none of them exist on paper). That block is
what replaces a PDF renderer: without it, printing keeps only the collapsed
preview and the paper copy loses the half of the conversation that did the work.
The README, `docs/sessions.md` and `docs/cli.md` say so where a reader looks for
export.

## Alternatives considered

- Bundle a PDF engine (`export-pdf` as a component: playwright-core, puppeteer,
  or a bundled Chromium): this was built and shipped in PR
  [#186](https://cnb.cool/shinytale/nanopi/-/pull/186) and is now rejected.
  Driving a headless Chromium to print the HTML document is *correct* (one
  renderer, one theme, no drift) but the price is a 13.6 MiB optional engine, a
  browser that has to exist on the machine, a launch-probe chain with its own
  error messages, and an async export path. The browser's own Print dialog does
  the same job with no dependency at all. Issue #187 closes with that reasoning:
  "PDF 导出被「HTML + 浏览器打印」完全替代".
- Write a minimal PDF 1.4 writer instead (A4, Helvetica, one content stream per
  page): the first implementation in PR #186, rejected before the engine was
  tried. It produced a text document with no theme, dropped every character
  outside WinAnsi (CJK, emoji) and could not carry tool output as the browser
  renders it.
- Keep `export-pdf` as an alias that writes HTML and tells the user to print it:
  rejected — a format name that produces a different format is the exact bug
  this change removes. The refusal names the workflow instead; it does not
  pretend to have done it.
- Make Markdown and HTML one `export` component gated by suffix at runtime:
  rejected — that is the status quo with a worse name: `base` would ship the HTML
  templates it cannot offer.
- Render the PDF from the entries directly, or from the Markdown text: rejected —
  the first duplicates every message/entry case the HTML template already
  handles and would drift; the second throws away the styling the request is
  about.

## Consequences

- Benefit: the SKU ladder is expressible and enforced at build time; a trimmed
  build carries no code for a format it refuses, and no build carries a browser
  engine.
- Benefit: `full` and `base` install nothing extra. The 13.6 MiB
  `optionalDependencies: { "playwright-core" }` entry, its
  `createLazyImportDropPlugin` wiring, the `COMPONENT_DEPENDENCIES`
  (`export-pdf` needs `export-html`) rule and the single-file
  `resolveComponentSwitches` carve-out all went with the component.
- Cost: getting a PDF is a two-step manual workflow (export HTML, open, print).
  It is documented in the README, `docs/sessions.md` and `docs/cli.md`, and the
  refusal message names it.
- Cost: the Markdown renderer is a second reading of session entries next to the
  HTML template's JS. They share the file format, not the code, because one runs
  in Node and the other in the browser.
- Cost: `index-disabled.ts` must keep its export names in sync with the real
  `export-markdown` module; `validateComponentStubExports` fails the build when
  they drift.
- Verified end to end against real bundles in PR #186: `minimal` refuses md and
  html and copies jsonl; `base` writes md and refuses html; `full` writes both.
  Bundle sizes then: `full` 6.3 MiB, `base` 6.0 MiB, `minimal` 4.8 MiB.
- Tests: `test/export-markdown.test.ts`, `test/export-cli-theme.test.ts` (format
  resolution from the extension, `--export-format` override, the `.pdf` refusal),
  `scripts/buildconfig.test.mjs` (the flavor matrix) and
  `scripts/build-components.test.mjs` (stub wiring, the jiti lazy-import drop).
