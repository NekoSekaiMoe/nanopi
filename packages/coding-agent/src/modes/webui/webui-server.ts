/**
 * WebUI mode: serves the browser UI from packages/webui and bridges its HTTP/SSE
 * API onto a headless AgentSession.
 *
 * Frontend contract ported from AtomCode's webui (MIT). Only the `/chat` + SSE
 * transport exists: AtomCode's `?sync=1` `/live` transport has no caller here
 * and its endpoints were removed rather than answered with a stub (#595). The
 * extra module (packages/extra) supplies run modes and per-call permission
 * gating through `extraBridge`; when a build flavor excludes it the bridge
 * reports unavailable, every /extra endpoint 404s, permission requests never
 * surface, and the webui hides its mode selector.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, normalize, relative as relativePath, resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@nanopi/pi-agent-core";
import {
	type AssistantMessageEvent,
	getSupportedThinkingLevels,
	type ImageContent,
	type Message,
	type Model,
	type ToolResultMessage,
	type Usage,
} from "@nanopi/pi-ai";
import { type AskBrokerAnswer, extraBridge } from "@nanopi/pi-extra";
import { isBuildComponentEnabled } from "../../build-components.ts";
import { getAgentDir, getPackageDir } from "../../config.ts";
import type { AgentSession, AgentSessionEvent, SessionStats } from "../../core/agent-session.ts";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
} from "../../core/agent-session-runtime.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../core/agent-session-services.ts";
import {
	type FileEntry,
	parseSessionEntries,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
} from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { loadMcpConfig } from "../../extras/mcp-lite/src/config.ts";
import { commandAvailable } from "../../extras/mcp-lite/src/executables.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import { dropUnauthenticated, mergeModelLists, modelsWithinAllowlist } from "./model-list.ts";
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
	readAccountApiKey,
	readAccountHeaders,
} from "./provider-accounts.ts";

/** Default port for `nanopi webui`. */
export const DEFAULT_WEBUI_PORT = 5335;

/**
 * Version of the running build, read once for `/health`.
 *
 * A webui served from a build without the `module/mcp-lite` component and one
 * with it answer `/mcp/status` differently, and the browser cannot tell them
 * apart from the launch URL alone; this is what a report can quote so the next
 * reader knows which binary produced the answer.
 */
const APP_VERSION: string = (() => {
	try {
		const manifest = JSON.parse(readFileSync(join(getPackageDir(), "package.json"), "utf8")) as {
			version?: unknown;
		};
		return typeof manifest.version === "string" ? manifest.version : "";
	} catch {
		/* an install without a readable manifest still serves; the version is just empty */
		return "";
	}
})();

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
	/** The catalog entry accepts image input, so the composer may attach an image to a turn. */
	supports_image: boolean;
	effort_applicable: boolean;
	reasoning_effort: string | null;
	effort_levels: string[];
	/** False for a catalog model whose provider has no usable credential, e.g. a models.json entry with no key. */
	available: boolean;
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

/**
 * What one assistant reply was billed for, so the transcript bubble can say
 * how long it took and how many tokens it cost. `context` is the prompt the
 * request carried, which is what fills the context window; `cache_read` is the
 * part of it that a cache served.
 */
export interface WebuiTurnUsage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	cost: number;
	context: number;
}

/** Session-level usage, summed from the transcript entries a live session counts. */
export interface WebuiSessionStats {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	cost: number;
}

interface WebuiSessionMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** `provider/model` that produced an assistant reply. */
	provider?: string;
	synthetic?: boolean;
	tool_calls?: { id: string; name: string; arguments: string; display: string }[];
	tool_result?: { call_id: string; success: boolean; summary: string; line_count: number };
	images?: { media_type: string; data: string }[];
	/** What this assistant reply was billed for; absent outside assistant replies. */
	usage?: WebuiTurnUsage;
	created_at?: number;
}

/** What GET session detail derives from one transcript file. */
interface SessionDetailContent {
	messages: WebuiSessionMessage[];
	thinking_level?: string;
	/** Plan of the last todo result on the recorded branch; absent without one. */
	plan?: PlanItem[];
	/**
	 * Why a transcript that billed tokens reports no totals: one branch was
	 * compacted, so the split between the summarized and the live part is lost and
	 * a sum over the file would charge the summarized span twice. The live session
	 * knows the split (`AgentSession.getSessionStats`), so this one field is the
	 * only part of the read path that has to refuse.
	 */
	stats_unavailable?: "compacted";
	/** Session usage as the live session counts it; absent when nothing was billed. */
	stats?: WebuiSessionStats;
}

interface ChatRequestBody {
	message?: string;
	/**
	 * Run mode the sender is in. The settings page switches the engine directly,
	 * but a turn carries the mode too, so a client that only knows the mode of its
	 * own copy of the state (a freshly loaded tab) still runs the turn under it.
	 */
	approval_mode?: string;
	session_id?: string;
	/**
	 * Client-generated id of this request, echoed to `/chat/active` and matched by
	 * `/chat/stop`, so a stop names one turn instead of every turn of a session.
	 */
	request_id?: string;
	provider?: string;
	images?: { media_type: string; data: string }[];
	/**
	 * Queue behind the running turn instead of answering 409. A producer that cannot
	 * ask again later (a background job reporting in) sets this; a user-driven send
	 * does not, because the frontend knows it is blocked.
	 */
	queue?: boolean;
}

type SseEvent = Record<string, unknown> & { type: string };

/**
 * One started `/chat` turn. The run outlives the HTTP response that asked for it:
 * `attach` streams it, and `runDetached` is for a turn with no reader at all (a
 * queued prompt).
 */
interface WebuiTurn {
	sessionId: string;
	/** Id the browser sent on `/chat`; `/chat/active` reports it and `/chat/stop` matches it. */
	turnId: string;
	attach(req: IncomingMessage, res: ServerResponse): void;
	runDetached(): void;
}

/** One running turn, as `/chat/active` reports it and `/chat` answers in its 409. */
interface TurnHolder {
	turn_id: string;
	session_id: string;
	started_at: number;
}

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

/**
 * Split a provider error string into a display message and the HTTP status it
 * carries. Provider adapters compose errors as `"<status>: <body>"` or
 * `"<prefix> (<status>): <body>"`, so the status is recoverable without
 * wrapping every adapter's error type.
 */
export function describeProviderError(raw: string | undefined): { message: string; code?: number } {
	const text = (raw ?? "").trim();
	if (!text) return { message: "unknown provider error" };
	const prefix = /^(?:[A-Za-z][\w .-]*\s)?\((\d{3})\)\s*:?\s*/.exec(text);
	const bare = /^(\d{3})\s*:\s*/.exec(text);
	const code = prefix ? Number(prefix[1]) : bare ? Number(bare[1]) : undefined;
	if (code === undefined) return { message: text };
	const message = text.slice(prefix ? prefix[0].length : bare ? bare[0].length : 0).trim() || text;
	return { message, code };
}

/** One row of the todo extension's plan, as the browser renders it. */
export interface PlanItem {
	id: number;
	text: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	isVerification?: boolean;
}

/**
 * The `todo` tool keeps the session plan in its result `details`, which the
 * text `output` does not carry. Send that snapshot alongside the result so the
 * browser can mirror the plan the TUI shows in its working line; without it the
 * plan exists only inside the model's context and `/chat` streams a cmd-only
 * transcript. Other tools carry no plan, so the field stays absent instead of
 * shipping an empty list on every call.
 */
export function planSnapshotOf(toolName: string, details: unknown): { plan?: PlanItem[] } {
	if (toolName !== "todo") return {};
	const raw = (details as { todos?: unknown } | undefined)?.todos;
	if (!Array.isArray(raw)) return {};
	const statuses = new Set(["pending", "in_progress", "completed", "cancelled"]);
	const plan: PlanItem[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const status = typeof record.status === "string" ? record.status : "";
		if (typeof record.id !== "number" || !statuses.has(status)) continue;
		if (typeof record.text !== "string") continue;
		plan.push({
			id: record.id,
			text: record.text,
			status: status as PlanItem["status"],
			...(record.isVerification === true ? { isVerification: true } : {}),
		});
	}
	return { plan };
}

/** Packages the build registers as bundled extras (auto-registered when unfiltered). */
const _BUNDLED_EXTRA_PACKAGE_NAMES = new Set(["pi-subagent-mini", "ask-lite", "todo-lite", "mcp-lite"]);

function _packageSourceName(source: string): string {
	const spec = source.replace(/^npm:/, "").trim();
	const versionSeparator = spec.lastIndexOf("@");
	return versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec;
}

/** Largest file the viewer will read into memory. */
const MAX_VIEWABLE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Resolve a user-supplied path against the workspace root; undefined when empty.
 *
 * `~` is expanded because the composer shows it, but the result has to stay
 * inside `cwd`: the endpoints below list, read and write whatever they are
 * given, and only the bearer token stood between the browser and any file the
 * user can reach.
 */
function resolveWorkspacePath(requested: string, cwd: string): string | undefined {
	const trimmed = requested.trim();
	if (!trimmed) return undefined;
	const expanded = trimmed.startsWith("~") ? join(homedir(), trimmed.slice(1).replace(/^\//, "")) : trimmed;
	const target = normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
	return isInsideWorkspace(target, cwd) ? target : undefined;
}

/** Whether `target` is the workspace root or below it. */
function isInsideWorkspace(target: string, cwd: string): boolean {
	const relative = relativePath(cwd, target);
	return relative === "" || (!relative.startsWith("..") && !isAbsolute(relative));
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await stat(target)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Replace the session the runtime serves with a fresh one rooted at the target
 * working directory.
 *
 * None of the runtime's public replacements can move the directory:
 * `switchSession` hands `cwdOverride` to `SessionManager.open`, which roots the
 * manager at the override while the runtime rebuilds its cwd-bound services
 * from the *previous* directory, and `newSession` is rooted at the process cwd
 * by construction. So the replacement is done the way the runtime does it
 * internally, with a session manager created at the target.
 *
 * `SessionManager.create(cwd)` gets no explicit session directory on purpose:
 * `resolvePath` treats a path like `/project/nested` as already absolute, so
 * reusing the old session directory silently pinned the manager back to the
 * directory the server started in.
 *
 * The runtime's own factory would still build services for the launch
 * directory; `setServicesHop` is what makes it build them for this one. The
 * module rebind is skipped because `bindModules` starts the session again with
 * the `session_start` event the factory already consumed, and that restart
 * rebuilds cwd-bound state from the runtime's fixed cwd.
 *
 * The conversation stays behind in the old transcript. It was about the old
 * directory, and carrying it along would mix two projects into one session.
 */
async function replaceSessionCwd(
	runtime: AgentSessionRuntime,
	cwd: string,
	bindSession: ((runtime: AgentSessionRuntime) => Promise<void>) | undefined,
): Promise<void> {
	const previousSessionFile = runtime.session.sessionFile;
	const internals = runtime as unknown as {
		services: AgentSessionServices;
		createRuntime(options: {
			cwd: string;
			agentDir: string;
			sessionManager: SessionManager;
			sessionStartEvent?: {
				type: "session_start";
				reason: "new" | "resume";
				previousSessionFile?: string;
			};
		}): Promise<CreateAgentSessionRuntimeResult>;
		teardownCurrent(reason: "new" | "resume", targetSessionFile?: string): Promise<void>;
		apply(result: CreateAgentSessionRuntimeResult): void;
		finishSessionReplacement(): Promise<void>;
	};
	const sessionManager = SessionManager.create(cwd);
	await internals.teardownCurrent("new", sessionManager.getSessionFile());
	internals.apply(
		await internals.createRuntime({
			cwd: sessionManager.getCwd(),
			agentDir: internals.services.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
		}),
	);
	runtime.setRebindSession(undefined);
	try {
		await internals.finishSessionReplacement();
	} finally {
		runtime.setRebindSession(bindSession ? () => bindSession(runtime) : undefined);
	}
}

/**
 * The working directory the runtime is serving.
 *
 * The session's own cwd wins: a session opened through `switchSession` carries
 * the directory of the file it came from, and a session replaced by
 * `replaceSessionCwd` carries the target. The runtime's cwd is the fallback for
 * the window where the two have not been reconciled, and it is the launch
 * directory, so reporting it when the session knows better would undo a `/cd`.
 */
function sessionCwdOf(runtime: AgentSessionRuntime): string {
	return runtime.session.sessionManager.getCwd() || runtime.cwd;
}

/**
 * What `GET /mcp/status` answers.
 *
 * This is the MCP *configuration* read from `mcp-lite` (the module the agent's
 * subagent bridge loads), not a live connection table: no server is connected
 * until a session starts, and connecting from an HTTP handler would spawn
 * processes nobody is waiting for on every settings-page render. Every server
 * therefore reports `configured`, plus why its stdio command is missing when
 * the lookup fails on this machine.
 *
 * `available: false` means the build excludes the `module/mcp-lite` component,
 * which the settings page has to say out loud: an empty list would otherwise
 * read as "nothing configured yet".
 */
function mcpStatusPayload(cwd: string, projectTrusted: boolean): Record<string, unknown> {
	if (!isBuildComponentEnabled("module/mcp-lite")) {
		return { available: false, servers: [], trusted: projectTrusted, blocked: [] };
	}
	const config = loadMcpConfig(cwd, { agentDir: getAgentDir() });
	const servers = [...config.servers].map(([name, server]) => ({
		name,
		status: "configured",
		transport: server.transport,
		source: config.origins.get(name),
		error:
			server.transport === "stdio" && !commandAvailable(server.command)
				? `${server.command} is not on PATH`
				: undefined,
	}));
	const blocked = [...(projectTrusted ? [] : [join(cwd, ".nanopi", "mcp.json")]), ...config.problems];
	return { available: true, servers, trusted: projectTrusted, blocked };
}

/** POSIX login shell for the scratch terminal. */
function shellPath(): string {
	return process.env.SHELL || "/bin/sh";
}

/**
 * Incremental WebSocket text reader. One reader per connection: the handshake
 * takes the first frame and `push` continues with the rest, so no chunk is lost
 * between the two consumers.
 */
class WebSocketTextReader {
	private buffered = Buffer.alloc(0);
	private readonly queue: string[] = [];
	private readonly waiters: Array<(frame: string) => void> = [];
	private readonly socket: Socket;

	/** Start reading frames; the caller consumes them through `next`. */
	constructor(socket: Socket) {
		this.socket = socket;
		// `prepend` keeps our unbuffered reader ahead of any other listener once
		// the socket switches into flowing mode.
		socket.prependListener("data", this.handleData);
	}

	readonly handleData = (chunk: Buffer): void => {
		this.buffered = Buffer.concat([this.buffered, chunk]);
		for (;;) {
			const frame = this.takeFrame();
			if (frame === undefined) return;
			const pending = this.waiters.shift();
			if (pending) pending(frame);
			else this.queue.push(frame);
		}
	};

	/** Resolve with the next frame, pulling from the queue or waiting on the socket. */
	next(): Promise<string> {
		const queued = this.queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Stop delivering frames; the caller owns the socket from here on. */
	detach(): void {
		this.socket.off("data", this.handleData);
	}

	private takeFrame(): string | undefined {
		if (this.buffered.length < 2) return undefined;
		const opcode = this.buffered[0] & 0x0f;
		const masked = (this.buffered[1] & 0x80) !== 0;
		let length = this.buffered[1] & 0x7f;
		let offset = 2;
		if (length === 126) {
			if (this.buffered.length < 4) return undefined;
			length = this.buffered.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (this.buffered.length < 10) return undefined;
			length = Number(this.buffered.readBigUInt64BE(2));
			offset = 10;
		}
		const maskOffset = offset;
		if (masked) offset += 4;
		if (this.buffered.length < offset + length) return undefined;
		let payload = this.buffered.subarray(offset, offset + length);
		if (masked) {
			const mask = this.buffered.subarray(maskOffset, maskOffset + 4);
			payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
		}
		this.buffered = this.buffered.subarray(offset + length);
		if (opcode === 0x8) return "\u0000close";
		if (opcode === 0x9 || opcode === 0xa) return undefined;
		return payload.toString("utf8");
	}
}

/** Encode one unmasked text frame. */
function encodeWebSocketText(text: string): Buffer {
	const payload = Buffer.from(text, "utf8");
	const length = payload.length;
	if (length < 126) return Buffer.concat([Buffer.from([0x81, length]), payload]);
	if (length < 65_536) {
		const head = Buffer.alloc(4);
		head[0] = 0x81;
		head[1] = 126;
		head.writeUInt16BE(length, 2);
		return Buffer.concat([head, payload]);
	}
	const head = Buffer.alloc(10);
	head[0] = 0x81;
	head[1] = 127;
	head.writeBigUInt64BE(BigInt(length), 2);
	return Buffer.concat([head, payload]);
}

/** One scratch shell: commands run one at a time in the session's directory. */
interface TerminalSession {
	shell: string;
	cwd: string;
	/** The command currently running, so the UI can cancel it. */
	running: ChildProcess | undefined;
	exec(command: string): Promise<{ output: string; code: number | null }>;
	cancel(): void;
	kill(): void;
}

/** Cap on retained output per command; a runaway command must not freeze the tab. */
const MAX_TERMINAL_OUTPUT_CHARS = 200_000;

/** Terminal protocol messages, newest client to newest server. */
type TerminalMessage =
	| { type: "exec"; command: string; id: string }
	| { type: "cd"; path: string }
	| { type: "cancel" };

interface TerminalState {
	cwd: string;
	session: TerminalSession;
	/** Id of the command in flight, so a second one is rejected instead of racing. */
	running: string | undefined;
}

/** Exported for tests: the scratch-shell process lifecycle is not reachable over HTTP alone. */
export function startTerminal(cwd: string): TerminalSession {
	const shell = shellPath();
	// Each command runs in its own `sh -c` with piped stdio. A long-lived
	// interactive shell looked simpler, but it needs a tty to drive the command
	// loop reliably: without one it buffers prompts and stops consuming stdin,
	// so writes seem to succeed and no output ever arrives.
	const session: TerminalSession = {
		shell,
		cwd,
		running: undefined,
		exec(command) {
			return new Promise((resolve) => {
				const child = spawn(shell, ["-c", command], {
					cwd: session.cwd,
					env: { ...process.env, TERM: "dumb" },
					// Own process group, so cancel reaches any process the command spawns.
					// spawns (`sh -c "make"` leaves make in the shell's group, not ours).
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				session.running = child;
				if (child.pid) trackDetachedChildPid(child.pid);
				let output = "";
				let truncated = false;
				const collect = (data: Buffer) => {
					if (truncated) return;
					output += data.toString("utf8");
					if (output.length > MAX_TERMINAL_OUTPUT_CHARS) {
						output = output.slice(0, MAX_TERMINAL_OUTPUT_CHARS);
						truncated = true;
					}
				};
				child.stdout.on("data", collect);
				child.stderr.on("data", collect);
				child.on("error", (error) => {
					session.running = undefined;
					if (child.pid) untrackDetachedChildPid(child.pid);
					resolve({ output: `${output}${error.message}\n`, code: null });
				});
				child.on("close", (code) => {
					session.running = undefined;
					if (child.pid) untrackDetachedChildPid(child.pid);
					const suffix = truncated ? "\n[output truncated]\n" : "";
					resolve({ output: `${output}${suffix}`, code });
				});
			});
		},
		cancel() {
			const child = session.running;
			session.running = undefined;
			if (!child?.pid) return;
			killProcessTree(child.pid);
			untrackDetachedChildPid(child.pid);
		},
		kill() {
			session.cancel();
		},
	};
	return session;
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
			// A conversation can span several models; each reply names the one that
			// produced it, so the transcript and the model list agree.
			...(assistant.provider && assistant.model ? { provider: `${assistant.provider}/${assistant.model}` } : {}),
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
			...(assistant.usage ? { usage: turnUsageOf(assistant.usage) } : {}),
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

/**
 * The todo plan recorded in a session log: the last plan-shaped `todo` result
 * on the recorded branch, projected through any context edit that replaced it.
 *
 * A session file is a tree; `parseSessionEntries` returns every line, branches
 * and abandoned loops included, so walking them in file order would report a
 * plan the agent never had. The branch is instead rebuilt from `parentId` links
 * (last entry is the leaf, as in `SessionManager.buildSessionPath`), and the
 * plan is then found by matching `toolCallId` because the results do not record
 * the tool name.
 *
 * Every `todo` result carries the whole list (`planSnapshotOf`), so the newest
 * one is the current plan: an empty list means the model cleared its plan and
 * the card has to go with it. Only a result that never described a plan at all
 * (no `details`, or a shape `planSnapshotOf` refuses) is walked past, which is
 * how a log written before the field existed still yields the plan it recorded.
 *
 * `context_edit` entries replace a message's content in the model's context but
 * leave the tool details alone, so a todo result the user edited away is still
 * in the log; those are skipped like abandoned branches.
 */
export function planFromSessionEntries(entries: FileEntry[]): PlanItem[] | undefined {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (entry.type !== "session") byId.set(entry.id, entry);
	}
	const branch = sessionBranchEntries(entries);

	// An edit replaces the content the model sees, not the details, so every
	// edited todo result is off the table regardless of how many edits hit it.
	const editedCalls = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "context_edit") continue;
		const result = toolResultOf(byId.get(entry.targetId));
		if (result) editedCalls.add(result.toolCallId);
	}

	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const result = toolResultOf(branch[index]);
		if (!result || editedCalls.has(result.toolCallId)) continue;
		const plan = planSnapshotOf("todo", result.details).plan;
		if (plan) return plan;
	}
	return undefined;
}

/** The tool result a message entry carries, or undefined for other entries. */
function toolResultOf(entry: SessionEntry | undefined): { toolCallId: string; details?: unknown } | undefined {
	if (!entry) return undefined;
	if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
	const result = entry.message as ToolResultMessage;
	return { toolCallId: result.toolCallId, details: result.details };
}

/** Read a session file for GET session detail: messages, settings and the plan. */
export function readSessionMessages(content: string): SessionDetailContent {
	const entries = parseSessionEntries(content);
	const messages: WebuiSessionMessage[] = [];
	let thinkingLevel: string | undefined;
	for (const entry of entries) {
		if (entry.type === "message") {
			const mapped = toWebuiMessage(entry.message);
			if (mapped) messages.push(mapped);
		} else if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		}
	}
	// The messages come from the whole file (the UI reads a conversation, not a
	// branch), but the totals must not, so they are summed over the branch alone.
	const stats = sessionStatsFromEntries(entries);
	return {
		messages,
		thinking_level: thinkingLevel,
		plan: planFromSessionEntries(entries),
		...(stats ? { stats } : {}),
		...(!stats && entries.some((entry) => entry.type === "compaction" || entry.type === "branch_summary")
			? { stats_unavailable: "compacted" }
			: {}),
	};
}

/**
 * Map an `AssistantMessage` usage block to the wire shape of one reply.
 */
function turnUsageOf(usage: Usage): WebuiTurnUsage {
	return {
		input: usage.input,
		output: usage.output,
		cache_read: usage.cacheRead,
		cache_write: usage.cacheWrite,
		cost: usage.cost.total,
		// What the request sent, which is what the window holds: fresh input plus
		// the part a cache served or was written for.
		context: usage.input + usage.cacheRead + usage.cacheWrite,
	};
}

/**
 * The transcript branch as the session manager walks it: every line is a node,
 * the last one is the leaf, and `parentId` links rebuild root-to-leaf.
 *
 * A session file is a tree (a fork or a retry appends a sibling), so walking the
 * file in order would mix branches that were never one conversation. Same shape
 * as `SessionManager.buildSessionPath`, which parses each line on its own and so
 * cannot be reused here.
 */
export function sessionBranchEntries(entries: FileEntry[]): SessionEntry[] {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (entry.type !== "session") byId.set(entry.id, entry);
	}
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	const leaf = entries[entries.length - 1];
	let current = leaf ? byId.get(leaf.id) : undefined;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	return branch;
}

/**
 * Session usage summed over the branch, the way `AgentSession.getSessionStats`
 * sums what it holds in memory: message usage plus the `usage` entries the agent
 * writes for work that is not a message (a title, a summary).
 *
 * `undefined` means the file cannot answer. A compaction or branch summary on
 * the branch packs the conversation it replaced into one entry that carries the
 * summarized span's usage too, while the summarized messages stay in the file as
 * that entry's ancestors, so a sum charges that span twice. The live session
 * knows which entries it no longer counts; a restored transcript does not.
 */
export function sessionStatsFromEntries(
	entries: FileEntry[],
	branch: SessionEntry[] = sessionBranchEntries(entries),
): WebuiSessionStats | undefined {
	const totals: WebuiSessionStats = { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 };
	const add = (usage: Usage | undefined): void => {
		// Fixtures and hand-edited transcripts carry messages without usage; a
		// missing charge is not a zero charge, so skip it instead of crashing.
		if (!usage) return;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cache_read += usage.cacheRead;
		totals.cache_write += usage.cacheWrite;
		totals.cost += usage.cost.total;
	};
	for (const entry of branch) {
		if (entry.type === "usage") {
			add(entry.usage);
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") return undefined;
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult") {
			if (entry.message.usage) add(entry.message.usage);
			continue;
		}
		if (entry.message.role === "assistant") add(entry.message.usage);
	}
	if (totals.input + totals.output + totals.cache_read + totals.cache_write === 0) return undefined;
	return totals;
}

/**
 * Session usage as `AgentSession.getSessionStats` reports it, or undefined when
 * the session has not billed anything yet.
 */
function sessionStatsOf(stats: SessionStats): WebuiSessionStats | undefined {
	const { tokens } = stats;
	if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return undefined;
	return {
		input: tokens.input,
		output: tokens.output,
		cache_read: tokens.cacheRead,
		cache_write: tokens.cacheWrite,
		cost: stats.cost,
	};
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
 * Thinking level for one model, or undefined when it was never set. The active
 * model answers from the live session level: the model sheet changes it through
 * `setThinkingLevel`, which writes the transcript, not the per-model setting,
 * so reading the setting would report the previous choice.
 */
export function reasoningEffortOf(
	model: { provider: string; id: string },
	sessionModel: { provider: string; id: string } | undefined,
	sessionLevel: string,
	storedLevel: (provider: string, modelId: string) => string | undefined,
): string | undefined {
	if (sessionModel && sessionModel.provider === model.provider && sessionModel.id === model.id) return sessionLevel;
	return storedLevel(model.provider, model.id);
}

/**
 * Re-apply the thinking level stored for the session's model, if it has one.
 *
 * A model switch (`setModel`, `/chat`, session restore) resolves its level from
 * the per-model setting, the global default, or the session's current level, in
 * that order, and only the first keeps a level the user picked for *this* model.
 * A picker row like `faux/beta · 低` therefore came back as the global default
 * (`off` when unset) the moment the turn switched models, so the reasoning
 * effort the sheet had just written was gone before the request was built.
 *
 * Clamped by `setThinkingLevel`, so a level the model no longer supports falls
 * back to the nearest one it does support instead of failing the turn.
 */
async function restoreStoredThinkingLevel(session: AgentSession): Promise<void> {
	const model = session.model;
	if (!model) return;
	const stored = session.settingsManager.getModelThinkingLevel(model.provider, model.id);
	if (stored && stored !== session.thinkingLevel) session.setThinkingLevel(stored);
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
	// Modules are rebound on every session replacement, and the webui's own
	// replacements (`replaceSessionCwd`, a `/chat` naming another `working_dir`)
	// run outside a module hook. Binding here is what keeps the mode marker alive
	// across a `/cd`; it is the same call switching sessions makes, so it cannot
	// start the runtime twice.
	const bindSession = async (target: AgentSessionRuntime): Promise<void> => {
		await target.session.bindModules({ mode: "webui" });
	};
	await bindSession(runtime);
	// The runtime factory closes over the launch directory's services, so every
	// session replacement rebuilds them there and the runtime's fixed `cwd` can
	// never move. This hop rebuilds them for the directory the incoming session
	// manager points at and then creates the session on top of them; it is the
	// platform's own two-step replace (`createAgentSessionServices` +
	// `createAgentSessionFromServices`), just rooted somewhere the caller chose.
	const servicesHop: CreateAgentSessionRuntimeFactory = async (next) => {
		const cwd = next.sessionManager.getCwd();
		const services = await createAgentSessionServices({
			cwd,
			agentDir: next.agentDir,
			modelRuntime: runtime.services.modelRuntime,
			settingsManager: SettingsManager.create(cwd, next.agentDir),
			extensionFlagValues: runtime.services.extensionFlagValues,
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: next.sessionManager,
			sessionStartEvent: next.sessionStartEvent,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	runtime.setServicesHop(servicesHop);
	runtime.setRebindSession(() => bindSession(runtime));

	/**
	 * A runtime beside the process's own, for a session a tab is running on.
	 *
	 * One `AgentSession` holds one open session, and replacing it (`switchSession`)
	 * aborts the run it takes over, so "two tabs on two sessions, both streaming"
	 * cannot be served by the runtime the process started with: whichever tab
	 * switches would kill the other's turn. A session that needs its own turn gets
	 * its own runtime object instead, built through the same hop (so its
	 * cwd-bound services are rooted at that session's directory) over the shared
	 * model catalog and settings path, which are per-path maps and safe to share.
	 */
	async function openRuntimeAt(
		sessionPath: string,
		cache: Map<string, Promise<AgentSessionRuntime>>,
	): Promise<AgentSessionRuntime> {
		const existing = cache.get(sessionPath);
		if (existing) return existing;
		const pending = (async () => {
			const sessionManager = SessionManager.open(sessionPath);
			const created = await servicesHop({
				cwd: sessionManager.getCwd(),
				agentDir: runtime.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume" },
			});
			const opened = new AgentSessionRuntime(created.session, created.services, servicesHop, created.diagnostics);
			opened.setServicesHop(servicesHop);
			opened.setRebindSession(() => bindSession(opened));
			await bindSession(opened);
			return opened;
		})();
		cache.set(sessionPath, pending);
		try {
			return await pending;
		} catch (error) {
			cache.delete(sessionPath);
			throw error;
		}
	}

	const server = createServer((req, res) => {
		void handleRequest(req, res).catch((error) => {
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: (error as Error).message }));
		});
	});

	// Terminal transport. A WebSocket keeps one shell alive across commands; the
	// connection carries a single masked frame holding the session key, then
	// newline-delimited JSON both ways.
	server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (url.pathname !== "/terminal") {
			socket.destroy();
			return;
		}
		const reject = (status: number, message: string) => {
			socket.write(`HTTP/1.1 ${status} ${message}\r\nconnection: close\r\n\r\n`);
			socket.destroy();
		};
		// Browsers cannot set headers on a WebSocket, so the token may also arrive
		// as the `token` query parameter (the SPA keeps it in session storage) or
		// as a subprotocol entry.
		const offered =
			req.headers.authorization && bearerTokenMatches(token, req.headers.authorization)
				? true
				: url.searchParams.get("token") === token ||
					(req.headers["sec-websocket-protocol"] ?? "")
						.split(",")
						.map((entry) => entry.trim())
						.includes(token);
		if (!offered) {
			reject(401, "Unauthorized");
			return;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
			reject(400, "Bad Request");
			return;
		}
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"upgrade: websocket\r\n" +
				"connection: Upgrade\r\n" +
				`sec-websocket-accept: ${accept}\r\n\r\n`,
		);
		// The HTTP parser paused the socket before emitting `upgrade`; resume it
		// so frames start flowing into the terminal reader.
		socket.resume();

		// The terminal is live before the first frame arrives: the client sends a
		// `{ session }` frame only to pick the working directory, and dropping
		// nothing is easier than handing buffered bytes between readers.
		const terminal = new WebSocketTextReader(socket);
		void (async () => {
			const first = await terminal.next();
			let sessionKey = "";
			try {
				sessionKey = (JSON.parse(first) as { session?: string }).session ?? "";
			} catch {
				/* an empty handshake still opens the terminal */
			}
			const cwd = (sessionKey ? await findSessionCwd(sessionKey) : undefined) ?? runtime.cwd;
			if (!socket.destroyed) runTerminalSocket(socket, cwd, terminal);
		})();
	});

	// Turns in flight, keyed by session id. The lock is per session, not per
	// process, so two tabs on different sessions both run; a second turn on the
	// same session is refused because one AgentSession serves one run.
	const runningTurns = new Map<string, TurnHolder>();
	// Runtimes opened for sessions other than the process's own (see
	// openRuntimeAt). Keyed by session file path, so two tabs on the same session
	// share one object instead of opening it twice.
	const sessionRuntimes = new Map<string, Promise<AgentSessionRuntime>>();
	// Prompts parked behind a running turn (`/chat` with `queue: true`). Only the
	// producer that cannot retry later asks for this; see ChatRequestBody.queue.
	const chatQueue: Array<{ sessionId: string; body: ChatRequestBody }> = [];
	// Long-poll waiters on `/chat/active`; a turn start or end wakes them so a tab
	// that did not start the turn learns it settled without polling the daemon.
	// The snapshot is per turn, so `runDetached` turns (which nobody started from a
	// request) wake the waiters too.
	const turnWaiters = new Set<() => void>();
	/** Wake every `/chat/active` waiter: the answer it is parked on has changed. */
	function notifyTurnChange(): void {
		for (const wake of turnWaiters) wake();
		turnWaiters.clear();
	}
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

	/**
	 * Opt-in scratch shell for the sidebar terminal: one process per socket, plus
	 * a `read`/`write` path so WebKit browsers see output before the whole
	 * command exits. Nothing here reaches the agent transcript; the shell runs in
	 * the session's working directory with the process environment.
	 */
	function runTerminalSocket(ws: Socket, cwd: string, reader: WebSocketTextReader): void {
		const state: TerminalState = { cwd, session: startTerminal(cwd), running: undefined };
		let buffer = "";

		const write = (message: Record<string, unknown>) => {
			if (ws.destroyed) return;
			ws.write(encodeWebSocketText(JSON.stringify(message)));
		};

		write({ type: "start", cwd: state.cwd, shell: state.session.shell });

		// Frames carry one JSON message each. A stray newline inside a frame is
		// tolerated so a client that batches messages still works.
		const handleFrame = (text: string) => {
			buffer += text;
			for (;;) {
				const index = buffer.indexOf("\n");
				const line = index < 0 ? buffer.trim() : buffer.slice(0, index).trim();
				buffer = index < 0 ? "" : buffer.slice(index + 1);
				if (!line) {
					if (index < 0) return;
					continue;
				}
				let message: TerminalMessage;
				try {
					message = JSON.parse(line) as TerminalMessage;
				} catch {
					if (index < 0) return;
					continue;
				}
				if (message.type === "cd") {
					const target = resolveWorkspacePath(message.path, state.cwd);
					if (target) {
						state.cwd = target;
						state.session = startTerminal(target);
						write({ type: "start", cwd: target, shell: state.session.shell });
					}
					continue;
				}
				if (message.type === "cancel") {
					state.session.cancel();
					continue;
				}
				if (message.type === "exec") {
					if (state.running) {
						write({
							type: "exit",
							id: message.id,
							code: null,
							error: "a command is already running",
						});
						continue;
					}
					state.running = message.id;
					void state.session
						.exec(message.command)
						.then((result) => {
							write({ type: "output", data: result.output });
							write({ type: "exit", id: message.id, code: result.code });
						})
						.catch((error: Error) => {
							write({ type: "exit", id: message.id, code: null, error: error.message });
						})
						.finally(() => {
							state.running = undefined;
						});
				}
			}
		};

		void (async () => {
			for (;;) {
				const frame = await reader.next();
				// The close frame decodes to NUL; anything else is protocol text.
				if (frame.startsWith("\u0000")) return;
				handleFrame(frame);
			}
		})();

		const dispose = () => {
			state.session.kill();
		};
		ws.on("close", dispose);
		ws.on("error", dispose);
	}

	async function listAllSessions(): Promise<(WebuiSessionMeta & { project_hash: string })[]> {
		const infos = await SessionManager.listAll();
		return infos.map(sessionMeta);
	}

	/** Working directory of a session by id or short id; undefined when unknown. */
	async function findSessionCwd(id: string): Promise<string | undefined> {
		const info = await findSessionFile(id);
		return info?.cwd || undefined;
	}

	async function findSessionFile(id: string): Promise<SessionInfo | undefined> {
		const infos = await SessionManager.listAll();
		return infos.find((info) => info.id === id || info.id.startsWith(id));
	}

	function currentSession(): AgentSession {
		return runtime.session;
	}

	/**
	 * Start one `/chat` turn on `target`. The run is independent of any HTTP
	 * response: a turn nobody is attached to (a job reporting in, a queued prompt)
	 * still runs, and a browser that reconnects picks it up from the next round on.
	 * `attach` is what turns the run into an SSE stream; it can be called once per
	 * request.
	 *
	 * The turn owns the session lock (`runningTurns`) from here until it settles, so
	 * a second `/chat` on the same session is refused while a turn on another
	 * session runs normally.
	 */
	function beginTurn(
		target: AgentSessionRuntime,
		body: ChatRequestBody,
		opts: { abortOnDetach: boolean; turnId: string },
	): WebuiTurn {
		const session = target.session;
		const startedAt = Date.now();
		const state = {
			ended: false,
			// Set once the turn is over, so a request closing afterwards (the normal
			// end of a stream) does not abort the run like a real disconnect does.
			finished: false,
		};
		const subscribers = new Set<(event: SseEvent) => void>();
		const emit = (event: SseEvent) => {
			for (const send of subscribers) send(event);
		};
		const stats = { toolCalls: 0, rounds: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
		// The final assistant message decides the turn outcome; keep its stop
		// reason and provider error so `done` carries them.
		let lastStopReason: string | undefined;
		let lastErrorMessage: string | undefined;
		let lastErrorCode: number | undefined;
		let endTurn: () => void = () => undefined;
		const cleared = new Promise<void>((resolve) => {
			endTurn = resolve;
		});

		const onEvent = (event: AgentSessionEvent) => {
			switch (event.type) {
				case "turn_start":
					stats.rounds++;
					break;
				case "message_update": {
					const streamEvent = event.assistantMessageEvent as AssistantMessageEvent;
					if (streamEvent.type === "text_delta") {
						emit({ type: "text", content: streamEvent.delta });
					} else if (streamEvent.type === "thinking_delta") {
						emit({ type: "reasoning", content: streamEvent.delta });
					}
					break;
				}
				case "message_end": {
					const message = event.message;
					if (message.role === "assistant") {
						const assistant = message as Extract<Message, { role: "assistant" }>;
						const usage = assistant.usage;
						if (usage) {
							stats.promptTokens += usage.input;
							stats.completionTokens += usage.output;
							stats.cachedTokens += usage.cacheRead;
						}
						// A failed model response keeps its stream open in the
						// session; surface the provider error right away so the UI
						// never sits on "thinking" while the runtime retries.
						lastStopReason = assistant.stopReason;
						if (assistant.stopReason === "error") {
							const detail = describeProviderError(assistant.errorMessage);
							lastErrorMessage = detail.message;
							lastErrorCode = detail.code;
							emit({ type: "error", message: detail.message, code: detail.code, retrying: true });
						} else {
							lastErrorMessage = undefined;
							lastErrorCode = undefined;
						}
					}
					break;
				}
				case "tool_execution_start":
					emit({
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
					if (chunk) emit({ type: "tool_output", chunk });
					emit({ type: "tool_progress", id: event.toolCallId, progress: "" });
					break;
				}
				case "tool_execution_end": {
					stats.toolCalls++;
					const output =
						typeof event.result?.content === "object" && Array.isArray(event.result?.content)
							? (event.result.content as Array<{ type: string; text?: string }>)
									.filter((part) => part.type === "text")
									.map((part) => part.text ?? "")
									.join("\n")
							: ((event.result?.content as unknown as string) ?? "");
					emit({
						type: "tool_result",
						id: event.toolCallId,
						name: event.toolName,
						output: String(output),
						success: !event.isError,
						duration_ms: event.durationMs ?? 0,
						...planSnapshotOf(event.toolName, event.result?.details),
					});
					break;
				}
				case "compaction_start":
					emit({ type: "warning", message: "compacting context…" });
					break;
				case "auto_retry_start":
					emit({
						type: "retry",
						attempt: event.attempt,
						max_attempts: event.maxAttempts,
						delay_ms: event.delayMs,
						message: describeProviderError(event.errorMessage).message,
					});
					break;
				case "auto_retry_end":
					if (!event.success) {
						const detail = describeProviderError(event.finalError);
						emit({ type: "error", message: detail.message, code: detail.code, retrying: false });
					}
					break;
				case "agent_settled": {
					if (state.ended) return;
					state.ended = true;
					if (event.aborted) {
						emit({ type: "stopped" });
					} else {
						emit({
							type: "done",
							tokens: null,
							tool_calls: null,
							session_id: session.sessionId,
							stop_reason: lastStopReason ?? undefined,
							message: lastErrorMessage ?? undefined,
							code: lastErrorCode ?? undefined,
							stats: {
								duration_ms: Date.now() - startedAt,
								rounds: stats.rounds,
								tool_calls: stats.toolCalls,
								prompt_tokens: stats.promptTokens,
								completion_tokens: stats.completionTokens,
								cached_tokens: stats.cachedTokens,
							},
						});
					}
					break;
				}
				default:
					break;
			}
		};

		const eventUnsubscribe = session.subscribe(onEvent);
		// Surface extra-module permission prompts as SSE permission_request events;
		// POST /chat/permission answers them (see handleApi).
		const unsubscribeBroker = extraBridge.available
			? extraBridge.permissions.subscribe((event) => {
					if (event.type === "prompt") {
						emit({
							type: "permission_request",
							session_id: session.sessionId,
							tool_name: event.info.toolName,
							reason: event.info.summary,
							call_id: event.info.callId,
							arguments: event.info.args,
							explainable: true,
						});
						return;
					}
					// The card asked for an explanation: nothing ran, and the card is
					// still waiting for a real answer once the explanation lands.
					if (event.type === "explain") {
						emit({
							type: "permission_explained",
							tool_name: event.info.toolName,
							call_id: event.info.callId,
						});
					}
				})
			: undefined;
		// Structured input (ask_user_question) renders in the same composer seat.
		// The frontend's flat fields mirror questions[0] so a single question needs
		// no batch protocol; multi-question requests always send `questions`.
		const unsubscribeAsks = extraBridge.available
			? extraBridge.asks.subscribe((event) => {
					if (event.type !== "prompt") return;
					const first = event.questions[0];
					emit({
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

		const detachAll = () => {
			eventUnsubscribe();
			unsubscribeBroker?.();
			unsubscribeAsks?.();
		};
		const finish = () => {
			state.finished = true;
			detachAll();
			// Only the turn that holds the lock may release it: a stop-and-restart can
			// leave an older turn settling after its session already accepted a new one.
			if (runningTurns.get(session.sessionId)?.turn_id === opts.turnId) {
				runningTurns.delete(session.sessionId);
			}
			// Wake `/chat/active` long polls: the snapshot they are parked on changed.
			notifyTurnChange();
			endTurn();
		};

		const images: ImageContent[] | undefined = body.images?.map((image) => ({
			type: "image",
			data: image.data,
			mimeType: image.media_type,
		}));

		void session
			.prompt(body.message ?? "", {
				...(images?.length ? { images } : {}),
				source: "webui",
			})
			.catch((error: Error) => {
				emit({ type: "error", message: error.message });
			})
			.finally(() => {
				// agent_settled may fire before or after prompt() resolves; cover both.
				finish();
			});

		const attachEvents = (send: (event: SseEvent) => void): (() => void) => {
			subscribers.add(send);
			return () => subscribers.delete(send);
		};

		const turn: WebuiTurn = {
			sessionId: session.sessionId,
			turnId: opts.turnId,
			attach(req, res) {
				// The SSE head is written with the first event: a queued turn may wait,
				// and an open response with no body reads as a hang to the browser.
				let opened = false;
				const send = (event: SseEvent) => {
					if (res.writableEnded) return;
					if (!opened) {
						opened = true;
						res.writeHead(200, {
							"content-type": "text/event-stream; charset=utf-8",
							"cache-control": "no-cache",
							connection: "keep-alive",
						});
					}
					res.write(`data: ${JSON.stringify(event)}\n\n`);
				};
				const model = session.model ?? ({ provider: "", id: "" } as Model<any>);
				send({
					type: "runtime_info",
					provider: modelKey(model).replace(/^\//, ""),
					model: model.id,
				});
				send({ type: "session_assigned", session_id: session.sessionId });
				const unsubscribe = attachEvents(send);
				void cleared.then(() => {
					unsubscribe();
					if (!res.writableEnded) res.end();
				});
				// Only a client that leaves mid-turn aborts the run, and only for a turn
				// this request started: a background turn belongs to whoever started it.
				req.on("close", () => {
					if (state.finished || !opts.abortOnDetach) {
						unsubscribe();
						return;
					}
					void session.abort().finally(() => {
						finish();
						unsubscribe();
						if (!res.writableEnded) res.end();
					});
				});
			},
			runDetached() {
				// A turn nobody reads still has to settle: wait for it, then let the queue go.
				void cleared.then(() => releaseQueuedTurn());
			},
		};
		return turn;
	}

	/**
	 * Start the next queued prompt, if any. A queued prompt waits for the turn on
	 * *its* session, not for any turn anywhere: prompts parked behind session A must
	 * not be held up by a turn that is running in session B.
	 *
	 * The queued prompt has nobody attached: its reporter already got its answer, and
	 * the turn it starts writes into the transcript, which is where the user reads it.
	 */
	function releaseQueuedTurn(): void {
		const index = chatQueue.findIndex((entry) => !runningTurns.has(entry.sessionId));
		if (index === -1) return;
		const [next] = chatQueue.splice(index, 1);
		if (!next) return;
		void startTurnFor(next.sessionId, next.body).catch(() => {
			/* the producer is gone; the transcript keeps what ran */
		});
	}

	/**
	 * Resolve the runtime a turn should run on, and whether it has to be opened.
	 *
	 * The runtime the process started with serves the session it already holds.
	 * Any other session gets its own runtime from the pool, so opening a second tab
	 * on a different session never replaces (and therefore never aborts) the run
	 * the first tab is streaming.
	 */
	async function runtimeFor(sessionId: string | undefined): Promise<{ target: AgentSessionRuntime; key: string }> {
		const info = sessionId ? await findSessionFile(sessionId) : undefined;
		if (!info) return { target: runtime, key: runtime.session.sessionId };
		if (info.id === runtime.session.sessionId) return { target: runtime, key: info.id };
		if (!info.path) throw new Error(`session ${sessionId} has no file to open`);
		return { target: await openRuntimeAt(info.path, sessionRuntimes), key: info.id };
	}

	/**
	 * Apply the per-request model and run mode to the runtime the turn will use.
	 * Split out of the request handler so a queued prompt gets the same treatment
	 * when it finally starts.
	 */
	async function applyTurnSettings(target: AgentSessionRuntime, body: ChatRequestBody): Promise<void> {
		// Apply the requested model before the turn. Model ids may contain
		// slashes, so match the composite key against the catalog instead of
		// splitting the string. Switching persists to the shared default so
		// the CLI and webui agree (single source of truth).
		if (body.provider) {
			const model = (await modelCatalog()).find((candidate) => modelKey(candidate) === body.provider);
			if (model) {
				await target.session.setModel(model, { persist: true });
				// `setModel` only applies the per-model level when this provider has
				// one stored; otherwise it falls back to the global default and
				// overwrites the level this model's sheet wrote earlier (with "off"
				// when there is no default). The picker the user just closed asked
				// for a model *and* a level, so the stored level wins here.
				await restoreStoredThinkingLevel(target.session);
			}
		}
		// Apply the requested mode before the turn, next to the model switch: the
		// mode decides the tool set the turn runs with. An invalid value is
		// ignored rather than failing the turn, which already has a user prompt in it.
		if (body.approval_mode) extraBridge.setMode(body.approval_mode);
	}

	/**
	 * Every model the catalog knows, for matching the `provider` a `/chat` names.
	 *
	 * This is the shared `modelRuntime` behind every runtime, but which models
	 * count as *active* depends on the session, so the lookup walks the process's
	 * own list plus its current model the same way `/models` does.
	 */
	async function modelCatalog(): Promise<Model<any>[]> {
		const models: Model<any>[] = [];
		mergeModelLists(models, runtime.services.modelRuntime.getAvailableSnapshot());
		mergeModelLists(models, runtime.services.modelRuntime.getModels());
		const current = runtime.session.model;
		if (current) mergeModelLists(models, [current]);
		return models;
	}

	/** Start a turn on an already-resolved runtime and session id. */
	function startTurnOn(target: AgentSessionRuntime, key: string, body: ChatRequestBody): WebuiTurn {
		const turnId = body.request_id ?? randomBytes(8).toString("hex");
		runningTurns.set(key, { turn_id: turnId, session_id: key, started_at: Date.now() });
		notifyTurnChange();
		return beginTurn(target, body, { abortOnDetach: true, turnId });
	}

	/**
	 * Send one prompt as a new turn on the session named by `body.session_id`
	 * (`undefined` means the process's own session). Resolves the runtime the turn
	 * has to run on, which is what keeps two tabs on two sessions apart.
	 */
	async function startTurnFor(
		sessionId: string | undefined,
		body: ChatRequestBody,
	): Promise<{ turn: WebuiTurn; target: AgentSessionRuntime }> {
		const { target, key } = await runtimeFor(sessionId);
		await applyTurnSettings(target, body);
		return { turn: startTurnOn(target, key, body), target };
	}

	/**
	 * The runtime that currently holds a running turn for `sessionId`. Used by the
	 * stop endpoints, which must reach the session's own runtime instead of the
	 * process's: aborting the wrong one would leave the turn running.
	 */
	async function runtimeForRunningTurn(sessionId: string): Promise<AgentSessionRuntime | undefined> {
		if (sessionId === runtime.session.sessionId) return runtime;
		const info = await findSessionFile(sessionId);
		if (!info) return undefined;
		return sessionRuntimes.get(info.path)?.catch(() => undefined);
	}

	/** Whether two session ids name the same session, allowing the short id a tab keeps. */
	function sameSessionId(known: string, wanted: string): boolean {
		return known === wanted || known.startsWith(wanted);
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

		// Health and static assets are unauthenticated; the SPA shows its own auth
		// notice when API calls get 401.
		if (path === "/health") {
			json(res, 200, { ok: true, version: APP_VERSION });
			return;
		}
		if (
			!/^\/(api|chat|sessions|projects|project|config|models|skills|fs|cd|command|approval_mode|mode|mcp|providers|provider-accounts|extra)\b/.test(
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

		/**
		 * Providers known to authenticate, from stored credentials, the
		 * environment, or a models.json key. A provider missing here (a models.json
		 * entry with no key, say) keeps its models in the catalog but cannot run
		 * them, which is what `available: false` reports.
		 */
		function authenticatedProviders(): ReadonlySet<string> {
			return new Set(services.modelRuntime.getAvailableSnapshot().map((model) => model.provider));
		}

		/**
		 * Chat models to expose in the picker: the availability snapshot, the
		 * active session model, and the configured catalog, narrowed to the CLI's
		 * allowlist.
		 *
		 * Catalog rows whose provider failed the auth check are dropped. A built-in
		 * provider ships its whole packaged snapshot (alibaba-cn alone is dozens of
		 * ids) and listing it greyed out turns a picker into a browse of models the
		 * user cannot run; `available: false` still reaches the client for the rows
		 * that survive, so the wire format is unchanged. A provider without a
		 * declared auth method can still resolve a credential, so it keeps its rows
		 * once the availability snapshot reports one.
		 */
		async function chatModels(refresh = false): Promise<Model<any>[]> {
			const authenticated = authenticatedProviders();
			const models: Model<any>[] = [];
			if (refresh) {
				try {
					mergeModelLists(models, await services.modelRuntime.getAvailable());
				} catch {
					// Availability pass failed; the snapshot and catalog still serve.
				}
			}
			mergeModelLists(models, services.modelRuntime.getAvailableSnapshot());
			mergeModelLists(models, [session.model]);
			mergeModelLists(models, dropUnauthenticated(services.modelRuntime.getModels(), authenticated));
			return modelsWithinAllowlist(models, services.settingsManager.getEnabledModels(), session.model);
		}

		/** The catalog `chatModels` starts from, before the settings allowlist narrows it. */
		async function catalogModels(): Promise<Model<any>[]> {
			const models: Model<any>[] = [];
			mergeModelLists(models, services.modelRuntime.getAvailableSnapshot());
			mergeModelLists(models, [session.model]);
			mergeModelLists(models, services.modelRuntime.getModels());
			return models;
		}

		/**
		 * The model object the picker keys on. A catalog refresh replaces model
		 * objects, so the active model's entry can lose its `compat`/thinking
		 * map; the session's own object stays authoritative.
		 */
		function resolveModel(models: Model<any>[], key: string): Model<any> | undefined {
			const current = session.model;
			if (current && key === modelKey(current)) return current;
			return models.find((candidate) => modelKey(candidate) === key);
		}

		// --- Models ---
		if (path === "/models" && req.method === "GET") {
			const models = await chatModels(true);
			const defaultKey = defaultModelKey();
			json(res, 200, modelInfos(models, defaultKey));
			return;
		}
		// Reasoning effort for one model. The model sheet writes here; the value
		// is stored as the per-model setting so a switch away and back keeps the
		// choice, and applied to the session when that model is the active one.
		if (path === "/models/reasoning-effort" && req.method === "POST") {
			const body = await readBody(req);
			const key = typeof body.provider === "string" ? body.provider : "";
			// The catalog, not the allowlisted picker list: a model hidden by
			// `enabledModels` still keeps its level for when it comes back.
			const model = resolveModel(await chatModels(), key) ?? resolveModel(await catalogModels(), key);
			if (!model) {
				json(res, 404, { error: `unknown model ${key}` });
				return;
			}
			const requested = typeof body.reasoning_effort === "string" ? body.reasoning_effort : "";
			const levels = getSupportedThinkingLevels(model);
			const level = requested && levels.includes(requested as never) ? requested : (levels[0] ?? "off");
			session.settingsManager.setModelThinkingLevel(model.provider, model.id, level as ThinkingLevel);
			const isCurrent = session.model?.provider === model.provider && session.model?.id === model.id;
			if (isCurrent) session.setThinkingLevel(level as ThinkingLevel);
			json(res, 200, { provider: key, reasoning_effort: level });
			return;
		}

		/**
		 * Thinking level the next turn will use for `model`: the stored per-model
		 * setting, else the session level already meant for it. A switch keeps the
		 * target model's last stored level (`restoreStoredThinkingLevel` on
		 * `/chat`), so the sheet never reads back the global default it did not
		 * pick.
		 */
		function effortFor(model: Model<any>): string | undefined {
			const stored = session.settingsManager.getModelThinkingLevel(model.provider, model.id);
			if (stored) return stored;
			return reasoningEffortOf(model, session.model, session.thinkingLevel, () => undefined);
		}

		/**
		 * Wire shape for one model. `effort_levels` mirrors the levels the model
		 * really supports (a non-reasoning model gets `["off"]`), and
		 * `reasoning_effort` is whatever the next turn will send: the live
		 * session level for the active model, the stored setting for the rest, and
		 * null when nothing was picked yet. `available` marks the models the CLI
		 * would also list; the rest are catalog rows without credentials.
		 */
		function modelInfos(models: Model<any>[], defaultKey: string): WebuiModelInfo[] {
			const current = session.model;
			const authenticated = authenticatedProviders();
			return models.map((model) => {
				const key = modelKey(model);
				const levels = getSupportedThinkingLevels(model).filter((level) => level !== "off");
				const effective = effortFor(model);
				const active = current?.provider === model.provider && current?.id === model.id;
				return {
					provider: key,
					model: model.id,
					provider_type: model.provider,
					is_default: defaultKey ? key === defaultKey : current ? active : false,
					supports_image: model.input.includes("image"),
					effort_applicable: levels.length > 0,
					reasoning_effort: effective ?? (levels.length > 0 ? null : "off"),
					effort_levels: levels,
					available: active || authenticated.has(model.provider),
				};
			});
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
				// The `/models` allowlist the CLI applies. The settings page marks
				// the rows outside it instead of implying they reach the picker.
				enabled_models: services.settingsManager.getEnabledModels() ?? [],
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

		/** The saved API key and extra headers of a models.json account. */
		async function storedAccountAuth(accountId: string | undefined): Promise<{
			apiKey: string | undefined;
			headers: Record<string, string> | undefined;
		}> {
			if (!accountId) return { apiKey: undefined, headers: undefined };
			try {
				const path = providerAccountsPath();
				return {
					apiKey: await readAccountApiKey(path, accountId),
					headers: await readAccountHeaders(path, accountId),
				};
			} catch {
				return { apiKey: undefined, headers: undefined };
			}
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
		// The session's cwd, not the process's: they differ after `/cd` or after a
		// `/chat` that named a `working_dir`, and the SPA keys its session list off
		// this hash.
		if (path === "/project" && req.method === "GET") {
			json(res, 200, {
				working_dir: sessionCwdOf(runtime),
				project_hash: projectHash(sessionCwdOf(runtime)),
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
				working_dir: sessionCwdOf(runtime),
				project_hash: projectHash(sessionCwdOf(runtime)),
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
				const detail = readSessionMessages(content);
				const { messages, thinking_level, plan } = detail;
				const active = runtime.session.sessionId === info.id;
				// The transcript records the thinking level per session; resuming this
				// session (the open one included) restores it, so the picker reports
				// the level the next turn will actually use.
				const level = active ? runtime.session.thinkingLevel : thinking_level;
				// The open session knows what it actually billed, the summarized branches
				// included; a transcript that cannot answer reports why instead.
				const stats = active ? sessionStatsOf(runtime.session.getSessionStats()) : detail.stats;
				json(res, 200, {
					id: info.id,
					name: info.name ?? "",
					working_dir: info.cwd,
					created_at: info.created.getTime(),
					updated_at: info.modified.getTime(),
					message_count: info.messageCount,
					thinking_level: level,
					messages,
					...(stats ? { stats } : {}),
					...(!stats && detail.stats_unavailable ? { stats_unavailable: detail.stats_unavailable } : {}),
					// The plan lives in tool details the messages above drop, so a
					// reloaded session would otherwise show no plan until the next todo
					// call; the transcript is the only record of it.
					...(plan ? { plan } : {}),
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
				const info = await findSessionFile(sessionId);
				if (!info) {
					json(res, 404, { error: "session not found" });
					return;
				}
				// Only the session being deleted has to be idle. Its turn runs on its own
				// runtime, so another tab's turn elsewhere neither blocks the delete nor
				// gets deleted underneath itself.
				if (runningTurns.has(info.id)) {
					json(res, 409, { error: "a turn is running in this session; stop it before deleting" });
					return;
				}
				if (info.id === runtime.session.sessionId) {
					await runtime.newSession();
				}
				sessionRuntimes.delete(info.path);
				await rm(info.path, { force: true });
				json(res, 200, {});
				return;
			}
		}

		// --- Chat (default transport) ---
		if (path === "/chat" && req.method === "POST") {
			const body = await readBody(req);
			const chatBody: ChatRequestBody = {
				message: typeof body.message === "string" ? body.message : "",
				approval_mode: typeof body.approval_mode === "string" ? body.approval_mode : undefined,
				session_id: typeof body.session_id === "string" ? body.session_id : undefined,
				request_id: typeof body.request_id === "string" ? body.request_id : undefined,
				provider: typeof body.provider === "string" ? body.provider : undefined,
				images: undefined,
			};
			if (Array.isArray(body.images)) {
				chatBody.images = body.images as { media_type: string; data: string }[];
			}
			// Which session the turn belongs to. An explicit id wins; without one the
			// process's own session answers, and a `working_dir` the SPA believes it is
			// in (it survives a `/cd`) may re-root that session first.
			let target = runtime;
			let targetId = runtime.session.sessionId;
			if (chatBody.session_id) {
				const info = await findSessionFile(chatBody.session_id);
				if (!info) {
					json(res, 404, { error: `session ${chatBody.session_id} not found` });
					return;
				}
				targetId = info.id;
				if (info.id !== runtime.session.sessionId) {
					target = await openRuntimeAt(info.path, sessionRuntimes);
				}
			} else if (typeof body.working_dir === "string" && body.working_dir) {
				const wanted = resolveWorkspacePath(body.working_dir, runtime.cwd);
				if (wanted && wanted !== sessionCwdOf(runtime) && (await isDirectory(wanted))) {
					try {
						await replaceSessionCwd(runtime, wanted, bindSession);
						targetId = runtime.session.sessionId;
					} catch {
						// Keep serving the current directory.
					}
				}
			}
			// The lock is per session: another tab on another session is not busy here.
			if (runningTurns.has(targetId)) {
				// A producer that cannot ask again later (a background job reporting in)
				// queues instead of taking a 409: the turn it lands in is real work whose
				// only reader is the transcript, and dropping it loses the report. The
				// prompt is written to the transcript when its turn starts, not when it
				// is queued, so answer now with what the queue accepted.
				if (body.queue === true) {
					chatQueue.push({ sessionId: targetId, body: chatBody });
					json(res, 200, { queued: true, position: chatQueue.length });
					return;
				}
				// The 409 names the turn that holds this session, so the UI can say which
				// tab is running it (and offer to stop that one) instead of "busy".
				json(res, 409, {
					error: "a turn is already running in this session",
					code: "busy",
					holder: runningTurns.get(targetId),
				});
				return;
			}
			// The provider adapters drop images for a model without image input and
			// send a placeholder instead (transform-messages.ts), so a turn with an
			// attachment on such a model costs tokens and answers nothing. Refuse it
			// here, where the browser can say which model to switch to.
			await applyTurnSettings(target, chatBody);
			const turnModel = target.session.model;
			if (chatBody.images?.length && turnModel && !turnModel.input.includes("image")) {
				json(res, 400, {
					error: `${turnModel.id} does not accept images; switch to a vision model and resend`,
					code: "model_without_image",
				});
				return;
			}
			startTurnOn(target, targetId, chatBody).attach(req, res);
			return;
		}
		// Stop one turn. `session_id` picks the session (without it the process's own
		// session answers) and `request_id` narrows that to the turn the browser
		// started, so two tabs on one session never stop each other's work either. A
		// stop that matches nothing answers 200 with `stopped: false` rather than
		// failing: the client's own abort already detached its stream, and a 404
		// there would only surface as a silent error.
		if (path === "/chat/stop" && req.method === "POST") {
			const body = await readBody(req);
			const wantedSession = typeof body.session_id === "string" ? body.session_id : undefined;
			const wantedTurn = typeof body.request_id === "string" ? body.request_id : undefined;
			const stopped: string[] = [];
			for (const [sessionId, holder] of [...runningTurns]) {
				if (wantedSession && !sameSessionId(sessionId, wantedSession)) continue;
				if (wantedTurn && holder.turn_id !== wantedTurn) continue;
				const target = await runtimeForRunningTurn(sessionId);
				if (!target) continue;
				stopped.push(holder.turn_id);
				await target.session.abort();
				// `abort()` waits for the settle, so the normal path already released the
				// lock; clearing it here keeps a turn that never emits `agent_settled`
				// from wedging its session.
				if (runningTurns.get(sessionId)?.turn_id === holder.turn_id) runningTurns.delete(sessionId);
			}
			json(res, 200, { stopped: stopped.length > 0, turns: stopped });
			return;
		}
		// Stop every turn in every session. Backs `/stop-all`; only sessions that are
		// really running are touched, so this never wakes an idle runtime.
		if (path === "/chat/stop-all" && req.method === "POST") {
			const stopped: string[] = [];
			for (const [sessionId, holder] of [...runningTurns]) {
				const target = await runtimeForRunningTurn(sessionId);
				if (!target) continue;
				stopped.push(holder.turn_id);
				await target.session.abort();
				if (runningTurns.get(sessionId)?.turn_id === holder.turn_id) runningTurns.delete(sessionId);
			}
			json(res, 200, { stopped: stopped.length > 0, turns: stopped });
			return;
		}
		// Sessions with a turn in flight, with the ids a client needs to tell its own
		// turn from another tab's.
		if (path === "/chat/active" && req.method === "GET") {
			// `wait_s` turns the poll into a long poll: the reply is sent when a turn
			// starts or settles, capped by the timeout. The browser cannot see a turn
			// it did not start (a job reporting in, a prompt queued behind the running
			// one) any other way, and a client that sends no `wait_s` keeps the
			// one-shot behaviour.
			const waitSeconds = Math.min(Math.max(Number(url.searchParams.get("wait_s") ?? "0"), 0), 30);
			if (!Number.isFinite(waitSeconds) || waitSeconds === 0) {
				json(res, 200, [...runningTurns.values()]);
				return;
			}
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					res.off("close", done);
					resolve();
				};
				const timer = setTimeout(() => {
					turnWaiters.delete(done);
					done();
				}, waitSeconds * 1000);
				turnWaiters.add(done);
				// A closed request must not hold a waiter, or a tab that went away
				// keeps a timer and a listener alive until it fires.
				res.on("close", () => {
					// Only the race lost: the waiter may have been cleared by a wake
					// already, and `done` is idempotent either way.
					turnWaiters.delete(done);
					done();
				});
			});
			if (res.writableEnded) return;
			json(res, 200, [...runningTurns.values()]);
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

		/**
		 * Live run-mode stream. The engine is process-wide and a mode also changes
		 * from inside a turn (the model leaving plan mode, a /mode command typed into
		 * the composer), so a client that only reads /approval_mode once would show a
		 * stale highlight. The first event carries the current mode, so one request
		 * both seeds and follows it.
		 */
		if (path === "/mode/stream" && req.method === "GET") {
			if (!extraBridge.available) {
				json(res, 404, { error: "run modes are not included in this build" });
				return;
			}
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const send = (mode: string, reason: string | undefined) => {
				if (res.writableEnded) return;
				res.write(`data: ${JSON.stringify({ mode, reason })}\n\n`);
			};
			const snapshot = extraBridge.engine.snapshot();
			send(snapshot.mode, snapshot.reason);
			const unsubscribe = extraBridge.engine.subscribe((next) => send(next.mode, next.reason));
			req.on("close", () => {
				unsubscribe();
				if (!res.writableEnded) res.end();
			});
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
		// Every /fs endpoint takes a path from the browser, so all of them resolve
		// through the workspace check: /fs/list and /fs/mkdir used to take the raw
		// string, which made the pair a read-anywhere / create-anywhere API.
		if (path === "/fs/list" && req.method === "GET") {
			const requested = url.searchParams.get("path") ?? "";
			const target = requested ? resolveWorkspacePath(requested, runtime.cwd) : runtime.cwd;
			if (!target) {
				json(res, 403, { error: `outside the workspace: ${requested}` });
				return;
			}
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
			const requested = typeof body.path === "string" ? body.path : "";
			const target = requested ? resolveWorkspacePath(requested, runtime.cwd) : undefined;
			if (!target) {
				json(res, requested ? 403 : 400, {
					error: requested ? `outside the workspace: ${requested}` : "path is required",
				});
				return;
			}
			await mkdir(target, { recursive: true });
			json(res, 200, { path: target });
			return;
		}
		// The host cannot focus an external editor, so the viewer reads files over
		// HTTP instead: the same bytes an editor would show, plus whether they are
		// binary (the viewer shows a notice) and the size cap that keeps the API
		// from buffering large assets.
		if (path === "/fs/read" && req.method === "GET") {
			const requested = url.searchParams.get("path") ?? "";
			const target = requested ? resolveWorkspacePath(requested, runtime.cwd) : "";
			if (!target) {
				json(res, requested ? 403 : 400, {
					error: requested ? `outside the workspace: ${requested}` : "path is required",
				});
				return;
			}
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(target);
			} catch {
				json(res, 404, { error: `not found: ${requested}` });
				return;
			}
			if (!info.isFile()) {
				json(res, 400, { error: `not a file: ${requested}` });
				return;
			}
			if (info.size > MAX_VIEWABLE_FILE_BYTES) {
				json(res, 200, {
					path: target,
					size: info.size,
					binary: true,
					content: "",
					truncated: true,
				});
				return;
			}
			const buffer = await readFile(target);
			const binary = buffer.includes(0);
			json(res, 200, {
				path: target,
				size: info.size,
				binary,
				content: binary ? "" : buffer.toString("utf8"),
				truncated: false,
			});
			return;
		}
		if (path === "/fs/write" && req.method === "POST") {
			const body = await readBody(req);
			const requested = typeof body.path === "string" ? body.path : "";
			const target = requested ? resolveWorkspacePath(requested, runtime.cwd) : "";
			const content = typeof body.content === "string" ? body.content : undefined;
			if (!target) {
				json(res, requested ? 403 : 400, {
					error: requested ? `outside the workspace: ${requested}` : "path is required",
				});
				return;
			}
			if (content === undefined) {
				json(res, 400, { error: "content is required" });
				return;
			}
			await writeFile(target, content, "utf8");
			json(res, 200, { path: target, size: Buffer.byteLength(content) });
			return;
		}
		// Keep the endpoint for older clients: report success so the caller falls
		// back to its inline viewer instead of showing a hard failure.
		if (path === "/fs/open" && req.method === "POST") {
			json(res, 200, { opened: false, reason: "the host cannot focus an external editor" });
			return;
		}

		// --- Working directory ---
		// Switching means opening sessions rooted elsewhere: the runtime's own cwd is
		// fixed for the process. The switch is real from here on — the runtime's
		// sessions, `/project`, the default-directory terminal, and the `working_dir`
		// the SPA echoes on `/chat` all report `target`, not the launch directory. A
		// request that cannot be honoured says so instead of answering with the old
		// directory and no error (#595).
		if (path === "/cd" && req.method === "POST") {
			const body = await readBody(req);
			const requested = typeof body.path === "string" ? body.path.trim() : "";
			const target = requested ? resolveWorkspacePath(requested, runtime.cwd) : "";
			if (!target || !(await isDirectory(target))) {
				json(res, 400, {
					success: false,
					message:
						requested && !target
							? `outside the workspace: ${requested}`
							: `not a directory: ${requested || "(empty)"}`,
					current_dir: runtime.cwd,
					project_hash: projectHash(runtime.cwd),
				});
				return;
			}
			// `/cd` re-roots the process's own session, so only a turn on *that*
			// session blocks it: a turn another tab runs in another session is not
			// moving any directory this request touches.
			if (runningTurns.has(runtime.session.sessionId)) {
				// The running turn, its transcript and its tool results belong to the
				// directory it started in; moving underneath it would split a session
				// across two places with no way to tell which is which.
				json(res, 409, {
					success: false,
					message: "a turn is running; stop it before switching directories",
					current_dir: runtime.cwd,
					project_hash: projectHash(runtime.cwd),
				});
				return;
			}
			try {
				await replaceSessionCwd(runtime, target, bindSession);
			} catch (error) {
				json(res, 400, {
					success: false,
					message: (error as Error).message,
					current_dir: runtime.cwd,
					project_hash: projectHash(runtime.cwd),
				});
				return;
			}
			json(res, 200, {
				success: true,
				message: "",
				current_dir: sessionCwdOf(runtime),
				project_hash: projectHash(sessionCwdOf(runtime)),
			});
			return;
		}

		// --- MCP ---
		if (path === "/mcp/status" && req.method === "GET") {
			json(res, 200, mcpStatusPayload(sessionCwdOf(runtime), runtime.session.settingsManager.isProjectTrusted()));
			return;
		}
		if (path === "/command" && req.method === "POST") {
			json(res, 200, { kind: "error", message: "slash commands are not available in the webui yet" });
			return;
		}
		if (path === "/providers/discover-models" && req.method === "POST") {
			const body = await readBody(req);
			// The settings page reloads an existing account, so a blank key and base
			// URL mean "the ones already saved" rather than "none".
			const accounts = await listAccounts(providerAccountsPath());
			const accountId = str(body.provider_id);
			const account = accountId ? accounts.find((entry) => entry.id === accountId) : undefined;
			const saved = await storedAccountAuth(accountId);
			// A vendor with per-site keys is probed by its hosts, so the form does not
			// have to know which site issued the key. Asking for `preset` overrides a
			// base URL the user typed: an explicit host and "find my site" disagree.
			const site = PROVIDER_PRESETS.find((preset) => preset.id === str(body.preset))?.site_endpoints;
			try {
				const listing = await discoverModels({
					type: str(body.type) ?? account?.type ?? "openai",
					base_url: str(body.base_url) ?? account?.base_url,
					api_key: str(body.api_key) ?? saved.apiKey,
					headers: saved.headers,
					site,
				});
				json(res, 200, listing);
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

		json(res, 404, { error: `no such endpoint: ${req.method} ${path}` });
	}

	// Warm the catalog the way the CLI does at startup, so the first page load
	// sees the same model list `nanopi --list-models` prints. Interactive mode
	// runs this only its own way; the webui has no catalog refresh otherwise,
	// and the frontend asks for /models as soon as it mounts.
	if (!process.env.NANOPI_OFFLINE) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void runtime.services.modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	await new Promise<void>((_resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			const bound = server.address();
			const actualPort = typeof bound === "object" && bound ? bound.port : port;
			const url = `http://${host}:${actualPort}`;
			// One write: the URL is the only way into a token-protected server, and
			// separate lines can interleave with a host that redirects stdout.
			const lines = [`nanopi webui listening on ${url}`];
			if (!distExists) {
				lines.push("webui assets are missing; run `pnpm --filter @nanopi/webui run build` and restart.");
			}
			lines.push(`Open: ${url}/?token=${token}`);
			lines.push("Press Ctrl+C to stop.");
			console.log(lines.join("\n"));
		});
		// Keep running until the process is killed.
	});
}
