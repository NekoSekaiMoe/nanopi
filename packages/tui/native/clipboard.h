#ifndef NANOPI_CLIPBOARD_H
#define NANOPI_CLIPBOARD_H

// Mechanism shared by the three platform units: the async job, the formats a
// platform can report, and the N-API plumbing. Platform policy (allocator,
// buffer copy, which operations exist) is supplied by the unit through the
// NANOPI_CLIPBOARD_* macros before this header is included. Every helper here
// is `static` and used, so `-Werror` keeps the header honest.
#include <stdlib.h>
#include <string.h>
#include "napi-loader.h"

typedef enum { CLIPBOARD_TEXT, CLIPBOARD_IMAGE, CLIPBOARD_WRITE, CLIPBOARD_FILES } clipboard_operation;
// CLIPBOARD_PATHS stores concatenated, NUL-terminated UTF-8 paths in clipboard_job.data.
typedef enum {
    CLIPBOARD_UNAVAILABLE,
    CLIPBOARD_EMPTY,
    CLIPBOARD_UTF8,
    CLIPBOARD_LATIN1,
    CLIPBOARD_UTF16,
    CLIPBOARD_BUFFER,
    CLIPBOARD_PATHS
} clipboard_format;

typedef struct {
    napi_async_work work;
    napi_deferred deferred;
    clipboard_operation operation;
    clipboard_format format;
    void* data;
    size_t length;
    const char* error;
} clipboard_job;

// Only this function runs on the worker thread. It must not call N-API.
static void clipboard_execute(clipboard_job* job);

// Windows hands clipboard data over in HGLOBAL handles, so that unit overrides
// both. Hooks rather than #ifdef _WIN32 keeps the win32 knowledge in one file.
#ifndef NANOPI_CLIPBOARD_ALLOC
#define NANOPI_CLIPBOARD_ALLOC(size) calloc(1, (size))
#endif
#ifndef NANOPI_CLIPBOARD_FREE
#define NANOPI_CLIPBOARD_FREE(data) free(data)
#endif

static void* clipboard_alloc(size_t size) {
    return NANOPI_CLIPBOARD_ALLOC(size);
}

static void clipboard_free(void* data) {
    NANOPI_CLIPBOARD_FREE(data);
}

#ifdef NANOPI_CLIPBOARD_WRITE
static void clipboard_copy(clipboard_job* job, const void* data, size_t length, clipboard_format format) {
    job->data = clipboard_alloc(length ? length : 1);
    if (!job->data) {
        job->error = "Out of memory";
        return;
    }
#ifndef NANOPI_CLIPBOARD_COPY
#define NANOPI_CLIPBOARD_COPY(target, source, length) memcpy(target, source, length)
#endif
    NANOPI_CLIPBOARD_COPY(job->data, data, length);
    job->length = format == CLIPBOARD_UTF16 ? length / sizeof(uint16_t) : length;
    job->format = format;
}
#endif

static void NANOPI_NAPI_CALL execute_clipboard_work(napi_env env, void* data) {
    (void)env;
    clipboard_execute(data);
}

static int create_clipboard_paths_value(
    napi_env env,
    const clipboard_job* job,
    napi_create_string_utf8_fn create_string,
    napi_value* result
) {
    napi_create_array_fn create_array = (napi_create_array_fn)node_symbol("napi_create_array");
    napi_set_element_fn set_element = (napi_set_element_fn)node_symbol("napi_set_element");
    if (!create_array || !set_element || create_array(env, result) != 0) return 1;

    const char* cursor = job->data;
    const char* end = cursor + job->length;
    for (uint32_t index = 0; cursor < end; index++) {
        const char* terminator = cursor;
        while (terminator < end && *terminator != '\0') terminator++;
        if (terminator == end) return 1;

        napi_value item = 0;
        if (create_string(env, cursor, (size_t)(terminator - cursor), &item) != 0 ||
            set_element(env, *result, index, item) != 0) {
            return 1;
        }
        cursor = terminator + 1;
    }
    return 0;
}

static void NANOPI_NAPI_CALL complete_clipboard_work(napi_env env, int status, void* data) {
    clipboard_job* job = data;
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_value result = undefined_value(env);
    if (status != 0) job->error = "Clipboard operation cancelled";
    if (!job->error && job->operation != CLIPBOARD_WRITE) {
        if (job->format == CLIPBOARD_EMPTY) {
            result = null_value(env);
        } else if (job->format == CLIPBOARD_PATHS) {
            status = create_clipboard_paths_value(env, job, create_string, &result);
        } else if (job->format == CLIPBOARD_BUFFER) {
            napi_create_buffer_copy_fn create_buffer = (napi_create_buffer_copy_fn)node_symbol("napi_create_buffer_copy");
            status = create_buffer(env, job->length, job->data, 0, &result);
        } else if (job->format == CLIPBOARD_UTF16) {
            napi_create_string_utf16_fn create_utf16 = (napi_create_string_utf16_fn)node_symbol("napi_create_string_utf16");
            status = create_utf16(env, job->data, job->length, &result);
        } else if (job->format == CLIPBOARD_UTF8 || job->format == CLIPBOARD_LATIN1) {
            napi_create_string_utf8_fn create_text = job->format == CLIPBOARD_LATIN1
                ? (napi_create_string_utf8_fn)node_symbol("napi_create_string_latin1") : create_string;
            status = create_text(env, job->data, job->length, &result);
        }
        if (status != 0) job->error = "Could not create clipboard value";
    }
    if (job->error) {
        napi_create_error_fn create_error = (napi_create_error_fn)node_symbol("napi_create_error");
        napi_value message;
        create_string(env, job->error, NAPI_AUTO_LENGTH, &message);
        create_error(env, 0, message, &result);
    }
    napi_settle_deferred_fn settle = (napi_settle_deferred_fn)node_symbol(
        job->error ? "napi_reject_deferred" : "napi_resolve_deferred"
    );
    settle(env, job->deferred, result);
    napi_async_work_fn delete_work = (napi_async_work_fn)node_symbol("napi_delete_async_work");
    delete_work(env, job->work);
    clipboard_free(job->data);
    clipboard_free(job);
}

static napi_value queue_clipboard(napi_env env, napi_callback_info info, clipboard_operation operation) {
    napi_create_async_work_fn create_work = (napi_create_async_work_fn)node_symbol("napi_create_async_work");
    napi_async_work_fn queue_work = (napi_async_work_fn)node_symbol("napi_queue_async_work");
    napi_async_work_fn delete_work = (napi_async_work_fn)node_symbol("napi_delete_async_work");
    napi_create_promise_fn create_promise = (napi_create_promise_fn)node_symbol("napi_create_promise");
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    if (!create_work || !queue_work || !delete_work || !create_promise || !create_string) {
        return fail(env, "Async clipboard API unavailable");
    }
    clipboard_job* job = clipboard_alloc(sizeof(*job));
    if (!job) return fail(env, "Out of memory");
    job->operation = operation;
#ifdef NANOPI_CLIPBOARD_WRITE
    if (operation == CLIPBOARD_WRITE) {
        // Each unit names the N-API string getter its clipboard consumes and how
        // wide one code unit is: UTF-8 on POSIX, UTF-16 on Windows.
#ifndef NANOPI_CLIPBOARD_STRING_GETTER
#define NANOPI_CLIPBOARD_STRING_GETTER "napi_get_value_string_utf8"
#endif
#ifndef NANOPI_CLIPBOARD_STRING_UNIT
#define NANOPI_CLIPBOARD_STRING_UNIT sizeof(char)
#endif
        napi_get_cb_info_fn get_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
        napi_get_value_string_utf8_fn get_string =
            (napi_get_value_string_utf8_fn)node_symbol(NANOPI_CLIPBOARD_STRING_GETTER);
        const size_t unit_size = NANOPI_CLIPBOARD_STRING_UNIT;
        size_t argc = 1;
        napi_value argument = 0;
        if (!get_info || !get_string || get_info(env, info, &argc, &argument, 0, 0) != 0 || argc == 0 ||
            get_string(env, argument, 0, 0, &job->length) != 0) {
            clipboard_free(job);
            return fail(env, "setText requires a string");
        }
        job->data = job->length < SIZE_MAX / unit_size
            ? clipboard_alloc((job->length + 1) * unit_size) : 0;
        if (!job->data || get_string(env, argument, job->data, job->length + 1, &job->length) != 0) {
            clipboard_free(job->data);
            clipboard_free(job);
            return fail(env, "Could not read clipboard text");
        }
    }
#else
    (void)info;
#endif
    napi_value name = 0;
    napi_value promise = 0;
    if (create_string(env, "nanopi.clipboard", NAPI_AUTO_LENGTH, &name) != 0 ||
        create_work(env, 0, name, execute_clipboard_work, complete_clipboard_work, job, &job->work) != 0 ||
        create_promise(env, &job->deferred, &promise) != 0 || queue_work(env, job->work) != 0) {
        if (job->work) delete_work(env, job->work);
        clipboard_free(job->data);
        clipboard_free(job);
        return fail(env, "Could not queue clipboard operation");
    }
    return promise;
}

static napi_value NANOPI_NAPI_CALL get_clipboard_text(napi_env env, napi_callback_info info) {
    return queue_clipboard(env, info, CLIPBOARD_TEXT);
}

static napi_value NANOPI_NAPI_CALL get_clipboard_image(napi_env env, napi_callback_info info) {
    return queue_clipboard(env, info, CLIPBOARD_IMAGE);
}

#ifdef NANOPI_CLIPBOARD_WRITE
static napi_value NANOPI_NAPI_CALL set_clipboard_text(napi_env env, napi_callback_info info) {
    return queue_clipboard(env, info, CLIPBOARD_WRITE);
}
#endif

// Shared shell for isModifierPressed: argument marshalling and the boolean
// return are identical everywhere, only the platform query differs.
static bool clipboard_modifier_pressed(const char* name);

static napi_value NANOPI_NAPI_CALL is_modifier_pressed(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn get_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn get_string = (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    napi_get_boolean_fn get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");

    bool pressed = false;
    if (get_info && get_string) {
        size_t argc = 1;
        napi_value args[1] = {0};
        if (get_info(env, info, &argc, args, 0, 0) == 0 && argc >= 1 && args[0]) {
            // Modifier names are short and fixed; a longer string cannot match.
            char name[16] = {0};
            size_t copied = 0;
            if (get_string(env, args[0], name, sizeof(name), &copied) == 0) {
                pressed = clipboard_modifier_pressed(name);
            }
        }
    }

    napi_value result = 0;
    if (!get_boolean || get_boolean(env, pressed, &result) != 0) {
        return fail(env, "Could not inspect modifier state");
    }
    return result;
}

#endif
