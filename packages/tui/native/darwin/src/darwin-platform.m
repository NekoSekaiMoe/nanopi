#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#define NANOPI_CLIPBOARD_WRITE
#include "../../clipboard.h"

static CGEventFlags modifier_mask_for_name(const char* name) {
    if (strcmp(name, "shift") == 0) return kCGEventFlagMaskShift;
    if (strcmp(name, "command") == 0) return kCGEventFlagMaskCommand;
    if (strcmp(name, "control") == 0) return kCGEventFlagMaskControl;
    if (strcmp(name, "option") == 0) return kCGEventFlagMaskAlternate;
    return 0;
}

static bool clipboard_modifier_pressed(const char* name) {
    CGEventFlags mask = modifier_mask_for_name(name);
    if (mask == 0) return false;
    return (CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState) & mask) != 0;
}

static void clipboard_execute(clipboard_job* job) {
    @autoreleasepool {
        NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
        if (!pasteboard) {
            job->error = "Could not open clipboard";
        } else if (job->operation == CLIPBOARD_WRITE) {
            NSString* text = [[NSString alloc] initWithBytes:job->data length:job->length encoding:NSUTF8StringEncoding];
            if (!text) {
                job->error = "Clipboard text is not valid UTF-8";
                return;
            }
            [pasteboard clearContents];
            if (![pasteboard setString:text forType:NSPasteboardTypeString]) job->error = "Could not set clipboard text";
        } else if (job->operation == CLIPBOARD_TEXT) {
            NSString* text = [pasteboard stringForType:NSPasteboardTypeString];
            if (!text) {
                job->format = CLIPBOARD_EMPTY;
            } else if (!text.UTF8String) {
                job->error = "Could not encode clipboard text";
            } else {
                clipboard_copy(job, text.UTF8String, [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding], CLIPBOARD_UTF8);
            }
        } else if (job->operation == CLIPBOARD_FILES) {
            NSArray* urls = [pasteboard readObjectsForClasses:@[[NSURL class]]
                options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
            size_t total = 0;
            for (NSURL* url in urls) {
                const char* path = url.fileSystemRepresentation;
                if (!path) continue;
                size_t length = strlen(path);
                if (length == SIZE_MAX || total > SIZE_MAX - length - 1) {
                    job->error = "Clipboard file paths are too large";
                    return;
                }
                total += length + 1;
            }
            if (total == 0) {
                job->format = CLIPBOARD_EMPTY;
                return;
            }
            char* paths = clipboard_alloc(total);
            if (!paths) {
                job->error = "Out of memory";
                return;
            }
            char* cursor = paths;
            for (NSURL* url in urls) {
                const char* path = url.fileSystemRepresentation;
                if (!path) continue;
                size_t length = strlen(path);
                memcpy(cursor, path, length + 1);
                cursor += length + 1;
            }
            job->data = paths;
            job->length = total;
            job->format = CLIPBOARD_PATHS;
        } else {
            if (![pasteboard availableTypeFromArray:@[ NSPasteboardTypePNG, NSPasteboardTypeTIFF ]]) {
                job->format = CLIPBOARD_EMPTY;
                return;
            }
            NSData* png = [pasteboard dataForType:NSPasteboardTypePNG];
            if (!png) {
                NSImage* image = [[NSImage alloc] initWithPasteboard:pasteboard];
                NSData* tiff = image.TIFFRepresentation;
                NSBitmapImageRep* bitmap = tiff ? [NSBitmapImageRep imageRepWithData:tiff] : nil;
                png = bitmap ? [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
            }
            if (png) clipboard_copy(job, png.bytes, png.length, CLIPBOARD_BUFFER);
            else job->error = "Clipboard does not contain an image";
        }
    }
}

static napi_value NANOPI_NAPI_CALL get_clipboard_file_paths(napi_env env, napi_callback_info info) {
    return queue_clipboard(env, info, CLIPBOARD_FILES);
}

NANOPI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    set_function_export(env, exports, "getText", get_clipboard_text);
    set_function_export(env, exports, "setText", set_clipboard_text);
    set_function_export(env, exports, "getImage", get_clipboard_image);
    set_function_export(env, exports, "getFilePaths", get_clipboard_file_paths);
    return exports;
}
