# Darwin native prebuilds

Provides modifier-key state and asynchronous text, image, and file-path clipboard access using AppKit.

## Building

On macOS, run from the repository root:

```sh
npm --prefix packages/tui run build:native:darwin
```

The build uses Apple clang and the macOS SDK found through `xcrun`. Either Intel or Apple Silicon can build both targets: arm64 (macOS 11+) and x64 (macOS 10.15+).

Cross-building requires a Darwin toolchain with a macOS SDK and Mach-O linker, such as osxcross:

```sh
CC=/path/to/osxcross/clang SDKROOT=/path/to/MacOSX.sdk \
  npm --prefix packages/tui run build:native:darwin
```

The SDK must be obtained and used under Apple's license. Plain clang or Zig alone is not sufficient.

## Provenance

Prebuilds are committed, and CI never compiles them (a single runner cannot
produce all six platform/arch pairs). The build script prints the compiler
version, SDK path, and sha256 of each output; record them in the commit
message when the prebuilds change.

The current prebuilds (byte-identical to upstream pi's) report:

- darwin-arm64 `36e909adf35c2734a2a52b3d65b7dbfb83f2278f306d51b7e32c5045516dfb7f` (52024 bytes, minos 11.0, SDK 26.2)
- darwin-x64 `7ec59a02fff9562f6354274ad070ba35f8e0998b3b111eb27ad3de579ffb6c65` (22784 bytes)

They link `AppKit`, `CoreGraphics`, `Foundation`, `libobjc`, and
`libSystem`; `-undefined dynamic_lookup` leaves the N-API symbols for Node
to supply.
