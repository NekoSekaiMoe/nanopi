// An X11 property buffer is a plain malloc block, so the hooks keep the POSIX
// defaults, and the transfer is read-only in both directions.
#include "napi-loader.h"
#include "clipboard.h"

#define MAX_CLIPBOARD_BYTES (50u * 1024u * 1024u)
#define CLIPBOARD_TIMEOUT_MS 2000

static const char* const text_types[] = {
    "text/plain;charset=utf-8", "text/plain;charset=UTF-8", "UTF8_STRING", "text/plain", "STRING",
};
static const char* const image_types[] = {
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff",
};

static int64_t monotonic_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

typedef struct {
    unsigned char* data;
    size_t length;
    uint32_t items;
    uint8_t format;
    xcb_atom_t type;
} property_data;

typedef struct {
    xcb_connection_t* connection;
    xcb_window_t window;
    xcb_atom_t clipboard;
    xcb_atom_t property;
    xcb_atom_t targets;
    xcb_atom_t incr;
    int64_t deadline;
} x11_clipboard;

static bool append_bytes(property_data* result, const unsigned char* bytes, size_t length) {
    if (length > MAX_CLIPBOARD_BYTES - result->length) return false;
    unsigned char* data = realloc(result->data, result->length + length + 1);
    if (!data) return false;
    memcpy(data + result->length, bytes, length);
    result->length += length;
    data[result->length] = 0;
    result->data = data;
    return true;
}

// Share one deadline across discovery, replies, and incremental chunks.
// Connection setup and flushing are libxcb calls on the private thread.
static bool wait_for_input(x11_clipboard* clipboard) {
    for (;;) {
        int64_t remaining = clipboard->deadline - monotonic_ms();
        if (remaining <= 0 || xcb_connection_has_error(clipboard->connection)) return false;
        struct pollfd descriptor = {xcb_get_file_descriptor(clipboard->connection), POLLIN, 0};
        int ready = poll(&descriptor, 1, (int)remaining);
        if (ready >= 0) return ready && (descriptor.revents & POLLIN);
        if (errno != EINTR) return false;
    }
}

// Declared here instead of <xcb/xcbext.h>: that header only ever carries this one
// prototype, and skipping it drops a dependency on the versioned libxcb sources.
int xcb_poll_for_reply(xcb_connection_t* connection, unsigned int sequence, void** reply, xcb_generic_error_t** error);

static void* wait_for_reply(x11_clipboard* clipboard, unsigned sequence) {
    if (xcb_flush(clipboard->connection) <= 0) return 0;
    while (monotonic_ms() < clipboard->deadline) {
        void* reply = 0;
        xcb_generic_error_t* error = 0;
        if (xcb_poll_for_reply(clipboard->connection, sequence, &reply, &error)) {
            free(error);
            return reply;
        }
        if (!wait_for_input(clipboard)) break;
    }
    xcb_discard_reply(clipboard->connection, sequence);
    return 0;
}

static xcb_generic_event_t* wait_for_event(x11_clipboard* clipboard, uint8_t type) {
    if (xcb_flush(clipboard->connection) <= 0) return 0;
    while (monotonic_ms() < clipboard->deadline) {
        xcb_generic_event_t* event = xcb_poll_for_event(clipboard->connection);
        if (event) {
            if ((event->response_type & 0x7f) == type) return event;
            free(event);
        } else if (!wait_for_input(clipboard)) {
            break;
        }
    }
    return 0;
}

static bool read_property(x11_clipboard* clipboard, bool remove, property_data* result) {
    xcb_get_property_cookie_t cookie = xcb_get_property(
        clipboard->connection, remove, clipboard->window, clipboard->property,
        XCB_GET_PROPERTY_TYPE_ANY, 0, MAX_CLIPBOARD_BYTES / 4
    );
    xcb_get_property_reply_t* reply = wait_for_reply(clipboard, cookie.sequence);
    if (!reply) return false;
    bool copied = false;
    bool valid_format = reply->format == 8 || reply->format == 16 || reply->format == 32;
    uint64_t length = (uint64_t)reply->value_len * (reply->format / 8);
    if (reply->bytes_after == 0 && reply->type != XCB_NONE && valid_format &&
        length <= MAX_CLIPBOARD_BYTES && length <= (uint64_t)reply->length * 4) {
        result->type = reply->type;
        result->format = reply->format;
        result->items = reply->value_len;
        copied = append_bytes(result, xcb_get_property_value(reply), (size_t)length);
    }
    free(reply);
    return copied;
}

static bool append_property(property_data* result, const property_data* chunk) {
    if ((chunk->format != 8 && chunk->format != 16 && chunk->format != 32) ||
        chunk->type == XCB_NONE ||
        (uint64_t)chunk->items * (chunk->format / 8) != chunk->length ||
        (result->type != XCB_NONE && (result->type != chunk->type || result->format != chunk->format)) ||
        chunk->items > UINT32_MAX - result->items) return false;
    if (!append_bytes(result, chunk->data, chunk->length)) return false;
    result->type = chunk->type;
    result->format = chunk->format;
    result->items += chunk->items;
    return true;
}

static bool request_selection(x11_clipboard* clipboard, xcb_atom_t target, property_data* result) {
    memset(result, 0, sizeof(*result));
    xcb_delete_property(clipboard->connection, clipboard->window, clipboard->property);
    xcb_convert_selection(
        clipboard->connection, clipboard->window, clipboard->clipboard,
        target, clipboard->property, XCB_CURRENT_TIME
    );

    while (true) {
        xcb_selection_notify_event_t* event = (xcb_selection_notify_event_t*)wait_for_event(clipboard, XCB_SELECTION_NOTIFY);
        if (!event) return false;
        bool matches = event->selection == clipboard->clipboard && event->target == target;
        bool received = event->property != XCB_NONE;
        free(event);
        if (!matches) continue;
        if (!received) return true; // No owner, or the owner does not offer this target.
        if (!read_property(clipboard, false, result)) return false;
        break;
    }
    if (result->type != clipboard->incr) return true;

    free(result->data);
    memset(result, 0, sizeof(*result));
    xcb_delete_property(clipboard->connection, clipboard->window, clipboard->property);

    while (true) {
        xcb_property_notify_event_t* event = (xcb_property_notify_event_t*)wait_for_event(clipboard, XCB_PROPERTY_NOTIFY);
        if (!event) return false;
        bool matches = event->atom == clipboard->property && event->state == XCB_PROPERTY_NEW_VALUE;
        free(event);
        if (!matches) continue;

        property_data chunk = {0};
        if (!read_property(clipboard, true, &chunk)) return false;
        bool appended = append_property(result, &chunk);
        bool finished = chunk.items == 0;
        free(chunk.data);
        if (!appended) return false;
        if (finished) return true;
    }
}

static xcb_atom_t intern_atom(x11_clipboard* clipboard, const char* name) {
    xcb_intern_atom_cookie_t cookie = xcb_intern_atom(clipboard->connection, false, strlen(name), name);
    xcb_intern_atom_reply_t* reply = wait_for_reply(clipboard, cookie.sequence);
    if (!reply) return XCB_NONE;
    xcb_atom_t atom = reply->atom;
    free(reply);
    return atom;
}

static bool open_clipboard(x11_clipboard* clipboard) {
    memset(clipboard, 0, sizeof(*clipboard));
    clipboard->deadline = monotonic_ms() + CLIPBOARD_TIMEOUT_MS;
    int screen_number = 0;
    clipboard->connection = xcb_connect(0, &screen_number);
    if (xcb_connection_has_error(clipboard->connection)) return false;
    xcb_screen_iterator_t screens = xcb_setup_roots_iterator(xcb_get_setup(clipboard->connection));
    while (screen_number-- > 0 && screens.rem) xcb_screen_next(&screens);
    if (!screens.rem) return false;

    clipboard->window = xcb_generate_id(clipboard->connection);
    uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
    xcb_create_window(
        clipboard->connection, XCB_COPY_FROM_PARENT, clipboard->window,
        screens.data->root, 0, 0, 1, 1, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT,
        XCB_COPY_FROM_PARENT, XCB_CW_EVENT_MASK, &mask
    );
    clipboard->clipboard = intern_atom(clipboard, "CLIPBOARD");
    clipboard->property = intern_atom(clipboard, "NANOPI_CLIPBOARD");
    clipboard->targets = intern_atom(clipboard, "TARGETS");
    clipboard->incr = intern_atom(clipboard, "INCR");
    return clipboard->clipboard && clipboard->property && clipboard->targets && clipboard->incr;
}

static void close_clipboard(x11_clipboard* clipboard) {
    if (clipboard->connection) xcb_disconnect(clipboard->connection);
}

static bool preferred_target(x11_clipboard* clipboard, bool image, xcb_atom_t* target) {
    const char* const* types = image ? image_types : text_types;
    size_t type_count = image ? 6 : 5;
    xcb_atom_t wanted[6];
    for (size_t index = 0; index < type_count; index++) {
        wanted[index] = intern_atom(clipboard, types[index]);
        if (wanted[index] == XCB_NONE) return false;
    }

    property_data targets = {0};
    bool received = request_selection(clipboard, clipboard->targets, &targets);
    bool valid = targets.type == XCB_ATOM_ATOM && targets.format == 32 &&
        targets.items == targets.length / sizeof(xcb_atom_t) && targets.length % sizeof(xcb_atom_t) == 0;
    if (received && valid) {
        xcb_atom_t* offered = (xcb_atom_t*)targets.data;
        for (size_t wanted_index = 0; wanted_index < type_count; wanted_index++) {
            for (uint32_t offered_index = 0; offered_index < targets.items; offered_index++) {
                if (offered[offered_index] == wanted[wanted_index]) {
                    free(targets.data);
                    *target = wanted[wanted_index];
                    return true;
                }
            }
        }
    }
    free(targets.data);
    // Some owners refuse TARGETS but still serve text directly.
    if (received && !image && targets.type == XCB_NONE) {
        *target = intern_atom(clipboard, "UTF8_STRING");
        return *target != XCB_NONE;
    }
    return received && (valid || targets.type == XCB_NONE);
}

// Modifier state has to come from the X server keymap, not from a focused
// window: nanocode asks while the terminal owns focus. Only core X requests are
// used, so the prebuild keeps importing nothing but libxcb.so.1. The keysyms are
// protocol constants written out here (0xffe1 Shift_L, 0xffe3 Control_L, 0xffe9
// Alt_L, 0xffeb Super_L) because X11/keysymdef.h ships with libX11, not libxcb.
static xcb_keysym_t modifier_keysym(const char* name) {
    if (!name) return XCB_NO_SYMBOL;
    if (strcmp(name, "shift") == 0) return 0xffe1;
    if (strcmp(name, "control") == 0) return 0xffe3;
    if (strcmp(name, "option") == 0 || strcmp(name, "alt") == 0) return 0xffe9;
    if (strcmp(name, "command") == 0 || strcmp(name, "super") == 0 || strcmp(name, "win") == 0) return 0xffeb;
    return XCB_NO_SYMBOL;
}

// The left-hand keysym of every keycode, i.e. the one a modifier reports with no
// shift level applied.
static bool find_keycode(xcb_connection_t* connection, xcb_keysym_t keysym, xcb_keycode_t* keycode) {
    const xcb_setup_t* setup = xcb_get_setup(connection);
    unsigned first = setup->min_keycode;
    unsigned count = (unsigned)(setup->max_keycode - setup->min_keycode) + 1u;
    xcb_get_keyboard_mapping_reply_t* reply =
        xcb_get_keyboard_mapping_reply(connection, xcb_get_keyboard_mapping(connection, first, count), 0);
    if (!reply) return false;
    xcb_keysym_t* keysyms = xcb_get_keyboard_mapping_keysyms(reply);
    bool found = false;
    if (keysyms) {
        unsigned per_keycode = reply->keysyms_per_keycode;
        for (unsigned index = 0; per_keycode && index < count && !found; index++) {
            if (keysyms[index * per_keycode] == keysym) {
                *keycode = (xcb_keycode_t)(first + index);
                found = true;
            }
        }
    }
    free(reply);
    return found;
}

static bool clipboard_modifier_pressed(const char* name) {
    xcb_keysym_t keysym = modifier_keysym(name);
    if (keysym == XCB_NO_SYMBOL) return false;

    // A separate connection keeps this off the clipboard worker's deadline and
    // mutex. Any failure reports "not pressed", like the other platform units.
    xcb_connection_t* connection = xcb_connect(0, 0);
    if (xcb_connection_has_error(connection)) {
        xcb_disconnect(connection);
        return false;
    }

    bool pressed = false;
    xcb_keycode_t keycode = 0;
    if (find_keycode(connection, keysym, &keycode)) {
        xcb_query_keymap_reply_t* reply = xcb_query_keymap_reply(connection, xcb_query_keymap(connection), 0);
        if (reply) {
            unsigned byte = (unsigned)keycode / 8u;
            if (byte < sizeof(reply->keys)) pressed = (reply->keys[byte] & (1u << (keycode % 8u))) != 0;
            free(reply);
        }
    }
    xcb_disconnect(connection);
    return pressed;
}

static bool read_selection(x11_clipboard* clipboard, bool image, property_data* result) {
    xcb_atom_t target = XCB_NONE;
    bool received = preferred_target(clipboard, image, &target) &&
        (target == XCB_NONE || request_selection(clipboard, target, result));
    if (!received) {
        free(result->data);
        memset(result, 0, sizeof(*result));
    }
    return received;
}

static void read_clipboard(clipboard_job* job);

// X requests block on the server, so each read runs on a private thread and the
// caller waits on a condition variable for at most WORKER_WAIT_SECONDS. A read
// that outlives that wait keeps the helper busy until it returns; callers in the
// meantime report the clipboard as unavailable instead of queueing behind it.
#define WORKER_WAIT_SECONDS 3 // Allow the two-second transfer deadline to report its own error first.

static pthread_mutex_t worker_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t worker_once = PTHREAD_ONCE_INIT;
static pthread_cond_t worker_changed;
static bool worker_ready, worker_busy, worker_waiting, worker_finished;
static clipboard_job worker_result;
static int (*signal_worker)(pthread_cond_t*);
static int (*wait_for_worker)(pthread_cond_t*, pthread_mutex_t*, const struct timespec*);

static void initialize_worker_condition(void) {
    // Unversioned ELF imports otherwise bind obsolete condition variables on glibc x64.
    int (*initialize)(pthread_cond_t*, const pthread_condattr_t*) = node_symbol("pthread_cond_init");
    signal_worker = node_symbol("pthread_cond_signal");
    wait_for_worker = node_symbol("pthread_cond_timedwait");
    if (!initialize || !signal_worker || !wait_for_worker) return;
    pthread_condattr_t attributes;
    if (pthread_condattr_init(&attributes) != 0) return;
    worker_ready = pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC) == 0 &&
        initialize(&worker_changed, &attributes) == 0;
    pthread_condattr_destroy(&attributes);
}

static void* read_on_private_thread(void* unused) {
    (void)unused;
    read_clipboard(&worker_result);
    pthread_mutex_lock(&worker_mutex);
    worker_finished = true;
    if (!worker_waiting) {
        free(worker_result.data); // The caller timed out; discard the late result.
        worker_busy = false;
    }
    signal_worker(&worker_changed);
    pthread_mutex_unlock(&worker_mutex);
    return 0;
}

static void clipboard_execute(clipboard_job* job) {
    pthread_once(&worker_once, initialize_worker_condition);
    if (!worker_ready) return;
    pthread_mutex_lock(&worker_mutex);
    if (!worker_busy) {
        worker_busy = worker_waiting = true;
        worker_finished = false;
        worker_result = (clipboard_job){.operation = job->operation};
        struct timespec deadline;
        clock_gettime(CLOCK_MONOTONIC, &deadline);
        deadline.tv_sec += WORKER_WAIT_SECONDS;
        pthread_t thread;
        if (pthread_create(&thread, 0, read_on_private_thread, 0) == 0) {
            pthread_detach(thread);
            // Only this bounded wait occupies libuv. Other callers return unavailable.
            while (!worker_finished && wait_for_worker(&worker_changed, &worker_mutex, &deadline) == 0) {}
            if (worker_finished) {
                job->data = worker_result.data;
                job->length = worker_result.length;
                job->format = worker_result.format;
                job->error = worker_result.error;
                // Clear worker_waiting before anyone else signals: left set, the
                // next detached read treats the published buffer as a timed-out
                // leftover and frees it, and the helper stays busy.
                worker_waiting = false;
                worker_busy = false;
            }
        } else {
            worker_busy = false;
        }
        worker_waiting = false;
    }
    pthread_mutex_unlock(&worker_mutex);
}

static void read_clipboard(clipboard_job* job) {
    x11_clipboard clipboard;
    if (open_clipboard(&clipboard)) {
        property_data contents = {0};
        if (!read_selection(&clipboard, job->operation == CLIPBOARD_IMAGE, &contents)) {
            job->error = "Could not read X11 clipboard";
        } else {
            job->data = contents.data;
            job->length = contents.length;
            job->format = !contents.data ? CLIPBOARD_EMPTY : job->operation == CLIPBOARD_IMAGE
                ? CLIPBOARD_BUFFER : contents.type == XCB_ATOM_STRING ? CLIPBOARD_LATIN1 : CLIPBOARD_UTF8;
        }
    }
    close_clipboard(&clipboard);
}

NANOPI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    set_function_export(env, exports, "getText", get_clipboard_text);
    set_function_export(env, exports, "getImage", get_clipboard_image);
    return exports;
}
