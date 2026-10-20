import { EventEmitter } from "node:events";
import type undici from "undici";
import connect from "undici/lib/api/api-connect.js";
import request from "undici/lib/api/api-request.js";
import Client from "undici/lib/dispatcher/client.js";
import Dispatcher from "undici/lib/dispatcher/dispatcher.js";
import EnvHttpProxyAgent from "undici/lib/dispatcher/env-http-proxy-agent.js";
import Pool from "undici/lib/dispatcher/pool.js";
import { setGlobalDispatcher } from "undici/lib/global.js";
import type { EventSource as UndiciEventSource } from "undici/lib/web/eventsource/eventsource.js";
import type { FormData as UndiciFormData } from "undici/lib/web/fetch/formdata.js";
import type { Headers as UndiciHeaders } from "undici/lib/web/fetch/headers.js";
import { fetch as undiciFetch } from "undici/lib/web/fetch/index.js";
import type { Request as UndiciRequest } from "undici/lib/web/fetch/request.js";
import type { Response as UndiciResponse } from "undici/lib/web/fetch/response.js";
import type {
	CloseEvent as UndiciCloseEvent,
	ErrorEvent as UndiciErrorEvent,
	MessageEvent as UndiciMessageEvent,
} from "undici/lib/web/websocket/events.js";
import type { WebSocket as UndiciWebSocket } from "undici/lib/web/websocket/websocket.js";
import * as undiciGlobals from "../shims/undici-globals.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

type ClientOptions = NonNullable<ConstructorParameters<typeof Client>[1]>;
type PoolOptions = NonNullable<ConstructorParameters<typeof Pool>[1]>;

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing nanopi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new Client(origin, options as ClientOptions));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as PoolOptions;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

// undici's barrel patches these onto `Dispatcher.prototype` from `index.js`. NanopI reads
// `dispatcher.request` internally and the proxy agent calls `this[kClient].connect(...)`
// for CONNECT tunnels, so a dispatcher built from the deep imports must carry them too.
Object.assign(Dispatcher.prototype, { request, connect });

/**
 * Mirrors undici's own `install()`: the globals it exports are the globals it installs.
 *
 * The `@types/node` web globals carry undici-types' own classes, while npm undici
 * ships a different copy, so every assignment goes through `unknown`. The cast is
 * only about which declaration wins; the runtime objects must come from undici, or
 * fetch and the dispatcher end up in two implementations.
 *
 * `CloseEvent` and `ErrorEvent` are not declared by any `lib` this project loads,
 * so they are reached through the record. `undici.install()` assigns them the same way.
 */
function installUndiciGlobals(): void {
	globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
	globalThis.Headers = undiciGlobals.Headers as unknown as typeof UndiciHeaders;
	globalThis.Response = undiciGlobals.Response as unknown as typeof UndiciResponse;
	globalThis.Request = undiciGlobals.Request as unknown as typeof UndiciRequest;
	globalThis.FormData = undiciGlobals.FormData as unknown as typeof UndiciFormData;
	globalThis.WebSocket = undiciGlobals.WebSocket as unknown as typeof UndiciWebSocket;
	(globalThis as Record<string, unknown>).CloseEvent = undiciGlobals.CloseEvent as typeof UndiciCloseEvent;
	(globalThis as Record<string, unknown>).ErrorEvent = undiciGlobals.ErrorEvent as typeof UndiciErrorEvent;
	globalThis.MessageEvent = undiciGlobals.MessageEvent as unknown as typeof UndiciMessageEvent;
	globalThis.EventSource = undiciGlobals.EventSource as unknown as typeof UndiciEventSource;
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const dispatcher = withUndiciErrorListener(
		new EnvHttpProxyAgent({
			allowH2: false,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			proxyTunnel: true,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		installUndiciGlobals();
		installedGlobalFetch = globalThis.fetch;
	}
}
