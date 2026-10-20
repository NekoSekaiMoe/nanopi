/**
 * `undici` types its barrel only, while `http-dispatcher.ts` and
 * `undici-globals.ts` import the CommonJS files under `undici/lib/` so esbuild
 * can leave the rest of the barrel out of the bundle.
 *
 * One declaration per imported file. The imports resolve through
 * `undici/types/*.d.ts`: those files do not exist at runtime, but the
 * specifiers are type-only, so nothing reaches the emitted module.
 */

declare module "undici/lib/dispatcher/client.js" {
	import type ClientClass from "undici/types/client";
	const Client: typeof ClientClass;
	export default Client;
}

declare module "undici/lib/dispatcher/env-http-proxy-agent.js" {
	import type EnvHttpProxyAgentClass from "undici/types/env-http-proxy-agent";
	const EnvHttpProxyAgent: typeof EnvHttpProxyAgentClass;
	export default EnvHttpProxyAgent;
}

declare module "undici/lib/dispatcher/pool.js" {
	import type PoolClass from "undici/types/pool";
	const Pool: typeof PoolClass;
	export default Pool;
}

declare module "undici/lib/api/api-connect.js" {
	export { connect as default } from "undici/types/api";
}

declare module "undici/lib/api/api-request.js" {
	export { request as default } from "undici/types/api";
}

declare module "undici/lib/dispatcher/dispatcher.js" {
	export { default } from "undici/types/dispatcher";
}

declare module "undici/lib/global.js" {
	export { getGlobalDispatcher, setGlobalDispatcher } from "undici/types/global-dispatcher";
}

declare module "undici/lib/web/fetch/index.js" {
	export { fetch } from "undici/types/fetch";
}

declare module "undici/lib/web/fetch/formdata.js" {
	export { FormData } from "undici/types/formdata";
}

declare module "undici/lib/web/fetch/headers.js" {
	export { Headers } from "undici/types/fetch";
}

declare module "undici/lib/web/fetch/request.js" {
	export { Request } from "undici/types/fetch";
}

declare module "undici/lib/web/fetch/response.js" {
	export { Response } from "undici/types/fetch";
}

declare module "undici/lib/web/eventsource/eventsource.js" {
	export { EventSource } from "undici/types/eventsource";
}

declare module "undici/lib/web/websocket/events.js" {
	export { CloseEvent, ErrorEvent, MessageEvent } from "undici/types/websocket";
}

declare module "undici/lib/web/websocket/websocket.js" {
	export { WebSocket } from "undici/types/websocket";
}
