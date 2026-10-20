/**
 * The web globals that `undici.install()` copies onto `globalThis`.
 *
 * `http-dispatcher.ts` reaches these through `undici/lib/...` deep paths instead
 * of the package barrel, which would otherwise bundle the whole client: mocks,
 * interceptors, WebSocket, EventSource and the CacheStorage singleton, none of
 * which nanopi calls. Keep this list in sync with `install()` in undici's
 * `index.js`.
 */

export { EventSource } from "undici/lib/web/eventsource/eventsource.js";
export { FormData } from "undici/lib/web/fetch/formdata.js";
export { Headers } from "undici/lib/web/fetch/headers.js";
export { Request } from "undici/lib/web/fetch/request.js";
export { Response } from "undici/lib/web/fetch/response.js";
export { CloseEvent, ErrorEvent, MessageEvent } from "undici/lib/web/websocket/events.js";
export { WebSocket } from "undici/lib/web/websocket/websocket.js";
