#ifndef NANOPI_NAPI_LOADER_H
#define NANOPI_NAPI_LOADER_H

// Resolve the small N-API surface we use from Node or Bun, without Node headers
// or a link-time dependency on a particular runtime. This is the only pair of
// headers that sees platform SDK headers, and it is included by the platform
// translation unit after them.
#include "napi.h"
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif

static void* node_symbol(const char* name) {
#ifdef _WIN32
    HMODULE module = GetModuleHandleA(0);
    void* proc = module ? (void*)GetProcAddress(module, name) : 0;
    if (proc) return proc;
    module = GetModuleHandleA("node.dll");
    return module ? (void*)GetProcAddress(module, name) : 0;
#else
    return dlsym(RTLD_DEFAULT, name);
#endif
}

static napi_value undefined_value(napi_env env) {
    napi_get_value_fn get_value = (napi_get_value_fn)node_symbol("napi_get_undefined");
    napi_value result = 0;
    if (get_value) get_value(env, &result);
    return result;
}

static napi_value null_value(napi_env env) {
    napi_get_value_fn get_value = (napi_get_value_fn)node_symbol("napi_get_null");
    napi_value result = 0;
    if (get_value) get_value(env, &result);
    return result;
}

static napi_value fail(napi_env env, const char* message) {
    napi_throw_error_fn napi_throw_error = (napi_throw_error_fn)node_symbol("napi_throw_error");
    if (napi_throw_error) napi_throw_error(env, 0, message);
    return undefined_value(env);
}

static void set_function_export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
    napi_create_function_fn napi_create_function = (napi_create_function_fn)node_symbol("napi_create_function");
    napi_set_named_property_fn napi_set_named_property =
        (napi_set_named_property_fn)node_symbol("napi_set_named_property");
    napi_value fn = 0;
    if (napi_create_function && napi_set_named_property &&
        napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, 0, &fn) == 0) {
        napi_set_named_property(env, exports, name, fn);
    }
}

#endif
