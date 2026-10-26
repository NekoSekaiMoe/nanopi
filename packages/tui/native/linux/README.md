# Linux clipboard helper

Provides asynchronous X11 text and image reads using `libxcb.so.1`. Prebuilds support x64 and arm64 on glibc and musl. Reads have bounded waits; if a native operation stalls, the helper remains unavailable until it finishes.

Coding-agent falls back to command-line tools when native reads are unavailable. Wayland reads use `wl-paste`; all Linux writes use the existing command-line or terminal clipboard paths.

## Building

Install a C compiler and XCB development headers, then run from the repository root on each supported Linux architecture:

```sh
npm --prefix packages/tui run build:native:linux
```

## Provenance

Prebuilds are committed, and CI never compiles them (a single runner cannot
produce all six platform/arch pairs). The build script prints the compiler
version, libxcb header version, and sha256 of the output; record them in the
commit message when the prebuilds change.

The current prebuilds are byte-identical to upstream pi's, which means they
were built from pi's `PI_CLIPBOARD` sources, not from the renamed
`NANOPI_CLIPBOARD` sources in this directory (`a7dc3429a` renamed the C
sources but did not rebuild). The `linux-arm64` and `linux-x64` files
differ, unlike darwin/win32, so they were built on two hosts and are not a
cross-build:

- linux-x64 `522d2550f7fa5d0d5bd204f45983f786ce2be9cf80f27f00179640d31d0689d6` (18008 bytes)
- linux-arm64 `63d4545349a25b5c97e352ea6d254cea50ff3c14161212ad3ddb3fc28022ddb5` (67240 bytes)

Both import only `libxcb.so.1` unversioned plus libc-through-PLT symbols
(`calloc`, `realloc`, `free`, `memcpy`, `poll`, `__errno_location`,
`clock_gettime`, `dlsym`, `pthread_*`), which is what `-nostdlib` +
`-Wl,--unresolved-symbols=ignore-all` buys: one file loads on both glibc and
musl, and symbols resolve lazily when the helper is `dlopen`ed.

`linux-platform-x11.c` includes `<stdlib.h>` itself; the shared
`clipboard.h` no longer supplies it, so a clean rebuild no longer triggers
`implicit declaration of function 'realloc'` under GCC 14 or newer.

## Layout

`napi.h` is the N-API surface only. `napi-loader.h` adds `windows.h`/`dlfcn.h`
and the symbol loader, and is included by the platform unit after its own SDK
headers. `clipboard.h` holds the async job and formats and exposes
`NANOPI_CLIPBOARD_ALLOC`/`_FREE`/`_COPY`/`_STRING_GETTER`/`_STRING_UNIT` as
overridable hooks, so no `#ifdef _WIN32` remains outside the win32 unit.
`xcb_poll_for_reply` is declared locally because `<xcb/xcbext.h>` only carries
that prototype and would make the build depend on the full libxcb headers.

## Testing

Install the build dependencies plus `pkg-config`, `Xvfb`, and `xclip`, then run from `packages/tui`:

```sh
node --test test/native-clipboard-linux.test.ts
```

Tests use isolated X11 servers, not the desktop clipboard. They skip when dependencies are missing.
