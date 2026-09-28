import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

/** Hidden CLI flag that turns a pi process into the llama.cpp supervisor. */
export const LLAMA_SUPERVISOR_FLAG = "--internal-llama-supervisor";
/** Environment variable carrying the JSON supervisor configuration. */
export const LLAMA_SUPERVISOR_CONFIG_ENV = "PI_LLAMA_SUPERVISOR_CONFIG";

const LISTEN_PATTERN = /listening on (https?:\/\/\S+)/u;
// The router forwards model instance logs as "[ port] line"; those instances listen on their own ports.
const CHILD_LOG_PATTERN = /^\s*\[\s*\d+\]/u;
// Appended last to every managed llama-server command line; identifies orphaned servers in `ps` output.
const MANAGED_ARGS = ["--host", "127.0.0.1", "--port", "0"];
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 10_000;
// The pi process that launched the supervisor connects shortly after, possibly after other short-lived probe
// connections. Never idle out during this window, even with a tiny idle delay.
const STARTUP_GRACE_MS = 10_000;

export interface LlamaSupervisorConfig {
	command: string;
	args: string[];
	modelsDir: string;
	stateDir: string;
	idleShutdownMs: number;
	hfToken?: string;
	readyTimeoutMs?: number;
	startupGraceMs?: number;
}

export interface ManagedLlamaServerInfo {
	url: string;
	apiKey: string;
	modelsDir: string;
	cacheDir: string;
	logPath: string;
}

export type SupervisorMessage =
	| { type: "starting" }
	| { type: "ready"; server: ManagedLlamaServerInfo }
	| { type: "stopping" }
	| { type: "error"; message: string };

export type SupervisorRequest = { type: "stop" };

export function llamaSocketPath(stateDir: string): string {
	if (process.platform === "win32") {
		const hash = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
		return `\\\\.\\pipe\\pi-llama-${hash}-v1`;
	}
	const path = join(stateDir, "supervisor-v1.sock");
	// sun_path is limited to 104 bytes on macOS and 108 bytes on Linux.
	if (Buffer.byteLength(path) > 100) throw new Error(`llama.cpp supervisor socket path is too long: ${path}`);
	return path;
}

export function llamaLogPath(stateDir: string): string {
	return join(stateDir, "server.log");
}

function serverStatePath(stateDir: string): string {
	return join(stateDir, "server.json");
}

/** Mirrors llama.cpp's Hugging Face cache lookup (common/hf-cache.cpp), where router downloads are stored. */
export function huggingFaceCacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const entries: [string, string[]][] = [
		["LLAMA_CACHE", []],
		["HF_HUB_CACHE", []],
		["HUGGINGFACE_HUB_CACHE", []],
		["HF_HOME", ["hub"]],
		["XDG_CACHE_HOME", ["huggingface", "hub"]],
		[process.platform === "win32" ? "USERPROFILE" : "HOME", [".cache", "huggingface", "hub"]],
	];
	for (const [name, suffix] of entries) {
		const value = env[name];
		if (value) return join(value, ...suffix);
	}
	return join(homedir(), ".cache", "huggingface", "hub");
}

export function encodeMessage(message: SupervisorMessage | SupervisorRequest): string {
	return `${JSON.stringify(message)}\n`;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function listenOn(path: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve(server);
		});
	});
}

function canConnect(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/** Listen on the supervisor socket, or return undefined when another live supervisor owns it. */
async function listenExclusive(path: string): Promise<Server | undefined> {
	try {
		return await listenOn(path);
	} catch (error) {
		if (errorCode(error) !== "EADDRINUSE") throw error;
	}
	if (process.platform === "win32" || (await canConnect(path))) return undefined;
	// A socket file nobody accepts on belongs to a crashed supervisor.
	await rm(path, { force: true });
	try {
		return await listenOn(path);
	} catch (error) {
		if (errorCode(error) === "EADDRINUSE") return undefined;
		throw error;
	}
}

function processCommandLine(pid: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 2_000 }, (error, stdout) => {
			resolve(error ? undefined : stdout.trim());
		});
	});
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Owns one llama-server router process. Every connected pi process holds one socket connection; the
 * operating system closes it when pi exits or crashes, so the connection count is the reference count.
 */
export class LlamaSupervisor {
	readonly done: Promise<void>;
	private readonly config: LlamaSupervisorConfig;
	private readonly server: Server;
	private readonly apiKey = randomBytes(24).toString("hex");
	private readonly startedAt = Date.now();
	private readonly clients = new Set<Socket>();
	private readonly log: WriteStream;
	private state: SupervisorMessage = { type: "starting" };
	private child: ChildProcess | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private stopping: Promise<void> | undefined;
	private resolveDone!: () => void;

	private constructor(config: LlamaSupervisorConfig, server: Server) {
		this.config = config;
		this.server = server;
		this.log = createWriteStream(llamaLogPath(config.stateDir), { flags: "w" });
		this.log.on("error", () => {});
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	/** Start supervising, or return undefined when another supervisor already owns the socket. */
	static async start(config: LlamaSupervisorConfig): Promise<LlamaSupervisor | undefined> {
		await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
		const server = await listenExclusive(llamaSocketPath(config.stateDir));
		if (!server) return undefined;
		const supervisor = new LlamaSupervisor(config, server);
		server.on("connection", (socket) => supervisor.accept(socket));
		supervisor.armIdleTimer();
		void supervisor.run();
		return supervisor;
	}

	shutdown(reason: string): Promise<void> {
		this.stopping ??= this.stop(reason);
		return this.stopping;
	}

	private writeLog(line: string): void {
		this.log.write(`${line}\n`);
	}

	private note(message: string): void {
		this.writeLog(`[pi ${new Date().toISOString()}] ${message}`);
	}

	private send(socket: Socket, message: SupervisorMessage): void {
		if (!socket.destroyed) socket.write(encodeMessage(message));
	}

	private broadcast(message: SupervisorMessage): void {
		this.state = message;
		for (const socket of this.clients) this.send(socket, message);
	}

	private armIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		const delayMs = Math.max(
			this.config.idleShutdownMs,
			(this.config.startupGraceMs ?? STARTUP_GRACE_MS) - (Date.now() - this.startedAt),
		);
		this.idleTimer = setTimeout(() => void this.shutdown("no pi processes connected"), delayMs);
	}

	private accept(socket: Socket): void {
		socket.on("error", () => {});
		if (this.stopping) {
			socket.end(encodeMessage({ type: "stopping" }));
			return;
		}
		this.clients.add(socket);
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		socket.on("close", () => {
			this.clients.delete(socket);
			if (this.clients.size === 0 && !this.stopping) this.armIdleTimer();
		});
		createInterface({ input: socket }).on("line", (line) => {
			try {
				const request = JSON.parse(line) as SupervisorRequest;
				if (request.type === "stop") void this.shutdown("stop requested");
			} catch {
				// Ignore malformed requests.
			}
		});
		this.send(socket, this.state);
		// A failed supervisor exits once a client received the error, so a retry starts over with fresh settings.
		if (this.state.type === "error") void this.shutdown("startup failed");
	}

	private async run(): Promise<void> {
		try {
			await this.stopOrphanedServer();
			await mkdir(this.config.modelsDir, { recursive: true });
			const url = await this.startServer();
			if (this.stopping) return;
			this.note(`llama-server ready at ${url}`);
			this.broadcast({
				type: "ready",
				server: {
					url,
					apiKey: this.apiKey,
					modelsDir: this.config.modelsDir,
					cacheDir: huggingFaceCacheDir(this.childEnv()),
					logPath: llamaLogPath(this.config.stateDir),
				},
			});
		} catch (error) {
			if (this.stopping) return;
			const message = `${errorMessage(error)}; see ${llamaLogPath(this.config.stateDir)}`;
			this.note(message);
			this.broadcast({ type: "error", message });
			await this.stopChild();
			// Without clients, stay up until the idle timer fires so the launching client still receives the error.
			if (this.clients.size > 0) void this.shutdown("startup failed");
		}
	}

	private childEnv(): NodeJS.ProcessEnv {
		return {
			...process.env,
			...(this.config.hfToken && !process.env.HF_TOKEN ? { HF_TOKEN: this.config.hfToken } : {}),
			LLAMA_API_KEY: this.apiKey,
		};
	}

	/** A supervisor killed with SIGKILL leaves its llama-server running; stop it before starting another. */
	private async stopOrphanedServer(): Promise<void> {
		if (process.platform === "win32") return;
		let pid: unknown;
		try {
			pid = (JSON.parse(await readFile(serverStatePath(this.config.stateDir), "utf8")) as { pid?: unknown }).pid;
		} catch {
			return;
		}
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return;
		const commandLine = await processCommandLine(pid);
		if (!commandLine?.includes(MANAGED_ARGS.join(" "))) return;
		this.note(`stopping orphaned llama-server pid=${pid}`);
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
		const deadline = Date.now() + SHUTDOWN_GRACE_MS;
		while (isAlive(pid) && Date.now() < deadline) await sleep(100);
		if (isAlive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already exited.
			}
		}
	}

	private async startServer(): Promise<string> {
		const args = [...this.config.args, "--models-dir", this.config.modelsDir, ...MANAGED_ARGS];
		this.note(`starting ${[this.config.command, ...args].join(" ")}`);
		const child = spawn(this.config.command, args, {
			cwd: this.config.stateDir,
			env: this.childEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		// Written synchronously: awaiting here would miss the child's "error" event for a missing command.
		if (child.pid !== undefined)
			writeFileSync(serverStatePath(this.config.stateDir), JSON.stringify({ pid: child.pid }));

		let lastLine = "";
		const describeExit = (code: number | null, signal: NodeJS.Signals | null) =>
			`${signal ?? `code ${code}`}${lastLine ? `: ${lastLine}` : ""}`;
		const url = await new Promise<string>((resolve, reject) => {
			const timeoutMs = this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
			const timeout = setTimeout(
				() => reject(new Error(`llama-server did not start within ${Math.round(timeoutMs / 1000)}s`)),
				timeoutMs,
			);
			const onLine = (line: string) => {
				this.writeLog(line);
				if (line.trim()) lastLine = line.trim();
				const match = CHILD_LOG_PATTERN.test(line) ? undefined : LISTEN_PATTERN.exec(line);
				if (!match?.[1]) return;
				clearTimeout(timeout);
				resolve(match[1].replace(/\/+$/u, ""));
			};
			createInterface({ input: child.stdout! }).on("line", onLine);
			createInterface({ input: child.stderr! }).on("line", onLine);
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(new Error(`Could not start ${this.config.command}: ${error.message}`));
			});
			child.once("exit", (code, signal) => {
				clearTimeout(timeout);
				reject(new Error(`llama-server exited during startup (${describeExit(code, signal)})`));
			});
		});
		child.once("exit", (code, signal) => {
			if (this.stopping) return;
			const message = `llama-server exited unexpectedly (${describeExit(code, signal)}); see ${llamaLogPath(this.config.stateDir)}`;
			this.note(message);
			this.broadcast({ type: "error", message });
			void this.shutdown("llama-server exited");
		});

		const deadline = Date.now() + (this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
		while (!this.stopping) {
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error("llama-server exited during startup");
			try {
				const response = await fetch(`${url}/health`, {
					headers: { Authorization: `Bearer ${this.apiKey}` },
					signal: AbortSignal.timeout(2_000),
				});
				if (response.ok) return url;
			} catch {
				// Not accepting requests yet.
			}
			if (Date.now() > deadline) throw new Error(`llama-server at ${url} did not become healthy`);
			await sleep(100);
		}
		return url;
	}

	private async stopChild(): Promise<void> {
		const child = this.child;
		if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGTERM");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const graceful = await Promise.race([
			exited.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
			}),
		]);
		clearTimeout(timer);
		if (!graceful) {
			this.note(`llama-server pid=${child.pid} did not exit; sending SIGKILL`);
			child.kill("SIGKILL");
			await exited;
		}
	}

	private async stop(reason: string): Promise<void> {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.note(`stopping: ${reason}`);
		if (this.state.type !== "error") this.broadcast({ type: "stopping" });
		try {
			await this.stopChild();
		} catch (error) {
			this.note(`failed to stop llama-server: ${errorMessage(error)}`);
		}
		await rm(serverStatePath(this.config.stateDir), { force: true });
		for (const socket of this.clients) {
			// end() flushes a pending error message before closing; destroy() would drop it.
			socket.end();
			setTimeout(() => socket.destroy(), 1_000).unref();
		}
		// Close the socket last: new clients see "stopping" until the old server is gone.
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		this.note("stopped");
		await new Promise<void>((resolve) => this.log.end(() => resolve()));
		this.resolveDone();
	}
}

function parseConfig(raw: string | undefined): LlamaSupervisorConfig {
	if (!raw) throw new Error(`${LLAMA_SUPERVISOR_CONFIG_ENV} is not set`);
	const value = JSON.parse(raw) as Partial<LlamaSupervisorConfig>;
	if (
		typeof value.command !== "string" ||
		!Array.isArray(value.args) ||
		!value.args.every((arg) => typeof arg === "string") ||
		typeof value.modelsDir !== "string" ||
		typeof value.stateDir !== "string" ||
		typeof value.idleShutdownMs !== "number"
	) {
		throw new Error(`Invalid ${LLAMA_SUPERVISOR_CONFIG_ENV}`);
	}
	return {
		command: value.command,
		args: value.args,
		modelsDir: value.modelsDir,
		stateDir: value.stateDir,
		idleShutdownMs: value.idleShutdownMs,
		...(typeof value.hfToken === "string" ? { hfToken: value.hfToken } : {}),
	};
}

/** Entry point for `pi --internal-llama-supervisor`, started detached by managed llama.cpp clients. */
export async function runLlamaSupervisorProcess(): Promise<void> {
	process.title = "pi-llama-supervisor";
	const raw = process.env[LLAMA_SUPERVISOR_CONFIG_ENV];
	delete process.env[LLAMA_SUPERVISOR_CONFIG_ENV];
	const supervisor = await LlamaSupervisor.start(parseConfig(raw));
	if (!supervisor) process.exit(0);
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, () => void supervisor.shutdown(`received ${signal}`));
	}
	await supervisor.done;
	process.exit(0);
}
