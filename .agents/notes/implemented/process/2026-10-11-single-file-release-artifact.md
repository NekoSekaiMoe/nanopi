# Agent Note: Single-file nanopi.js release artifact and Bun removal

Status: implemented

## Problem

The standalone distribution was six per-platform Bun-compiled executables
(`nanopi-<os>-<arch>.tar.gz/zip`, ~10s of MB each) built by `bun build
--compile`. Bun forced permanent runtime workarounds in source code: an empty-
`process.env` sandbox rescue (bun#27802), a `fs.readFileSync` patch plus
wasm-copy step for photon, a string-path worker resolution branch, a websocket
proxy wrapper (bun#15489), and `isBunBinary` branches in config/asset path
resolution. The npm package and the binary also diverged: separate entries
(`src/bun/cli.ts` vs `src/cli.ts`), separate asset copying, and a release
workflow that still expected `pi-coding-agent-install-package.json` files
nothing produced (stale since the pi.dev severance).

## Decision

Node/esbuild only. The release artifact is one zero-dependency `nanopi.js`
(15.7 MiB) built by `scripts/build-coding-agent-single-file.mjs` from
`packages/coding-agent/dist/standalone/cli.js`:

- **Import order is the entry contract** (`src/standalone/cli.ts`):
  `assets.ts` (extract embedded assets, set `NANOPI_PACKAGE_DIR`, set
  `NANOPI_TUI_NATIVE_ROOT`) must evaluate before anything imports `config.ts`,
  because `config.ts` resolves the package dir at module init. That is why
  `assets.ts` may import Node builtins only and mirrors `getAgentDir()`
  locally instead of importing it.
- **Assets ride as data, not files**: themes, export-html templates, webui
  dist, docs, examples, package.json are gzip+base64 JSON injected via the
  `NANOPI_SINGLE_FILE_ASSETS` define, extracted to
  `<cache>/nanopi/standalone/<version>` with a `.complete` marker and
  staging-dir rename. All existing `config.ts` path helpers keep working
  unchanged through `NANOPI_PACKAGE_DIR`.
- **Variable-specifier lazy modules are statically registered**: OAuth flows
  and the Bedrock APIs load through variable imports that bundlers must not
  follow (browser smoke isolation). `src/standalone/runtime-setup.ts` imports
  them statically and registers via `registerBundledOAuthFlows()` /
  `setBedrock*ProviderModule()`, same mechanism the Bun entry used.
- **jiti is bundled through `jiti/static`** (the npm bundle instead rewrites
  it to a lazy `require("jiti")`; the single-file build must not, there is no
  `node_modules` at runtime). Extension loading verified end-to-end in the
  artifact with a TypeScript extension.
- The banner defines `require`/`__filename`/`__dirname` because photon's CJS
  entry resolves its wasm via `readFileSync(path.join(__dirname, ...))`.
- Bun is deleted outright (runtime detection, workarounds, `src/bun/`,
  `build:binary`, `build-binaries.sh`, bun install consumer, workflow setup
  step). Extension *installation* still accepts bun as the user's package
  manager (`package-manager.ts`); that is about the user's toolchain, not our
  runtime.

## Sidecar downloads instead of embedded payloads

The photon wasm (1.8 MB, universal) and TUI native prebuilds (~250 KB,
per os/arch) are not embedded; they are downloaded on demand into the agent
bin dir (`.nanopi/agent/bin`) by `src/utils/sidecars.ts`:

- The manifest (npm tarball URLs + per-file sha256, hashed from local files at
  build time) is injected via the `NANOPI_SIDECARS` define and inert in npm
  installs (manifest absent → every function no-ops).
- Photon wasm comes from the public npm registry
  (`@silvia-odwyer/photon-node@0.3.4` tarball) — available regardless of
  whether this fork has cut a release, so local/unreleased builds keep image
  resizing. `photon.ts` falls back to the bin-dir path and awaits the sidecar
  before its first load.
- TUI prebuilds come from the same GitHub release that ships `nanopi.js`
  (`nanopi-sidecars-<version>.tgz`, emitted next to the artifact). This fork's
  `@nanopi/*` packages are not on the public registry (404), so the registry
  is not a source for them. Unreleased builds 404 → no native clipboard/key
  modifiers, with a one-line stderr warning.
- `pi-tui` gained the `NANOPI_TUI_NATIVE_ROOT` lookup root and stops
  negative-caching native lookups while it is set, so a download landing
  mid-session is picked up.

## Alternatives considered

- **Base64-embed the photon wasm** (+2.4 MiB): rejected by the user in favor
  of downloads; embedding remains the fallback if the sidecar path proves
  fragile (offline-first users would need `NANOPI_OFFLINE` awareness anyway).
- **Pure-TypeScript image codecs** (vendor jpeg-js, hand-written PNG/GIF/BMP,
  drop webp resizing): keeps every byte in JS but costs thousands of lines and
  3-10x slower JPEG decode; the wasm sidecar keeps one code path for npm and
  single-file distributions.
- **Keep per-platform Bun binaries alongside nanopi.js**: rejected — it keeps
  the Bun workarounds alive, which was most of the motivation.
- **`NANOPI_PACKAGE_DIR` assets as separate sidecar download**: rejected;
  assets are required for correct theming/webui/docs on first run and gzip
  well (4.1 MiB for 249 files), while wasm/`.node` payloads are the big,
  latency-tolerant part.

## Consequences

- Release assets: `nanopi-<version>-source.tar.gz`, `nanopi.js`,
  `nanopi-sidecars-<version>.tgz`, `SHA256SUMS` (the stale
  `pi-coding-agent-install-package.json` expectations are gone). Smoke tests
  run `node nanopi.js --help/--version` on Linux/macOS/Windows.
- `@nanopi/pi-ai` breaking rename `./bun-oauth` → `./bundled-oauth`.
- Image resize in single-file mode runs in-process (the worker file cannot be
  resolved from one file), briefly blocking the event loop; the npm bundle
  keeps its worker. A follow-up could ship the worker inside the sidecar
  tarball.
- First run needs the network for image resizing and native accelerators;
  offline runs degrade to raw images and no clipboard, never crash. The
  `image-resize` worker URL still falls back cleanly when absent.
- `dist/standalone/*` ships in the npm package as inert dead weight (a few
  KB); the same precedent as the old `dist/bun/`.

Related: [webui port](../architecture/2026-10-11-port-atomcode-webui.md) (its
`dist/webui` output is one of the embedded asset trees).
