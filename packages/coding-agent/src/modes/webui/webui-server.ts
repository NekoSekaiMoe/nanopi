/**
 * WebUI mode: serves the browser UI from packages/webui and bridges its HTTP/SSE
 * API onto a headless AgentSession.
 *
 * Frontend contract ported from AtomCode's webui (MIT). The default `/chat`
 * transport is implemented; the `?sync=1` `/live` transport is not. The extra
 * module (packages/extra) supplies run modes and per-call permission gating
 * through `extraBridge`; when a build flavor excludes it the bridge reports
 * unavailable, every /extra endpoint 404s, permission requests never surface,
 * and the webui hides its mode selector.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, normalize } from "node:path";
import type { AgentMessage } from "@nanopi/pi-agent-core";
import type { AssistantMessageEvent, ImageContent, Message, Model, ToolResultMessage } from "@nanopi/pi-ai";
import { type AskBrokerAnswer, extraBridge } from "@nanopi/pi-extra";
import { getPackageDir } from "../../config.ts";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { parseSessionEntries, type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import {
	addAccountModels,
	createAccount,
	deleteAccount,
	deleteAccountModel,
	discoverModels,
	editAccount,
	editAccountModel,
	listAccounts,
	PROVIDER_PRESETS,
	PROVIDER_PROTOCOLS,
	ProviderAccountError,
	providerAccountsPath,
} from "./provider-accounts.ts";

/** Default port for `nanopi webui`. */
export const DEFAULT_WEBUI_PORT = 5335;

export interface WebuiModeOptions {
	port: number;
	host?: string;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".webmanifest": "application/manifest+json",
	".map": "application/json",
};

/** Wire types from the webui frontend (see packages/webui/src/lib/api.ts). */
interface WebuiModelInfo {
	provider: string;
	model: string;
	provider_type: string;
	is_default: boolean;
	effort_applicable: boolean;
	reasoning_effort: string | null;
	effort_levels: string[];
}

interface WebuiSessionMeta {
	id: string;
	name: string;
	working_dir: string;
	created_at: number;
	updated_at: number;
	message_count: number;
	file_size?: number;
}

interface WebuiSessionMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	synthetic?: boolean;
	tool_calls?: { id: string; name: string; arguments: string; display: string }[];
	tool_result?: { call_id: string; success: boolean; summary: string; line_count: number };
	images?: { media_type: string; data: string }[];
	created_at?: number;
}

interface ChatRequestBody {
	message?: string;
	session_id?: string;
	provider?: string;
	images?: { media_type: string; data: string }[];
}

type SseEvent = Record<string, unknown> & { type: string };

/** Stable identifier for a working directory, used as the project bucket hash. */
function projectHash(cwd: string): string {
	return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

/** Constant-time `Authorization: Bearer <token>` check; exported for tests. */
export function bearerTokenMatches(expected: string, authorization: string | undefined): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const presented = Buffer.from(authorization.slice("Bearer ".length));
	const wanted = Buffer.from(expected);
	return presented.length === wanted.length && timingSafeEqual(presented, wanted);
}

function modelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

/** Packages the build registers as bundled extras (auto-registered when unfiltered). */
const _BUNDLED_EXTRA_PACKAGE_NAMES = new Set(["pi-subagent-mini", "ask-lite", "todo-lite", "mcp-lite"]);

function _packageSourceName(source: string): string {
	const spec = source.replace(/^npm:/, "").trim();
	const versionSeparator = spec.lastIndexOf("@");
	return versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec;
}

/** One browser-driven OAuth login flow. */
interface OAuthFlowState {
	id: string;
	provider: string;
	status: "pending" | "done" | "error";
	url: string | undefined;
	error: string | undefined;
}

/** Locate the built webui assets: source checkout first, then installed dist. */
function getWebuiDistDir(): string {
	const packageDir = getPackageDir();
	const sourceDist = normalize(join(packageDir, "..", "webui", "dist"));
	if (existsSync(sourceDist)) return sourceDist;
	const installedDist = join(packageDir, "dist", "webui");
	if (existsSync(installedDist)) return installedDist;
	return installedDist;
}

function textOfContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** Map an AgentMessage to the webui session-message wire shape. */
function toWebuiMessage(message: AgentMessage): WebuiSessionMessage | null {
	if (message.role === "user") {
		const user = message as Extract<Message, { role: "user" }>;
		const images = Array.isArray(user.content)
			? user.content
					.filter((part): part is ImageContent => part.type === "image")
					.map((part) => ({ media_type: part.mimeType, data: part.data }))
			: undefined;
		return {
			role: "user",
			content: textOfContent(user.content),
			...(images?.length ? { images } : {}),
			created_at: user.timestamp,
		};
	}
	if (message.role === "assistant") {
		const assistant = message as Extract<Message, { role: "assistant" }>;
		const toolCalls = assistant.content
			.filter((part) => part.type === "toolCall")
			.map((part) => {
				const call = part as Extract<Message, { role: "assistant" }>["content"][number] & {
					id: string;
					name: string;
					arguments: unknown;
				};
				return {
					id: call.id,
					name: call.name,
					arguments: JSON.stringify(call.arguments),
					display: `${call.name} ${JSON.stringify(call.arguments).slice(0, 200)}`,
				};
			});
		return {
			role: "assistant",
			content: assistant.content
				.filter((part) => part.type === "text")
				.map((part) => (part as { text: string }).text)
				.join(""),
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		};
	}
	if (message.role === "toolResult") {
		const result = message as ToolResultMessage;
		const summary = textOfContent(result.content);
		return {
			role: "tool",
			content: summary,
			tool_result: {
				call_id: result.toolCallId,
				success: !result.isError,
				summary,
				line_count: summary.split("\n").length,
			},
		};
	}
	return null;
}

/** Read a session file and map its message entries for GET session detail. */
function readSessionMessages(content: string): WebuiSessionMessage[] {
	const messages: WebuiSessionMessage[] = [];
	for (const entry of parseSessionEntries(content)) {
		if (entry.type !== "message") continue;
		const mapped = toWebuiMessage(entry.message);
		if (mapped) messages.push(mapped);
	}
	return messages;
}

function sessionMeta(info: SessionInfo): WebuiSessionMeta & { project_hash: string } {
	return {
		id: info.id,
		name: info.name ?? info.firstMessage.slice(0, 60) ?? "",
		working_dir: info.cwd,
		created_at: info.created.getTime(),
		updated_at: info.modified.getTime(),
		message_count: info.messageCount,
		project_hash: projectHash(info.cwd || ""),
	};
}

/**
 * Run the webui: serve static assets plus the API bridge on a loopback port.
 * Resolves only on server error or shutdown.
 */
export async function runWebuiMode(runtime: AgentSessionRuntime, options: WebuiModeOptions): Promise<void> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port;
	const token = randomBytes(24).toString("hex");
	const distDir = getWebuiDistDir();
	const distExists = existsSync(join(distDir, "index.html"));

	// Extensions run headless in webui mode: no UI context, but a mode marker so
	// the extra module routes permission prompts through the bridge below.
	const rebindSession = async (): Promise<void> => {
		await runtime.session.bindModules({ mode: "webui" });
	};
	await rebindSession();
	runtime.setRebindSession(rebindSession);

	const server = createServer((req, res) => {
		void handleRequest(req, res).catch((error) => {
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: (error as Error).message }));
		});
	});

	// Single in-flight turn; the frontend blocks sending while a turn streams.
	let turnActive = false;
	// Browser-driven OAuth login flows (see /extra/oauth/*).
	const oauthFlows = new Map<string, OAuthFlowState>();

	function json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	}

	function authorized(req: IncomingMessage): boolean {
		return bearerTokenMatches(token, req.headers.authorization);
	}

	async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
		if (!distExists) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("webui assets are not built. Run `pnpm --filter @nanopi/webui run build` first.");
			return;
		}
		let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
		let file = normalize(join(distDir, rel));
		if (!file.startsWith(distDir)) {
			res.writeHead(403);
			res.end();
			return;
		}
		if (!existsSync(file)) {
			// SPA fallback
			rel = "index.html";
			file = join(distDir, rel);
		}
		try {
			const data = await readFile(file);
			res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
			res.end(data);
		} catch {
			res.writeHead(404);
			res.end();
		}
	}

	async function listAllSessions(): Promise<(WebuiSessionMeta & { project_hash: string })[]> {
		const infos = await SessionManager.listAll();
		return infos.map(sessionMeta);
	}

	async function findSessionFile(id: string): Promise<SessionInfo | undefined> {
		const infos = await SessionManager.listAll();
		return infos.find((info) => info.id === id || info.id.startsWith(id));
	}

	function currentSession(): AgentSession {
		return runtime.session;
	}

	/** The `/chat` turn: subscribe, prompt, stream SSE until the run settles. */
	function runChatTurn(req: IncomingMessage, res: ServerResponse, body: ChatRequestBody): void {
		const session = currentSession();
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const send = (event: SseEvent) => {
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		let settled = false;
		const startedAt = Date.now();
		let toolCalls = 0;
		let promptTokens = 0;
		let completionTokens = 0;
		let cachedTokens = 0;
		let rounds = 0;

		send({
			type: "runtime_info",
			provider: modelKey(session.model ?? ({ provider: "", id: "" } as Model<any>)).replace(/^\//, ""),
			model: session.model?.id ?? "",
		});
		send({ type: "session_assigned", session_id: session.sessionId });

		const onEvent = (event: AgentSessionEvent) => {
			switch (event.type) {
				case "turn_start":
					rounds++;
					break;
				case "message_update": {
					const streamEvent = event.assistantMessageEvent as AssistantMessageEvent;
					if (streamEvent.type === "text_delta") {
						send({ type: "text", content: streamEvent.delta });
					} else if (streamEvent.type === "thinking_delta") {
						send({ type: "reasoning", content: streamEvent.delta });
					}
					break;
				}
				case "message_end": {
					const message = event.message;
					if (message.role === "assistant") {
						const usage = (message as Extract<Message, { role: "assistant" }>).usage;
						if (usage) {
							promptTokens += usage.input;
							completionTokens += usage.output;
							cachedTokens += usage.cacheRead;
						}
					}
					break;
				}
				case "tool_execution_start":
					send({
						type: "tool_start",
						id: event.toolCallId,
						name: event.toolName,
						arguments: event.args,
					});
					break;
				case "tool_execution_update": {
					const partial = event.partialResult as { content?: unknown } | undefined;
					const chunk =
						partial && Array.isArray(partial.content)
							? partial.content
									.filter((part) => (part as { type?: string }).type === "text")
									.map((part) => (part as { text?: string }).text ?? "")
									.join("")
							: "";
					if (chunk) send({ type: "tool_output", chunk });
					send({ type: "tool_progress", id: event.toolCallId, progress: "" });
					break;
				}
				case "tool_execution_end": {
					toolCalls++;
					const output =
						typeof event.result?.content === "object" && Array.isArray(event.result?.content)
							? (event.result.content as Array<{ type: string; text?: string }>)
									.filter((part) => part.type === "text")
									.map((part) => part.text ?? "")
									.join("\n")
							: ((event.result?.content as unknown as string) ?? "");
					send({
						type: "tool_result",
						id: event.toolCallId,
						name: event.toolName,
						output: String(output),
						success: !event.isError,
						duration_ms: event.durationMs ?? 0,
					});
					break;
				}
				case "compaction_start":
					send({ type: "warning", message: "compacting context…" });
					break;
				case "auto_retry_start":
					send({ type: "warning", message: `retrying after error (attempt ${event.attempt})…` });
					break;
				case "agent_settled": {
					if (settled) return;
					settled = true;
					if (event.aborted) {
						send({ type: "stopped" });
					} else {
						send({
							type: "done",
							tokens: null,
							tool_calls: null,
							session_id: session.sessionId,
							stats: {
								duration_ms: Date.now() - startedAt,
								rounds,
								tool_calls: toolCalls,
								prompt_tokens: promptTokens,
								completion_tokens: completionTokens,
								cached_tokens: cachedTokens,
							},
						});
					}
					res.end();
					break;
				}
				default:
					break;
			}
		};

		const unsubscribe = session.subscribe(onEvent);
		// Surface extra-module permission prompts as SSE permission_request events;
		// POST /chat/permission answers them (see handleApi).
		const unsubscribeBroker = extraBridge.available
			? extraBridge.permissions.subscribe((event) => {
					if (event.type !== "prompt") return;
					send({
						type: "permission_request",
						session_id: session.sessionId,
						tool_name: event.info.toolName,
						reason: event.info.summary,
						call_id: event.info.callId,
						arguments: event.info.args,
					});
				})
			: undefined;
		// Structured input (ask_user_question) renders in the same composer seat.
		// The frontend's flat fields mirror questions[0] so a single question needs
		// no batch protocol; multi-question requests always send `questions`.
		const unsubscribeAsks = extraBridge.available
			? extraBridge.asks.subscribe((event) => {
					if (event.type !== "prompt") return;
					const first = event.questions[0];
					send({
						type: "user_input_request",
						request_id: event.requestId,
						session_id: session.sessionId,
						header: first?.header ?? "",
						question: first?.question ?? "",
						mode: first?.mode ?? "text",
						options: first?.options ?? [],
						custom: first?.custom ?? true,
						...(event.questions.length > 1 ? { questions: event.questions } : {}),
					});
				})
			: undefined;
		const finish = () => {
			if (!settled) {
				settled = true;
				send({ type: "done", tokens: null, tool_calls: null, session_id: session.sessionId });
				res.end();
			}
			unsubscribe();
			unsubscribeBroker?.();
			unsubscribeAsks?.();
			turnActive = false;
		};

		const images: ImageContent[] | undefined = body.images?.map((image) => ({
			type: "image",
			data: image.data,
			mimeType: image.media_type,
		}));

		session
			.prompt(body.message ?? "", {
				...(images?.length ? { images } : {}),
				source: "webui",
			})
			.catch((error: Error) => {
				send({ type: "error", message: error.message });
			})
			.finally(() => {
				// agent_settled may fire before or after prompt() resolves; cover both.
				finish();
			});

		req.on("close", () => {
			// Client disconnected: abort the turn so tools stop.
			void session.abort().finally(() => {
				unsubscribe();
				unsubscribeBroker?.();
				unsubscribeAsks?.();
				turnActive = false;
			});
		});
	}

	async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		if (!chunks.length) return {};
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = url.pathname;

		// Health, static assets, and the pairing exchange are unauthenticated; the
		// SPA shows its own auth notice when API calls get 401.
		if (path === "/health") {
			json(res, 200, { ok: true });
			return;
		}
		if (path === "/extra/pair" && req.method === "POST") {
			if (!extraBridge.available) {
				json(res, 404, { error: "pairing is not included in this build" });
				return;
			}
			const body = await readBody(req);
			const code = typeof body.code === "string" ? body.code : "";
			try {
				extraBridge.pairing.verify(code);
				json(res, 200, { token });
			} catch (error) {
				json(res, 401, { error: error instanceof Error ? error.message : "pairing failed" });
			}
			return;
		}
		if (
			!/^\/(api|live|chat|sessions|projects|project|config|models|skills|fs|cd|command|approval_mode|mcp|tunnel|providers|provider-accounts|model-profiles)\b/.test(
				path,
			)
		) {
			if (req.method === "GET" || req.method === "HEAD") {
				await serveStatic(res, path);
				return;
			}
		}

		if (!authorized(req)) {
			json(res, 401, { error: "unauthorized", code: "unauthorized" });
			return;
		}

		try {
			await handleApi(req, res, url, path);
		} catch (error) {
			json(res, 500, { error: (error as Error).message });
		}
	}

	async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
		const session = currentSession();
		const services = runtime.services;

		/** Chat models to expose: the availability snapshot plus the active session model. */
		async function chatModels(): Promise<Model<any>[]> {
			const snapshot = services.modelRuntime.getAvailableSnapshot();
			const models: Model<any>[] = snapshot.filter((model): model is Model<any> => !("type" in model));
			const current = session.model;
			if (current && !models.some((model) => model.provider === current.provider && model.id === current.id)) {
				models.push(current);
			}
			try {
				const all = await services.modelRuntime.getAllAvailable();
				for (const model of all) {
					if (!("type" in model) && !models.some((m) => m.provider === model.provider && m.id === model.id)) {
						models.push(model);
					}
				}
			} catch {
				// Availability pass failed; the snapshot above is still served.
			}
			return models;
		}

		// --- Models ---
		if (path === "/models" && req.method === "GET") {
			const models = await chatModels();
			const defaultKey = defaultModelKey();
			const current = session.model;
			const infos: WebuiModelInfo[] = models.map((model) => ({
				provider: modelKey(model),
				model: model.id,
				provider_type: model.provider,
				is_default: defaultKey
					? modelKey(model) === defaultKey
					: current
						? model.provider === current.provider && model.id === current.id
						: false,
				effort_applicable: false,
				reasoning_effort: null,
				effort_levels: [],
			}));
			json(res, 200, infos);
			return;
		}

		/** Settings-configured default model key ("provider/id"), the single source of truth shared with the CLI. */
		function defaultModelKey(): string {
			const provider = runtime.services.settingsManager.getDefaultProvider();
			const modelId = runtime.services.settingsManager.getDefaultModel();
			if (!provider) return "";
			return modelId ? `${provider}/${modelId}` : provider;
		}

		/** The /config payload: model defaults plus the provider-account catalog. */
		async function configPayload(): Promise<Record<string, unknown>> {
			const current = session.model;
			return {
				path: "",
				default_provider: defaultModelKey() || (current ? modelKey(current) : ""),
				providers: [],
				provider_accounts: await listAccounts(providerAccountsPath()),
				provider_presets: PROVIDER_PRESETS,
				provider_protocols: PROVIDER_PROTOCOLS,
			};
		}

		/** String field from a JSON body. */
		function str(value: unknown): string | undefined {
			return typeof value === "string" ? value : undefined;
		}

		/** Model bodies from a JSON body (NewModelInput[]). */
		function modelInputs(value: unknown): Array<Record<string, unknown>> {
			return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null)
				? (value as Array<Record<string, unknown>>)
				: [];
		}

		async function refreshModels(): Promise<void> {
			await services.modelRuntime.refresh({ allowNetwork: false });
		}

		// --- Config ---
		if (path === "/config" && req.method === "GET") {
			json(res, 200, await configPayload());
			return;
		}
		if (path === "/config/reload" && req.method === "POST") {
			json(res, 200, {});
			return;
		}

		// --- Project state ---
		if (path === "/project" && req.method === "GET") {
			json(res, 200, {
				working_dir: runtime.cwd,
				project_hash: projectHash(runtime.cwd),
			});
			return;
		}
		if (path === "/projects" && req.method === "GET") {
			const sessions = await listAllSessions();
			const byHash = new Map<string, { working_dir: string; sessions: typeof sessions }>();
			for (const item of sessions) {
				const bucket = byHash.get(item.project_hash) ?? { working_dir: item.working_dir, sessions: [] };
				bucket.sessions.push(item);
				byHash.set(item.project_hash, bucket);
			}
			const projects = Array.from(byHash.entries()).map(([hash, bucket]) => ({
				hash,
				name: basename(bucket.working_dir) || bucket.working_dir,
				working_dir: bucket.working_dir,
				session_count: bucket.sessions.length,
				created_at: Math.min(...bucket.sessions.map((s) => s.created_at)),
				last_updated: Math.max(...bucket.sessions.map((s) => s.updated_at)),
			}));
			json(res, 200, projects);
			return;
		}

		// --- Sessions ---
		if (path === "/sessions" && req.method === "GET") {
			json(res, 200, await listAllSessions());
			return;
		}
		if (path === "/sessions" && req.method === "POST") {
			await runtime.newSession();
			json(res, 200, {
				id: runtime.session.sessionId,
				name: "",
				working_dir: runtime.cwd,
				project_hash: projectHash(runtime.cwd),
				created_at: Date.now(),
			});
			return;
		}
		if (path === "/sessions/search" && req.method === "GET") {
			const q = (url.searchParams.get("q") ?? "").toLowerCase();
			const all = await listAllSessions();
			json(
				res,
				200,
				all.filter((item) => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q)),
			);
			return;
		}
		if (path.startsWith("/sessions/resolve/") && req.method === "GET") {
			const id = decodeURIComponent(path.slice("/sessions/resolve/".length));
			const found = await findSessionFile(id);
			json(res, 200, found ? sessionMeta(found) : null);
			return;
		}

		// --- Per-project session routes ---
		const projectMatch = /^\/projects\/([^/]+)\/sessions(?:\/([^/]+)(?:\/(rename))?)?$/.exec(path);
		if (projectMatch) {
			const [, hash, sessionId, action] = projectMatch;
			if (!sessionId && req.method === "GET") {
				const all = await listAllSessions();
				json(
					res,
					200,
					all.filter((item) => item.project_hash === hash),
				);
				return;
			}
			if (sessionId && !action && req.method === "GET") {
				const info = await findSessionFile(sessionId);
				if (!info) {
					json(res, 404, { error: "session not found" });
					return;
				}
				const content = await readFile(info.path, "utf8");
				const messages = readSessionMessages(content);
				json(res, 200, {
					id: info.id,
					name: info.name ?? "",
					working_dir: info.cwd,
					created_at: info.created.getTime(),
					updated_at: info.modified.getTime(),
					message_count: info.messageCount,
					messages,
				});
				return;
			}
			if (sessionId && action === "rename" && req.method === "PATCH") {
				const body = await readBody(req);
				const name = typeof body.name === "string" ? body.name : "";
				if (runtime.session.sessionId === sessionId || runtime.session.sessionId.startsWith(sessionId)) {
					session.setSessionName(name);
					json(res, 200, {});
					return;
				}
				json(res, 400, { error: "only the active session can be renamed from the webui" });
				return;
			}
			if (sessionId && !action && req.method === "DELETE") {
				if (turnActive) {
					json(res, 409, { error: "a turn is running; stop it before deleting a session" });
					return;
				}
				const info = await findSessionFile(sessionId);
				if (!info) {
					json(res, 404, { error: "session not found" });
					return;
				}
				if (info.id === runtime.session.sessionId) {
					await runtime.newSession();
				}
				await rm(info.path, { force: true });
				json(res, 200, {});
				return;
			}
		}

		// --- Chat (default transport) ---
		if (path === "/chat" && req.method === "POST") {
			if (turnActive) {
				json(res, 409, { error: "a turn is already running in this webui", code: "busy" });
				return;
			}
			const body = await readBody(req);
			const chatBody: ChatRequestBody = {
				message: typeof body.message === "string" ? body.message : "",
				session_id: typeof body.session_id === "string" ? body.session_id : undefined,
				provider: typeof body.provider === "string" ? body.provider : undefined,
				images: undefined,
			};
			if (Array.isArray(body.images)) {
				chatBody.images = body.images as { media_type: string; data: string }[];
			}
			// Switch to the requested session when it is not the active one.
			if (chatBody.session_id) {
				const wanted = chatBody.session_id;
				const currentId = runtime.session.sessionId;
				if (wanted !== currentId && !currentId.startsWith(wanted)) {
					const info = await findSessionFile(wanted);
					if (!info) {
						json(res, 404, { error: `session ${wanted} not found` });
						return;
					}
					await runtime.switchSession(info.path);
				}
			}
			// Apply the requested model before the turn. Model ids may contain
			// slashes, so match the composite key against the catalog instead of
			// splitting the string. Switching persists to the shared default so
			// the CLI and webui agree (single source of truth).
			if (chatBody.provider) {
				const models = await chatModels();
				const model = models.find((candidate) => modelKey(candidate) === chatBody.provider);
				if (model) {
					await runtime.session.setModel(model, { persist: true });
				}
			}
			turnActive = true;
			runChatTurn(req, res, chatBody);
			return;
		}
		if (path === "/chat/stop" && req.method === "POST") {
			await session.abort();
			json(res, 200, {});
			return;
		}
		if (path === "/chat/active" && req.method === "GET") {
			json(res, 200, turnActive ? [session.sessionId] : []);
			return;
		}
		if (path === "/chat/permission" && req.method === "POST") {
			if (!extraBridge.available) {
				json(res, 200, { success: false, error: "permissions are not included in this build" });
				return;
			}
			const body = await readBody(req);
			const decision = typeof body.decision === "string" ? body.decision : "";
			const callId = typeof body.call_id === "string" ? body.call_id : undefined;
			const toolName = typeof body.tool_name === "string" ? body.tool_name : undefined;
			const answered = extraBridge.answerPermission(decision, callId, toolName);
			json(
				res,
				200,
				answered ? { success: true } : { success: false, error: "no matching permission request is pending" },
			);
			return;
		}
		if (path === "/chat/user-input" && req.method === "POST") {
			if (!extraBridge.available) {
				json(res, 200, { accepted: false, error: "structured input is not included in this build" });
				return;
			}
			const body = await readBody(req);
			const requestId = typeof body.request_id === "number" ? body.request_id : undefined;
			if (requestId === undefined) {
				json(res, 200, { accepted: false, error: "request_id is required" });
				return;
			}
			const resolution = Array.isArray(body.responses)
				? { type: "batch" as const, answers: body.responses as AskBrokerAnswer[] }
				: {
						type: "single" as const,
						answer: {
							declined: body.declined === true,
							selected: Array.isArray(body.selected) ? (body.selected as string[]) : [],
							text: typeof body.text === "string" ? body.text : null,
						},
					};
			const accepted = extraBridge.asks.answer(requestId, resolution);
			json(res, 200, accepted ? { accepted: true } : { accepted: false, error: "no matching question is pending" });
			return;
		}

		// --- Approval mode: bridged onto the extra module's run modes ---
		if (path === "/approval_mode" && (req.method === "GET" || req.method === "POST")) {
			if (!extraBridge.available) {
				json(res, 404, { error: "run modes are not included in this build" });
				return;
			}
			if (req.method === "POST") {
				const body = await readBody(req);
				const result = extraBridge.setMode(body.mode);
				if (!result.ok) {
					json(res, 400, { error: result.error });
					return;
				}
			}
			json(res, 200, { ok: true, mode: extraBridge.state().mode });
			return;
		}

		// --- Extra module bridge: modes, settings, subsystems, OAuth ---
		if (path.startsWith("/extra/") && !extraBridge.available) {
			json(res, 404, { error: "the extra module is not included in this build" });
			return;
		}
		if (path === "/extra/state" && req.method === "GET") {
			json(res, 200, extraBridge.state());
			return;
		}
		if (path === "/extra/mode" && req.method === "POST") {
			const body = await readBody(req);
			const result = extraBridge.setMode(body.mode);
			if (!result.ok) {
				json(res, 400, { error: result.error });
				return;
			}
			json(res, 200, { mode: result.mode });
			return;
		}
		if (path === "/extra/settings" && req.method === "GET") {
			const resolved = extraBridge.settings();
			json(res, 200, { settings: resolved.settings, subsystems: extraBridge.subsystemStatus() });
			return;
		}
		if (path === "/extra/settings" && req.method === "PUT") {
			const body = await readBody(req);
			if (body.defaultMode !== undefined) {
				const result = extraBridge.setDefaultMode(body.defaultMode);
				if (!result.ok) {
					json(res, 400, { error: result.error });
					return;
				}
			}
			let subsystems = extraBridge.subsystemStatus();
			if (body.subsystems && typeof body.subsystems === "object") {
				for (const [key, value] of Object.entries(body.subsystems)) {
					if (typeof value === "boolean") {
						subsystems = extraBridge.setSubsystem(key as never, value);
					}
				}
			}
			json(res, 200, { settings: extraBridge.settings().settings, subsystems });
			return;
		}
		if (path === "/extra/oauth/providers" && req.method === "GET") {
			const providers = services.modelRuntime
				.getProviders()
				.filter((provider) => provider.auth.oauth)
				.map((provider) => ({ id: provider.id, name: provider.name ?? provider.id }));
			json(res, 200, { providers });
			return;
		}
		if (path === "/extra/oauth/login" && req.method === "POST") {
			const body = await readBody(req);
			const provider = typeof body.provider === "string" ? body.provider : "";
			const known = services.modelRuntime.getProviders().find((candidate) => candidate.id === provider);
			if (!known?.auth.oauth) {
				json(res, 400, { error: `no OAuth flow for provider "${provider}"` });
				return;
			}
			const flow: OAuthFlowState = {
				id: randomBytes(8).toString("hex"),
				provider,
				status: "pending",
				url: undefined,
				error: undefined,
			};
			oauthFlows.set(flow.id, flow);
			void services.modelRuntime
				.login(provider, "oauth", {
					prompt: async () => {
						throw new Error("this login step needs interactive input; run `nanopi /login` in the CLI instead");
					},
					notify: (event) => {
						if (event.type === "auth_url" && !flow.url) flow.url = event.url;
						if (event.type === "device_code" && !flow.url) {
							flow.url = `${event.verificationUri} (code: ${event.userCode})`;
						}
					},
				})
				.then(() => {
					flow.status = "done";
				})
				.catch((error: Error) => {
					flow.status = "error";
					flow.error = error.message;
				});
			json(res, 200, { flow_id: flow.id });
			return;
		}
		if (path === "/extra/oauth/status" && req.method === "GET") {
			const flowId = url.searchParams.get("flow") ?? "";
			const flow = oauthFlows.get(flowId);
			if (!flow) {
				json(res, 404, { error: "unknown login flow" });
				return;
			}
			json(res, 200, { status: flow.status, provider: flow.provider, url: flow.url, error: flow.error });
			if (flow.status !== "pending") oauthFlows.delete(flowId);
			return;
		}

		// --- Skills ---
		if (path === "/skills" && req.method === "GET") {
			const { skills } = services.resourceLoader.getSkills();
			json(
				res,
				200,
				skills.map((skill) => ({ name: skill.name, description: skill.description })),
			);
			return;
		}

		// --- Filesystem browsing ---
		if (path === "/fs/list" && req.method === "GET") {
			const target = url.searchParams.get("path") ?? runtime.cwd;
			const entries = await readdir(target, { withFileTypes: true });
			const dirs = entries
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.sort();
			const files = entries
				.filter((e) => e.isFile())
				.map((e) => e.name)
				.sort();
			json(res, 200, { path: target, dirs, files });
			return;
		}
		if (path === "/fs/mkdir" && req.method === "POST") {
			const body = await readBody(req);
			const target = typeof body.path === "string" ? body.path : "";
			if (!target) {
				json(res, 400, { error: "path is required" });
				return;
			}
			await mkdir(target, { recursive: true });
			json(res, 200, { path: target });
			return;
		}
		if (path === "/fs/search" && req.method === "GET") {
			json(res, 200, { path: url.searchParams.get("path") ?? runtime.cwd, matches: [] });
			return;
		}
		if (path === "/fs/open" && req.method === "POST") {
			json(res, 400, { error: "opening files from the host is not supported" });
			return;
		}

		// --- Working directory ---
		if (path === "/cd" && req.method === "POST") {
			json(res, 400, {
				success: false,
				message: "changing the working directory from the webui is not supported yet",
				current_dir: runtime.cwd,
				project_hash: projectHash(runtime.cwd),
			});
			return;
		}

		// --- Stubbed AtomCode facilities ---
		if (path === "/mcp/status" && req.method === "GET") {
			json(res, 200, { servers: [], trusted: true, blocked: [] });
			return;
		}
		if (path === "/tunnel/status" && req.method === "GET") {
			json(res, 200, {
				bind_host: host,
				port,
				reachable: false,
				pgy: { installed: false, ipv4: null },
				remote_url: null,
				qr_svg: null,
			});
			return;
		}
		if (path === "/command" && req.method === "POST") {
			json(res, 200, { kind: "error", message: "slash commands are not available in the webui yet" });
			return;
		}
		if (path === "/live/mcp/trust" && req.method === "POST") {
			json(res, 200, { ok: false, error: "MCP is not available" });
			return;
		}
		if (path === "/providers/discover-models" && req.method === "POST") {
			const body = await readBody(req);
			try {
				const models = await discoverModels({
					type: str(body.type) ?? "openai",
					base_url: str(body.base_url) ?? "",
					api_key: str(body.api_key),
				});
				json(res, 200, { models });
			} catch (error) {
				if (error instanceof ProviderAccountError) {
					json(res, error.status, { error: error.message });
					return;
				}
				throw error;
			}
			return;
		}

		// --- Provider accounts: one models.json entry each ---
		const accountsPath = providerAccountsPath();
		const routeParts = path.split("/").filter(Boolean).map(decodeURIComponent);
		if (routeParts[0] === "provider-accounts") {
			try {
				if (routeParts.length === 1 && req.method === "POST") {
					const body = await readBody(req);
					const provider = str(body.provider);
					if (!provider) {
						json(res, 400, { error: "provider is required" });
						return;
					}
					const result = await createAccount(accountsPath, {
						id: str(body.id),
						provider,
						display_name: str(body.display_name),
						base_url: str(body.base_url),
						api_key: str(body.api_key),
						models: modelInputs(body.models).map((model) => ({
							model: String(model.model ?? ""),
							display_name: str(model.display_name),
							context_window: typeof model.context_window === "number" ? model.context_window : undefined,
							max_tokens: typeof model.max_tokens === "number" ? model.max_tokens : undefined,
							supports_vision: model.supports_vision === true,
							reasoning_effort: str(model.reasoning_effort),
						})),
					});
					await refreshModels();
					json(res, 200, {
						account: result.account,
						models: result.models,
						config: await configPayload(),
					});
					return;
				}
				const accountId = routeParts[1];
				if (routeParts.length === 2 && req.method === "PATCH") {
					const body = await readBody(req);
					await editAccount(accountsPath, accountId, {
						display_name: str(body.display_name),
						base_url: str(body.base_url),
						api_key: str(body.api_key),
					});
					await refreshModels();
					json(res, 200, { config: await configPayload() });
					return;
				}
				if (routeParts.length === 2 && req.method === "DELETE") {
					await deleteAccount(accountsPath, accountId);
					await refreshModels();
					json(res, 200, { config: await configPayload() });
					return;
				}
				if (routeParts.length === 3 && routeParts[2] === "models" && req.method === "POST") {
					const body = await readBody(req);
					const created = await addAccountModels(
						accountsPath,
						accountId,
						modelInputs(body.models).map((model) => ({
							model: String(model.model ?? ""),
							display_name: str(model.display_name),
							context_window: typeof model.context_window === "number" ? model.context_window : undefined,
							max_tokens: typeof model.max_tokens === "number" ? model.max_tokens : undefined,
							supports_vision: model.supports_vision === true,
							reasoning_effort: str(model.reasoning_effort),
						})),
					);
					await refreshModels();
					json(res, 200, { created, config: await configPayload() });
					return;
				}
				if (routeParts.length === 4 && routeParts[2] === "models") {
					const modelId = routeParts[3];
					if (req.method === "PATCH") {
						const body = await readBody(req);
						await editAccountModel(accountsPath, accountId, modelId, {
							display_name: str(body.display_name),
							context_window: typeof body.context_window === "number" ? body.context_window : undefined,
							max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
							clear_max_tokens: body.clear_max_tokens === true,
							supports_vision: body.supports_vision === true,
							clear_supports_vision: body.clear_supports_vision === true,
							reasoning_effort: str(body.reasoning_effort),
							clear_reasoning_effort: body.clear_reasoning_effort === true,
						});
						await refreshModels();
						json(res, 200, { config: await configPayload() });
						return;
					}
					if (req.method === "DELETE") {
						await deleteAccountModel(accountsPath, accountId, modelId);
						await refreshModels();
						json(res, 200, { config: await configPayload() });
						return;
					}
				}
			} catch (error) {
				if (error instanceof ProviderAccountError) {
					json(res, error.status, { error: error.message });
					return;
				}
				throw error;
			}
		}

		// --- Live (sync) transport: not implemented ---
		if (path === "/live" || path.startsWith("/live/")) {
			json(res, 501, {
				error: "the sync (/live) transport is not implemented; use the default mode",
				code: "live_unsupported",
			});
			return;
		}

		// --- Model profiles: not mapped onto nanopi yet ---
		if (path.startsWith("/model-profiles")) {
			json(res, 400, { error: "model profiles are not available in the webui yet" });
			return;
		}

		json(res, 404, { error: `no such endpoint: ${req.method} ${path}` });
	}

	await new Promise<void>((_resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			const bound = server.address();
			const actualPort = typeof bound === "object" && bound ? bound.port : port;
			const url = `http://${host}:${actualPort}`;
			console.log(`nanopi webui listening on ${url}`);
			if (!distExists) {
				console.log("webui assets are missing; run `pnpm --filter @nanopi/webui run build` and restart.");
			} else if (extraBridge.available) {
				// Pairing handoff: short one-time code exchanged at /extra/pair for the
				// bearer token, replacing the long token-in-URL.
				const pairing = extraBridge.pairing.generate();
				const minutes = Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60_000));
				console.log(`Open: ${url}`);
				console.log(`Pairing code: ${pairing.code} (valid ${minutes} min, one-time)`);
			} else {
				console.log(`Open: ${url}/?token=${token}`);
			}
			console.log("Press Ctrl+C to stop.");
		});
		// Keep running until the process is killed.
	});
}
