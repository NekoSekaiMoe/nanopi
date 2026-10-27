#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

static atomic_int allocations, reads;
static atomic_bool released;

// Reuse the production headers and the production executor without pulling in
// X11: only the private-thread plumbing is under test, so the unit's X11 read
// is replaced with the stub below.
#include "../../native/src/napi-loader.h"
#include "../../native/src/clipboard.h"

// The fixture exercises the executor only, so the modifier query is never
// reached; clipboard.h still requires the unit to answer for it.
static bool clipboard_modifier_pressed(const char* name) {
    (void)name;
    return false;
}

// Count only what the executor allocates. The overrides below are textual, so
// the real libc calls are reached through differently named wrappers, and the
// prototypes have to exist before the executor block calls them.
static void* tracked_allocate(size_t count, size_t size);
static void tracked_free(void* pointer);
static void read_clipboard(clipboard_job* job);

static void* real_calloc(size_t count, size_t size) {
    return calloc(count, size);
}

static void real_free(void* pointer) {
    free(pointer);
}

#define calloc tracked_allocate
#define free tracked_free
#include "clipboard-worker-stub.c"
#undef calloc
#undef free

static void* tracked_allocate(size_t count, size_t size) {
    void* pointer = real_calloc(count, size);
    if (pointer) atomic_fetch_add(&allocations, 1);
    return pointer;
}

static void tracked_free(void* pointer) {
    if (pointer) atomic_fetch_sub(&allocations, 1);
    real_free(pointer);
}

// Exercise the production executor with a controlled blocking callback, without X11.
static void fixture_read(clipboard_job* job) {
    job->data = tracked_allocate(5, 1);
    assert(job->data);
    memcpy(job->data, "text", 4);
    job->length = 4;
    job->format = job->operation == CLIPBOARD_IMAGE ? CLIPBOARD_BUFFER : CLIPBOARD_UTF8;
    atomic_fetch_add(&reads, 1);
    while (!atomic_load(&released)) {
        struct timespec delay = {.tv_nsec = 1000000};
        nanosleep(&delay, 0);
    }
}

// The overrides cover the executor block only, so they stop before this one.
static void read_clipboard(clipboard_job* job) {
    fixture_read(job);
}

static napi_value release_reader(napi_env env, napi_callback_info info) {
    (void)info;
    atomic_store(&released, true);
    return undefined_value(env);
}

static napi_value get_state(napi_env env, napi_callback_info info) {
    (void)info;
    char state[80];
    pthread_mutex_lock(&worker_mutex);
    snprintf(state, sizeof(state), "%d,%d,%d", atomic_load(&reads), atomic_load(&allocations), worker_busy);
    pthread_mutex_unlock(&worker_mutex);
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_value result = 0;
    create_string(env, state, NAPI_AUTO_LENGTH, &result);
    return result;
}

NANOPI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    set_function_export(env, exports, "getText", get_clipboard_text);
    set_function_export(env, exports, "getImage", get_clipboard_image);
    set_function_export(env, exports, "release", release_reader);
    set_function_export(env, exports, "state", get_state);
    return exports;
}
