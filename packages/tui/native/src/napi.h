#ifndef NANOPI_NAPI_H
#define NANOPI_NAPI_H

// Pure N-API surface: types, calling conventions, and export convention. Nothing
// here touches the OS, so it compiles unchanged on linux, darwin, and win32.
// Platform headers (windows.h, dlfcn.h, ...) belong in napi-loader.h, which only
// the loader uses.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef _WIN32
#define NANOPI_NAPI_CALL __cdecl
#define NANOPI_NAPI_EXPORT __declspec(dllexport)
#else
#define NANOPI_NAPI_CALL
#define NANOPI_NAPI_EXPORT __attribute__((visibility("default")))
#endif

#define NAPI_AUTO_LENGTH ((size_t)-1)

typedef void* napi_env;
typedef void* napi_value;
typedef void* napi_callback_info;
typedef void* napi_async_work;
typedef void* napi_deferred;
typedef void (NANOPI_NAPI_CALL *napi_async_execute_callback)(napi_env, void*);
typedef void (NANOPI_NAPI_CALL *napi_async_complete_callback)(napi_env, int, void*);
typedef int (NANOPI_NAPI_CALL *napi_create_async_work_fn)(napi_env, napi_value, napi_value, napi_async_execute_callback, napi_async_complete_callback, void*, napi_async_work*);
typedef int (NANOPI_NAPI_CALL *napi_create_array_fn)(napi_env, napi_value*);
typedef int (NANOPI_NAPI_CALL *napi_async_work_fn)(napi_env, napi_async_work);
typedef int (NANOPI_NAPI_CALL *napi_create_promise_fn)(napi_env, napi_deferred*, napi_value*);
typedef int (NANOPI_NAPI_CALL *napi_settle_deferred_fn)(napi_env, napi_deferred, napi_value);
typedef int (NANOPI_NAPI_CALL *napi_create_error_fn)(napi_env, napi_value, napi_value, napi_value*);
typedef napi_value (NANOPI_NAPI_CALL *napi_callback)(napi_env, napi_callback_info);
typedef int (NANOPI_NAPI_CALL *napi_create_buffer_copy_fn)(napi_env, size_t, const void*, void**, napi_value*);
typedef int (NANOPI_NAPI_CALL *napi_create_function_fn)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
typedef int (NANOPI_NAPI_CALL *napi_create_string_utf8_fn)(napi_env, const char*, size_t, napi_value*);
typedef int (NANOPI_NAPI_CALL *napi_create_string_utf16_fn)(napi_env, const uint16_t*, size_t, napi_value*);
typedef int (NANOPI_NAPI_CALL *napi_get_boolean_fn)(napi_env, bool, napi_value*);
typedef int (NANOPI_NAPI_CALL *napi_get_cb_info_fn)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
typedef int (NANOPI_NAPI_CALL *napi_get_value_fn)(napi_env, napi_value*);
typedef int (NANOPI_NAPI_CALL *napi_get_value_string_utf8_fn)(napi_env, napi_value, char*, size_t, size_t*);
typedef int (NANOPI_NAPI_CALL *napi_get_value_string_utf16_fn)(napi_env, napi_value, uint16_t*, size_t, size_t*);
typedef int (NANOPI_NAPI_CALL *napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
typedef int (NANOPI_NAPI_CALL *napi_set_element_fn)(napi_env, napi_value, uint32_t, napi_value);
typedef int (NANOPI_NAPI_CALL *napi_throw_error_fn)(napi_env, const char*, const char*);

#endif
