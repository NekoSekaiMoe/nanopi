#ifndef NANOPI_PLATFORM_PRELOAD_H
#define NANOPI_PLATFORM_PRELOAD_H

// Compile-time platform selection. The build passes one NANOPI_PLATFORM_* macro
// per artifact (see build-native.mjs, which derives it from the target triple),
// so a platform's headers and its .c/.m unit are only ever compiled into that
// platform's binary. -Werror without a selection keeps a prebuild from being
// produced with no platform at all.
#if defined(NANOPI_PLATFORM_LINUX)
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <dlfcn.h>
#include <xcb/xcb.h>
#elif defined(NANOPI_PLATFORM_DARWIN)
#include <stdlib.h>
#include <string.h>
#include <AppKit/AppKit.h>
#include <CoreGraphics/CoreGraphics.h>
#include <Foundation/Foundation.h>
#elif defined(NANOPI_PLATFORM_WIN32)
#include <stdint.h>
#include <windows.h>
#else
#error "Select a platform: -DNANOPI_PLATFORM_LINUX, -DNANOPI_PLATFORM_DARWIN or -DNANOPI_PLATFORM_WIN32"
#endif

// Only the selected unit is compiled. Each file declares its own leading
// comments and the preload provides the SDK headers they rely on.
#if defined(NANOPI_PLATFORM_LINUX)
#include "platform-linux.c"
#elif defined(NANOPI_PLATFORM_DARWIN)
#include "platform-darwin.m"
#elif defined(NANOPI_PLATFORM_WIN32)
#include "platform-win32.c"
#endif

#endif
