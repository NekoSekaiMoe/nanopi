import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { expandTildePath, getAgentDir, isBunBinary } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { findHuggingFaceToken } from "./huggingface.ts";
import {
	encodeMessage,
	LLAMA_SUPERVISOR_CONFIG_ENV,
	LLAMA_SUPERVISOR_FLAG,
	type LlamaSupervisorConfig,
	llamaLogPath,
	llamaSocketPath,
	type ManagedLlamaServerInfo,
	type SupervisorMessage,
} from "./supervisor.ts";

export type { ManagedLlamaServerInfo } from "./supervisor.ts";

const CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_SHUTDOWN_SECONDS = 30;

const RESERVED_ARGS = new Map<string, string>([
	["--host", "pi binds llama-server to 127.0.0.1"],
	["--port", "pi picks a random free port"],
	["--api-key", "pi generates a random API key"],
	["--api-key-file", "pi generates a random API key"],
	["--models-dir", "use llamaCpp.modelsDir"],
	["-m", "managed llama-server runs in router mode"],
	["--model", "managed llama-server runs in router mode"],
	["-mu", "managed llama-server runs in router mode"],
	["--model-url", "managed llama-server runs in router mode"],
	["-hf", "managed llama-server runs in router mode"],
	["-hfr", "managed llama-server runs in router mode"],
	["--hf-repo", "managed llama-server runs in router mode"],
]);

export interface ManagedLlamaSettings {
	command: string;
	args: string[];
	modelsDir: string;
	idleShutdownSeconds: number;
}

/** Read `llamaCpp` from global settings and apply defaults. Throws on invalid values. */
export function loadManagedLlamaSettings(agentDir: string = getAgentDir()): ManagedLlamaSettings {
	const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getLlamaCppSettings();
	const command = settings.command ?? "llama-server";
	if (typeof command !== "string" || !command.trim()) throw new Error("llamaCpp.command must be a non-empty string");
	const args = settings.args ?? [];
	if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
		throw new Error("llamaCpp.args must be an array of strings");
	}
	for (const arg of args) {
		const reason = RESERVED_ARGS.get(arg.split("=", 1)[0]!);
		if (reason) throw new Error(`llamaCpp.args must not contain ${arg}: ${reason}`);
	}
	const modelsDir = settings.modelsDir ?? join(agentDir, "llama", "models");
	if (typeof modelsDir !== "string" || !modelsDir.trim()) {
		throw new Error("llamaCpp.modelsDir must be a non-empty string");
	}
	const idleShutdownSeconds = settings.idleShutdownSeconds ?? DEFAULT_IDLE_SHUTDOWN_SECONDS;
	if (typeof idleShutdownSeconds !== "number" || !Number.isFinite(idleShutdownSeconds) || idleShutdownSeconds < 0) {
		throw new Error("llamaCpp.idleShutdownSeconds must be a non-negative number");
	}
	return {
		command: expandTildePath(command.trim()),
		args,
		modelsDir: resolve(expandTildePath(modelsDir.trim())),
		idleShutdownSeconds,
	};
}

/** Start `pi --internal-llama-supervisor` detached, so it outlives the pi process that started it. */
export function launchSupervisorProcess(config: LlamaSupervisorConfig): void {
	let args: string[];
	if (isBunBinary) {
		args = [LLAMA_SUPERVISOR_FLAG];
	} else {
		const entrypoint = process.argv[1];
		if (!entrypoint) throw new Error("Cannot locate the pi entrypoint to start the llama.cpp supervisor");
		// Keep loader flags (e.g. TypeScript support in source checkouts) but not debugger ports.
		const execArgv = process.execArgv.filter((arg) => !arg.startsWith("--inspect"));
		args = [...execArgv, entrypoint, LLAMA_SUPERVISOR_FLAG];
	}
	const child = spawn(process.execPath, args, {
		cwd: config.stateDir,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: { ...process.env, [LLAMA_SUPERVISOR_CONFIG_ENV]: JSON.stringify(config) },
	});
	// Launch failures surface as a connection timeout.
	child.on("error", () => {});
	child.unref();
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function openSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.off("error", reject);
			socket.on("error", () => {});
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

/** Deliver supervisor messages from `socket`; `onClose` runs once when the connection ends. */
function readMessages(socket: Socket, onMessage: (message: SupervisorMessage) => void, onClose: () => void): void {
	createInterface({ input: socket }).on("line", (line) => {
		try {
			onMessage(JSON.parse(line) as SupervisorMessage);
		} catch {
			// Ignore malformed messages.
		}
	});
	socket.once("close", onClose);
}

type WaitResult = Exclude<SupervisorMessage, { type: "starting" }> | { type: "closed" };

function waitForState(socket: Socket, timeoutMs: number): Promise<WaitResult> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve({ type: "closed" }), timeoutMs);
		const finish = (result: WaitResult) => {
			clearTimeout(timeout);
			resolve(result);
		};
		readMessages(
			socket,
			(message) => {
				if (message.type !== "starting") finish(message);
			},
			() => finish({ type: "closed" }),
		);
	});
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Cancelled"));
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/**
 * Holds this process's reference on the shared supervisor. The connection stays open until the process exits
 * or `release()` runs; it is unref'd so it never keeps pi alive.
 */
export class ManagedLlamaClient {
	private readonly socketPath: string;
	private readonly launch: (config: LlamaSupervisorConfig) => void;
	private connection: { socket: Socket; server: ManagedLlamaServerInfo } | undefined;
	private pending: Promise<ManagedLlamaServerInfo> | undefined;

	constructor(stateDir: string, launch: (config: LlamaSupervisorConfig) => void = launchSupervisorProcess) {
		this.socketPath = llamaSocketPath(stateDir);
		this.launch = launch;
	}

	/** Connect to the running supervisor, starting one with `config` when none is running. */
	acquire(config: () => Promise<LlamaSupervisorConfig>, signal?: AbortSignal): Promise<ManagedLlamaServerInfo> {
		if (this.connection) return Promise.resolve(this.connection.server);
		this.pending ??= this.connect(config).finally(() => {
			this.pending = undefined;
		});
		return raceAbort(this.pending, signal);
	}

	/** Return the running server without starting one or taking a reference. */
	async probe(): Promise<ManagedLlamaServerInfo | undefined> {
		if (this.connection) return this.connection.server;
		let socket: Socket;
		try {
			socket = await openSocket(this.socketPath);
		} catch {
			return undefined;
		}
		try {
			const result = await waitForState(socket, 2_000);
			return result.type === "ready" ? result.server : undefined;
		} finally {
			socket.destroy();
		}
	}

	/** Ask the supervisor to stop its server and exit. Other pi processes lose their connection too. */
	async stop(): Promise<void> {
		let socket = this.connection?.socket;
		this.connection = undefined;
		if (!socket) {
			try {
				socket = await openSocket(this.socketPath);
			} catch {
				return;
			}
		}
		if (socket.destroyed) return;
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		socket.write(encodeMessage({ type: "stop" }));
		await closed;
	}

	release(): void {
		this.connection?.socket.destroy();
		this.connection = undefined;
	}

	private async connect(loadConfig: () => Promise<LlamaSupervisorConfig>): Promise<ManagedLlamaServerInfo> {
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		let launched = false;
		let config: LlamaSupervisorConfig | undefined;
		while (true) {
			let socket: Socket | undefined;
			try {
				socket = await openSocket(this.socketPath);
			} catch (error) {
				const code = errorCode(error);
				if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
				if (!launched) {
					config ??= await loadConfig();
					await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
					this.launch(config);
					launched = true;
				}
			}
			if (socket) {
				const result = await waitForState(socket, Math.max(0, deadline - Date.now()));
				if (result.type === "ready") {
					this.adopt(socket, result.server);
					return result.server;
				}
				socket.destroy();
				if (result.type === "error") throw new Error(result.message);
				// The supervisor is shutting down. Start a new one once its socket is gone.
				launched = false;
			}
			if (Date.now() > deadline) {
				const logPath = config ? `; see ${llamaLogPath(config.stateDir)}` : "";
				throw new Error(`Timed out waiting for the managed llama-server${logPath}`);
			}
			await sleep(socket ? 250 : 100);
		}
	}

	private adopt(socket: Socket, server: ManagedLlamaServerInfo): void {
		const connection = { socket, server };
		this.connection = connection;
		socket.unref();
		const drop = () => {
			if (this.connection === connection) this.connection = undefined;
			socket.destroy();
		};
		readMessages(
			socket,
			(message) => {
				if (message.type === "stopping" || message.type === "error") drop();
			},
			drop,
		);
	}
}

export interface ManagedLlama {
	/** Start or join the shared server and keep a reference until this process exits. */
	acquire(signal?: AbortSignal): Promise<ManagedLlamaServerInfo>;
	/** Return the running server without starting one. */
	probe(): Promise<ManagedLlamaServerInfo | undefined>;
	/** Stop the shared server and start a new one with the current settings. */
	restart(signal?: AbortSignal): Promise<ManagedLlamaServerInfo>;
	/** Check that the configured command runs; returns its version, e.g. "8680 (15f786e65)". */
	verify(signal?: AbortSignal): Promise<string>;
}

export function createManagedLlama(
	agentDir: string = getAgentDir(),
	launch?: (config: LlamaSupervisorConfig) => void,
): ManagedLlama {
	const stateDir = join(agentDir, "llama");
	let client: ManagedLlamaClient | undefined;
	const getClient = () => {
		client ??= new ManagedLlamaClient(stateDir, launch);
		return client;
	};
	const loadConfig = async (): Promise<LlamaSupervisorConfig> => {
		const settings = loadManagedLlamaSettings(agentDir);
		const hfToken = await findHuggingFaceToken();
		return {
			command: settings.command,
			args: settings.args,
			modelsDir: settings.modelsDir,
			stateDir,
			idleShutdownMs: settings.idleShutdownSeconds * 1000,
			...(hfToken ? { hfToken } : {}),
		};
	};
	return {
		acquire: (signal) => getClient().acquire(loadConfig, signal),
		probe: () => getClient().probe(),
		restart: async (signal) => {
			await getClient().stop();
			return getClient().acquire(loadConfig, signal);
		},
		verify: (signal) => {
			const { command } = loadManagedLlamaSettings(agentDir);
			return new Promise((resolve, reject) => {
				execFile(
					command,
					["--version"],
					{ timeout: 15_000, signal, windowsHide: true },
					(error, stdout, stderr) => {
						if (error) {
							reject(
								new Error(
									`Could not run ${command} --version: ${error.message}. Install llama.cpp or set llamaCpp.command in settings.json`,
								),
							);
							return;
						}
						const output = `${stdout}\n${stderr}`;
						const version = output.split("\n").find((line) => line.startsWith("version:"));
						resolve(version ? version.slice("version:".length).trim() : output.trim());
					},
				);
			});
		},
	};
}
