# Agent Note: `esbuildDetection` keeps undici's Milo parser out of the bundle

Status: implemented

## Problem

Issue #535 asked why `minimal` went from 2.4 MiB back to 2.7 MiB. The
re-measurement put the growth on two dependency bumps, and one of them is not a
size trade at all — it is a branch undici expected a bundler to delete and that
never got deleted.

undici 8.12 (bumped by `30503ced1`, 10-26) moved its HTTP/1 parser behind a
compile-time-looking guard:

```js
const { H1Parser, getMiloEnabled } = typeof esbuildDetection === 'undefined'
  ? require('./parser-h1.js')
  : {}
```

`esbuildDetection` is a bare identifier nobody defines. esbuild only folds
`typeof x` when `x` is a known define or a real global, so `typeof
esbuildDetection === 'undefined'` stayed in the graph as a runtime check and
both sides shipped: `lib/milo/simd.js` (81836 B) + `lib/milo/no-simd.js`
(79775 B) + `lib/dispatcher/parser-h1.js` (28618 B), 182 KiB of input,
162 KiB of output.

The Milo payload is unreachable in that build. `miloEnabled` is
`process.env.UNDICI_USE_MILO === '1'` and nothing sets it, so `client-h1.js`
always constructs the llhttp `Parser`; `getMilo()` (the only caller of the
`require`s) never runs. The same guard in `web/fetch/index.js` also made
`defaultUserAgent` resolve to `'undici'` instead of `'node'`, which is a
behavior difference, not just bytes.

## Decision

`buildDefines()` (`scripts/esbuild-shared.mjs`) defines `esbuildDetection:
"true"` for both coding-agent bundles. Not `"undefined"`: the identifier's
presence is what undici tests for, so any defined value selects the bundled
branch — the same one Node's own undici build takes, where the identifier is
absent and the guard is compiled out.

It lives in the shared define map rather than the single-file script because
the npm bundle has the same dead branch; the two builds are the reason that
function exists.

Measured with `NANOPI_BUILD_FLAVOR=minimal node
scripts/build-coding-agent-single-file.mjs`:

```
minimal   2821501 B -> 2655141 B   -162.4 KiB
base      7037417 B -> 6071897 B   -0.92 MiB
full     10212986 B -> 10048548 B  -0.16 MiB
```

The `minimal` delta is the whole set of files above: esbuild reported 194787 B
of removed input against 166360 B of removed output, because the WASM payload
is two near-identical base64 strings that minify into a much smaller
literal.

## Alternatives considered

- **Keep `undici` pinned below 8.12.** The new parser is the only reason the
  files exist, but pinning also pins the security fixes in the dispatcher, and
  the branch is dead in the bundle regardless of version.
- **Define `esbuildDetection: "undefined"` "to match".** It still leaves
  `NANOPI_BUNDLED_NODE`-style behavior gaps: the identifier exists either way,
  so the only effect of the string is to leave undici on the path it was
  already taking. No byte changes.
- **Ship Milo on purpose.** `UNDICI_USE_MILO=1` is the escape hatch for a
  native Node build; a single-file artifact cannot recover the WASM files it
  would need at runtime from a package that is not installed.
- **Alias `undici/lib/milo/*` to an empty module.** Leaves `parser-h1.js` and
  its `setup()` calls in the graph and breaks at runtime if anyone flips the
  env var. The define removes the branch that references them at all.

## Consequences

- `minimal` is 2.53 MiB, down from 2.69 MiB. The rest of the #535 regression is `openai` 7.52
  (279 -> 398 KiB input in `minimal`), which needs build-time knowledge of the
  narrowed `apis` set; tracked separately in #541.
- `defaultUserAgent` in the bundles is `'node'`, matching undici's documented
  bundled-build behavior. Any proxy or WAF rule keyed on `undici` as a UA
  stops matching in the built artifacts.
- `UNDICI_USE_MILO=1` is inert in both bundles; undici's experimental parser
  is not reachable from a nanopi build. Its WASM payload was never loadable
  from a single file anyway.
- `scripts/esbuild-shared.test.mjs` pins the define's presence and its `"true"`
  value, so a later "cleanup" of the define map has to argue with the test.
