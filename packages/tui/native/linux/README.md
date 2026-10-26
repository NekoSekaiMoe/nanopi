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

The current prebuilds were built from the sources in this directory, so they
carry the `NANOPI_CLIPBOARD` property atom and `nanopi.clipboard` N-API entry
introduced by `a7dc3429a`. The `linux-arm64` and `linux-x64` files differ,
unlike darwin/win32, so they are per-arch builds, not a cross-build:

- linux-x64 `591c3419461b00af2ac6e795cab4c094df3441f566a063671e7f1e4f3c7bf190` (18008 bytes, gcc 12.2.0, xcb 1.15)
- linux-arm64 `787d38a3ea7af6d9cf86b21db1d8fd477de494e68f02da85e5bb4875539dbd37` (67232 bytes, aarch64-linux-gnu-gcc 12.2.0, xcb 1.15)

Both import only `libxcb.so.1` unversioned plus libc-through-PLT symbols
(`calloc`, `realloc`, `free`, `memcpy`, `poll`, `__errno_location`,
`clock_gettime`, `dlsym`, `pthread_*`), which is what `-nostdlib` +
`-Wl,--unresolved-symbols=ignore-all` buys: one file loads on both glibc and
musl, and symbols resolve lazily when the helper is `dlopen`ed.

`linux-platform-x11.c` calls `realloc` and `free` directly, so it includes
`<stdlib.h>` for them. It previously reached `<stdlib.h>` only through
`clipboard-worker.h` -> `clipboard.h`, which happened to work on glibc but made
the file depend on a header it never included.

## Testing

Install the build dependencies plus `pkg-config`, `Xvfb`, and `xclip`, then run from `packages/tui`:

```sh
node --test test/native-clipboard-linux.test.ts
```

Tests use isolated X11 servers, not the desktop clipboard. They skip when dependencies are missing.
