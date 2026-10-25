# Agent Note: Split session export into Markdown and HTML, no PDF

Status: implemented

## Problem

Export had one switch and one output. `buildconfig.json`'s `export-html`
component decided whether export existed at all, and `--export` plus
`/export <path>` wrote HTML for every path that did not end in `.jsonl`, so
`nanopi --export session.jsonl out.md` produced an HTML file wearing a `.md`
name.

Issue #187 asks for a per-flavor capability surface instead:

- `minimal`: no export at all
- `base`: Markdown
- `full`: Markdown and HTML

and states the conclusion that a PDF is the HTML export printed by a browser,
so no PDF writer belongs in the tree. PR #186 (closed) had built the opposite:
an `export-markdown` renderer plus an `export-pdf` component whose first cut was
a hand-written PDF 1.4 writer and whose second cut drove a headless Chromium.
Both are gone from this change; only the Markdown half is reused.

The second half of the problem is what "a PDF is printed HTML" costs: the HTML
export keeps tool output, thinking, compaction detail, and the system prompt
behind a click, so a browser's print-to-PDF would have produced the collapsed
preview — the same information loss the dropped PDF renderer was trying to
avoid, reached by a different route.

## Decision

There are two export components, and a PDF is a print job.

`export-markdown` (`src/core/export-markdown/index.ts`) walks the session
branch in Node and renders one section per entry. Tool calls keep their name
and JSON arguments, tool results keep their text in a fenced block, and a fence
grows when the content already contains one (` ``` ` → ` ```` `) so a transcript
holding a code block does not break the document. Without the tool half a
transcript loses the part of the conversation that did the work.

`export-html` is unchanged as a component and stays the default format. Its
template gains a print block that reveals what the page hides behind a click:

```css
@media print {
  .tool-output.expandable .output-full { display: block !important; }
  .thinking-text { display: block !important; }
  .compaction .compaction-content { display: block !important; }
  .system-prompt .system-prompt-full { display: block !important; }
}
```

The `!important` flags are load-bearing: the toggles write an inline
`display`, so a rule without them loses to the page's own click state and
printing a collapsed page keeps it collapsed. The sidebar, hamburger, help bar,
and copy buttons leave in print — they are navigation and affordances, not
transcript.

Format resolution lives in one module, `src/core/session-export-formats.ts`,
because three entry points ask the same question: `--export` (extension, plus
`--export-format` to override), `/export`, and the new RPC `export_session`
command. A format a build does not carry fails with

    MD export is not included in this build (buildconfig.json component
    "export-markdown" is disabled)

rather than writing an empty file. `.jsonl` stays ungated: it is the session
file itself. `/export` disappears from autocomplete only when *every* format is
gone, which is the `minimal` flavor.

The Markdown renderer is imported statically by `agent-session` and by the CLI
entry, so `minimal` swaps it for `index-disabled.ts` at resolve time
(`COMPONENT_MODULES` in `scripts/build-components.mjs`) — the same mechanism
`syntax-highlight` and `jiti-modules` use, and `validateComponentStubExports`
keeps the stub's export names from drifting.

## Alternatives considered

- **Keep the hand-written PDF 1.4 writer from PR #186's first commit.** A4,
  Helvetica, per-page content streams, a real xref table, ~150 lines and no
  dependency. Rejected by the issue's own conclusion: WinAnsi-only text drops
  every CJK character and emoji, there is no theme, and it is a second renderer
  that has to be kept in step with the HTML template forever. Two renderers
  drift; one renderer printed twice does not.
- **Keep the headless-Chromium PDF from PR #186's second commit.** It renders
  the same document the HTML export writes, so it is the right document — at
  the cost of an optional `playwright-core` dependency, a browser binary the
  user has to have, and a launch probe across Chrome/Edge/Chromium with an
  env-var override. That is a supported subprocess surface inside a CLI whose
  `minimal` SKU is 4.8 MiB.
- **Keep `export-pdf` as a one-line "print this HTML" hint.** Not a format; the
  format table would carry an entry that writes nothing, and the RPC
  `export_session` command would answer `format: "pdf"` with a path to an
  unrelated file.
- **Gate export on a single component and infer the format from the output
  path at runtime.** That is the status quo with a new name: `minimal` would
  still ship the Markdown renderer and the HTML templates it cannot use.
- **Render Markdown through the HTML template's JS.** The template renders in
  the browser from a data payload; a `.md` file has to exist before any browser
  opens it. Running the template's JS in Node means a DOM shim and a second
  execution path for the same code.
- **Leave the print rules out and document "print the page".** Printing a
  fresh export produces the collapsed document, so the documented PDF workflow
  would silently lose tool output. The issue asked for the print rules
  specifically because they are the PDF path.

## Consequences

Verified against real single-file bundles built per flavor
(`NANOPI_BUILD_FLAVOR=<flavor> node scripts/build-coding-agent-single-file.mjs`):

| flavor | `.md` | `.html` | `.jsonl` |
|---|---|---|---|
| `full` | written | written | written |
| `base` | written | written | written |
| `minimal` | "not included in this build" | "not included in this build" | written |

Bundle sizes: `full` 9.8 MiB, `base` 5.5 MiB, `minimal` 2.5 MiB. The Markdown
renderer costs `base` about 3 KB of source; the print block costs `full` and
`base` about 1 KB of CSS.

`--export <session> <path>.jsonl` re-serializes the branch through
`exportSessionToJsonl` instead of returning the input path, so the documented
"copy the session" use still writes where the caller asked. A `.pdf` path now
resolves to no known format and therefore falls back to HTML; the file it
writes opens in a browser and prints, which is the workflow the README
describes.

The cost is that a user who wants a PDF has to leave the CLI: export HTML, open
it, print. Everything that made a built-in PDF attractive (one command, a file
that exists without a browser) is what the print rules replace, and the print
rules are why the browser path is a real substitute rather than a downgrade.

`docs/cli.md`, `docs/sessions.md`, `docs/slash-commands.md`, `docs/usage.md`,
`docs/rpc-commands.md`, `README.md`, and the CHANGELOG all state the browser
print step; `buildconfig.json`'s `export-html` description points at it too, so
the component nobody may drop is the one that carries the PDF story.
