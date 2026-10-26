# Native platform helper

One N-API module, compiled per platform/arch into
`<platform>/prebuilds/<platform>-<arch>/tui-platform.node`. Everything that
differs between platforms is a compile-time flag, not a directory of sources.

Provides asynchronous text and image clipboard reads, text writes where the OS
supports them, and modifier-key state. Prebuilds support x64 and arm64 on
darwin, linux (glibc and musl), and win32.

Coding-agent falls back to command-line tools when native reads are unavailable.
Wayland reads use `wl-paste`; all Linux writes use the existing command-line or
terminal clipboard paths.

## Layout

`src/` holds every source file:

- `platform-preload.h` - the only file the build compiles. It includes the
  selected platform's SDK headers and then includes that platform's unit, both
  chosen by `NANOPI_PLATFORM_LINUX`, `NANOPI_PLATFORM_DARWIN`, or
  `NANOPI_PLATFORM_WIN32`. Without one of those macros it fails with `#error`.
- `platform-linux.c`, `platform-darwin.m`, `platform-win32.c` - one unit per
  platform. Each is the only file that knows its own OS.
- `napi.h` - the N-API surface only: types, calling conventions, export macro.
- `napi-loader.h` - `napi.h` plus `windows.h`/`dlfcn.h` and the runtime symbol
  loader, so nothing links Node headers.
- `clipboard.h` - the async job, the formats a platform can report, and the
  N-API plumbing. Platform policy (allocator, buffer copy, which operations
  exist) arrives through the `NANOPI_CLIPBOARD_*` macros the selected unit
  defines before including it.

The darwin unit compiles as Objective-C; the other two as C.

## Building

Run from the repository root, naming the platforms whose prebuilds you want:

```sh
npm --prefix packages/tui run build:native:linux     # -DNANOPI_PLATFORM_LINUX
npm --prefix packages/tui run build:native:darwin    # -DNANOPI_PLATFORM_DARWIN
npm --prefix packages/tui run build:native:win32     # -DNANOPI_PLATFORM_WIN32
npm --prefix packages/tui run build:native           # host platform
```

`node packages/tui/native/build-native.mjs <platform> [...]` also takes
`--arch <arch>` to build a single architecture.

Requirements per platform:

- linux: a C compiler, `pkg-config`, and the xcb headers
  (`libxcb1-dev` / `libxcb-devel`). The unit builds with `-nostdlib` +
  `-Wl,--unresolved-symbols=ignore-all`, so one file imports only
  `libxcb.so.1` unversioned plus PLT libc symbols (`calloc`, `realloc`, `free`,
  `memcpy`, `poll`, `__errno_location`, `clock_gettime`, `dlsym`,
  `pthread_*`) and loads on glibc and musl alike.
- darwin: Apple clang and the macOS SDK found through `xcrun`. Either
  architecture can build both targets. Cross-building needs a Darwin toolchain
  with a macOS SDK and Mach-O linker (osxcross): set `CC` and `SDKROOT`. The SDK
  must be obtained and used under Apple's license; plain clang or Zig is not
  sufficient.
- win32: Visual Studio's "Desktop development with C++" workload, or
  MinGW-compatible compilers via `NANOPI_TUI_WIN32_TOOLCHAIN=mingw` and
  `CC_X64` / `CC_ARM64`.

`CC` overrides the compiler everywhere, and `SDKROOT` overrides the darwin SDK.

## Provenance

Prebuilds are committed, and CI never compiles them (a single runner cannot
produce all six platform/arch pairs). The build script prints the compiler
version, SDK/header versions, and sha256 of each output; record them in the
commit message when the prebuilds change.

The current prebuilds were built from the sources in `src/`. The linux x64 and
arm64 files differ, unlike darwin and win32, so they are per-arch builds rather
than a cross-build; record both hashes when the C sources, not the file names,
change.

## Testing

Install `pkg-config`, `Xvfb`, and `xclip` for the Linux clipboard tests, then
run from `packages/tui`:

```sh
node --test test/native-clipboard-linux.test.ts
node --test test/native-platform.test.ts
```

The Linux tests use isolated X11 servers, not the desktop clipboard, and skip
when dependencies are missing. `test/fixtures/clipboard-x11-test.c` compiles
`src/platform-preload.h` directly, so it exercises the real unit. On a Windows
test desktop, `NANOPI_TEST_NATIVE_CLIPBOARD=1 node --test
test/native-platform.test.ts` checks native text writes; **it replaces the
system clipboard contents.**
