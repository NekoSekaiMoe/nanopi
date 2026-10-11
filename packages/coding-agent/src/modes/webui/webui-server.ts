/**
 * WebUI mode: serves the browser UI from packages/webui and bridges its HTTP/SSE
 * API onto a headless AgentSession.
 *
 * Frontend contract ported from AtomCode's webui (MIT). The default `/chat`
 * transport is implemented; the `?sync=1` `/live` transport is not. nanopi has
 * no per-tool-call permission gate, so the approval mode is always `bypass`.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, normalize } from "node:path";
import type { AgentMessage } from "@nanopi/pi-agent-core";
import type { AssistantMessageEvent, ImageContent, Message, Model, ToolResultMessage } from "@nanopi/pi-ai";
import { getPackageDir } from "../../config.ts";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { parseSessionEntries, type SessionInfo, SessionManager } from "../../core/session-manager.ts";

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

/** Wire types from the webui frontend (see packages/webui/src/api.ts). */
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

function modelKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
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

	const server = createServer((req, res) => {
		void handleRequest(req, res).catch((error) => {
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: (error as Error).message }));
		});
	});

	// Single in-flight turn; the frontend blocks sending while a turn streams.
	let turnActive = false;

	function json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	}

	function authorized(req: IncomingMessage): boolean {
		const header = req.headers.authorization;
		return header === `Bearer ${token}`;
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
		const finish = () => {
			if (!settled) {
				settled = true;
				send({ type: "done", tokens: null, tool_calls: null, session_id: session.sessionId });
				res.end();
			}
			unsubscribe();
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

		// Health and static assets are unauthenticated; the SPA shows its own
		// auth notice when API calls get 401.
		if (path === "/health") {
			json(res, 200, { ok: true });
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
			const current = session.model;
			const infos: WebuiModelInfo[] = models.map((model) => ({
				provider: modelKey(model),
				model: model.id,
				provider_type: model.provider,
				is_default: current ? model.provider === current.provider && model.id === current.id : false,
				effort_applicable: false,
				reasoning_effort: null,
				effort_levels: [],
			}));
			json(res, 200, infos);
			return;
		}

		// --- Config ---
		if (path === "/config" && req.method === "GET") {
			const current = session.model;
			json(res, 200, {
				path: "",
				default_provider: current ? modelKey(current) : "",
				providers: [],
			});
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
			// splitting the string.
			if (chatBody.provider) {
				const models = await chatModels();
				const model = models.find((candidate) => modelKey(candidate) === chatBody.provider);
				if (model) {
					await runtime.session.setModel(model);
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
			// nanopi runs tools without per-call approval; nothing to answer.
			json(res, 200, { success: false, error: "no permission request is pending" });
			return;
		}
		if (path === "/chat/user-input" && req.method === "POST") {
			json(res, 200, { accepted: false, error: "not supported" });
			return;
		}

		// --- Approval mode: nanopi has no per-call gate; always bypass ---
		if (path === "/approval_mode" && (req.method === "GET" || req.method === "POST")) {
			json(res, 200, { ok: true, mode: "bypass" });
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
			json(res, 400, { error: "model discovery is not available in the webui" });
			return;
		}

		// --- Live (sync) transport: not implemented ---
		if (path === "/live" || path.startsWith("/live/")) {
			json(res, 501, {
				error: "the sync (/live) transport is not implemented; use the default mode",
				code: "live_unsupported",
			});
			return;
		}

		// --- Provider account management: mapped onto nanopi settings later ---
		if (path.startsWith("/provider-accounts") || path.startsWith("/model-profiles")) {
			json(res, 400, { error: "provider management is not available in the webui yet" });
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
			console.log(`nanopi webui listening on http://${host}:${actualPort}`);
			if (distExists) {
				console.log(`Open: http://${host}:${actualPort}/?token=${token}`);
			} else {
				console.log("webui assets are missing; run `pnpm --filter @nanopi/webui run build` and restart.");
			}
			console.log("Press Ctrl+C to stop.");
		});
		// Keep running until the process is killed.
	});
}
