import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { RpcConnection } from "./jsonrpc.ts";
import { Methods, type CallHierarchyItem, type Diagnostic, type DocumentSymbol, type Hover, type Location, type SymbolInformation, type TextEdit, type WorkspaceEdit } from "./lsp-types.ts";
import { requestTimeoutFor, type LspServerConfig } from "./config.ts";
import type { Budget } from "./budget.ts";

const STARTUP_TIMEOUT_MS = 30_000;

export function filePathToUri(file: string): string {
	return `file://${encodeURI(file.split(path.sep).join("/")).replace(/[?#]/g, encodeURIComponent)}`;
}

export function uriToFilePath(uri: string): string {
	return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

export interface OpenDocument {
	file: string;
	uri: string;
	languageId: string;
	version: number;
	text: string;
}

const NO_SIGNAL = new AbortController().signal;

function abortMessage(reason: string, timeoutMs?: number): string {
	return timeoutMs === undefined ? `${reason} cancelled by caller` : `${reason} timed out after ${timeoutMs}ms`;
}

/** Combines the caller's abort signal with a deadline; `timeoutMs` undefined arms none. */
function deadlineSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; done: () => void } {
	if (timeoutMs === undefined && !signal) return { signal: NO_SIGNAL, done: () => undefined };
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
	timer?.unref?.();
	return {
		signal: controller.signal,
		done: () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

interface ServerCapabilitiesLike {
	callHierarchyProvider?: unknown;
	renameProvider?: unknown;
	hoverProvider?: unknown;
	definitionProvider?: unknown;
	textDocumentSync?: number | { save?: unknown };
}

export class LspClient {
	private process: ChildProcessWithoutNullStreams | undefined;
	private connection: RpcConnection | undefined;
	private capabilities: ServerCapabilitiesLike | undefined;
	private readonly documents = new Map<string, OpenDocument>();
	private startPromise: Promise<void> | undefined;
	private failureReason: string | undefined;
	private stderrTail = "";

	readonly server: LspServerConfig;
	readonly root: string;
	private readonly command: { bin: string; args: string[] };
	private readonly onDiagnostics: (file: string, diagnostics: Diagnostic[]) => void;

	constructor(
		server: LspServerConfig,
		root: string,
		command: { bin: string; args: string[] },
		onDiagnostics: (file: string, diagnostics: Diagnostic[]) => void,
	) {
		this.server = server;
		this.root = root;
		this.command = command;
		this.onDiagnostics = onDiagnostics;
	}

	get dead(): boolean {
		return !!this.failureReason;
	}

	get reason(): string | undefined {
		return this.failureReason;
	}

	get supportsCallHierarchy(): boolean {
		return !!this.capabilities?.callHierarchyProvider;
	}

	get supportsRename(): boolean {
		return !!this.capabilities?.renameProvider;
	}

	get supportsHover(): boolean {
		return !!this.capabilities?.hoverProvider;
	}

	get supportsDefinition(): boolean {
		return !!this.capabilities?.definitionProvider;
	}

	async ensureStarted(signal?: AbortSignal): Promise<void> {
		if (this.connection && !this.failureReason) return;
		if (this.failureReason) throw new Error(this.failureReason);
		this.startPromise ??= this.start(signal);
		await this.startPromise;
	}

	private async start(signal?: AbortSignal): Promise<void> {
		const child = spawn(this.command.bin, this.command.args, {
			cwd: this.root,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-2000);
		});
		child.on("exit", (code, sig) => {
			this.fail(`${this.server.id}: server exited (${code ?? sig ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
		});
		child.on("error", (error: Error) => {
			this.fail(`${this.server.id}: spawn failed: ${error.message}`);
		});

		const connection = new RpcConnection(child.stdout, child.stdin);
		this.connection = connection;
		this.registerHandlers(connection);

		const startup = deadlineSignal(undefined, STARTUP_TIMEOUT_MS);
		const init = await connection
			.sendRequest<{ capabilities: ServerCapabilitiesLike }>(Methods.initialize, this.initializeParams(), startup.signal)
			.finally(startup.done);
		this.capabilities = init.capabilities;

		await connection.sendNotification(Methods.initialized, {});
		if (this.server.settings !== undefined) {
			await connection.sendNotification(Methods.didChangeConfig, { settings: this.server.settings });
		}
		if (signal?.aborted) throw new Error("aborted");
	}

	private fail(reason: string): void {
		this.failureReason = reason;
		try {
			this.connection?.dispose();
		} catch {
			// dispose may reject pending responses; ignore
		}
		this.connection = undefined;
	}

	private initializeParams() {
		const rootUri = filePathToUri(this.root);
		return {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ name: path.basename(this.root), uri: rootUri }],
			capabilities: {
				window: { workDoneProgress: true },
				workspace: { configuration: true, workspaceFolders: true },
				textDocument: {
					synchronization: { didOpen: true, didChange: true, didSave: true },
					publishDiagnostics: { relatedInformation: true },
					references: {},
					rename: {},
					documentSymbol: {},
					callHierarchy: {},
					hover: { contentFormat: ["markdown", "plaintext"] },
					definition: {},
				},
			},
			initializationOptions: this.server.initializationOptions ?? {},
		};
	}

	private registerHandlers(connection: RpcConnection): void {
		connection.onNotification(Methods.publishDiagnostics, (params) => {
			const p = params as { uri: string; diagnostics: Diagnostic[] };
			this.onDiagnostics(uriToFilePath(p.uri), p.diagnostics ?? []);
		});
		connection.onRequest("workspace/configuration", (params) => {
			const items = (params as { items?: unknown[] })?.items ?? [];
			return items.map(() => this.server.settings ?? {});
		});
		connection.onRequest("workspace/workspaceFolders", () => [{ name: path.basename(this.root), uri: filePathToUri(this.root) }]);
		connection.onRequest("client/registerCapability", () => null);
		connection.onRequest("client/unregisterCapability", () => null);
		connection.onRequest("window/workDoneProgress/create", () => null);
		connection.onRequest("window/showMessageRequest", () => null);
		connection.onNotification("window/logMessage", () => undefined);
		connection.onNotification("window/showMessage", () => undefined);
		connection.onNotification("telemetry/event", () => undefined);
	}

	/**
	 * One request under the configured deadline. `timeoutMs` is a per-call
	 * override; without it the server's `requestTimeout` decides, because a cold
	 * tsserver on a large repository needs longer than any fixed number a caller
	 * could guess.
	 */
	private req<T>(label: string, method: string, params: unknown, budget?: Budget): Promise<T> {
		const timeoutMs = budget ? budget.remainingMs : undefined;
		return this.request<T>(label, method, params, timeoutMs ?? requestTimeoutFor(this.server), budget?.signal);
	}

	/**
	 * One request under one deadline. On expiry the abort signal fires, which
	 * sends `$/cancelRequest`: the server stops working on an answer nobody will
	 * read, instead of the request sitting in its queue next to the retry.
	 */
	private async request<T>(
		label: string,
		method: string,
		params: unknown,
		timeoutMs: number | undefined,
		signal?: AbortSignal,
	): Promise<T> {
		const connection = this.connection;
		if (!connection) throw new Error(`${this.server.id}: connection unavailable`);
		const deadline = deadlineSignal(signal, timeoutMs);
		try {
			if (deadline.signal.aborted) throw new Error(abortMessage(label, timeoutMs));
			return await connection.sendRequest<T>(method, params, deadline.signal);
		} catch (error) {
			throw deadline.signal.aborted ? new Error(abortMessage(label, timeoutMs)) : error;
		} finally {
			deadline.done();
		}
	}

	/** Opens (or updates) the file on the server so it matches disk content. */
	async openOrChange(file: string, languageId: string, text: string, signal?: AbortSignal): Promise<void> {
		await this.ensureStarted(signal);
		if (!this.connection) throw new Error(`${this.server.id}: connection unavailable`);
		const uri = filePathToUri(file);
		const existing = this.documents.get(file);
		if (!existing) {
			const doc: OpenDocument = { file, uri, languageId, version: 1, text };
			this.documents.set(file, doc);
			await this.connection.sendNotification(Methods.didOpen, {
				textDocument: { uri, languageId, version: doc.version, text },
			});
			return;
		}
		const version = existing.version + 1;
		this.documents.set(file, { ...existing, version, text });
		await this.connection.sendNotification(Methods.didChange, {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	}

	async references(
		file: string,
		line: number,
		character: number,
		includeDeclaration: boolean,
		budget?: Budget,
	): Promise<Location[] | null> {
		return this.req<Location[] | null>(`${this.server.id} references`, Methods.references, {
			textDocument: { uri: filePathToUri(file) },
			position: { line, character },
			context: { includeDeclaration },
		}, budget);
	}

	async prepareCallHierarchy(
		file: string,
		line: number,
		character: number,
		budget?: Budget,
	): Promise<CallHierarchyItem[] | null> {
		return this.req<CallHierarchyItem[] | null>(`${this.server.id} prepareCallHierarchy`, Methods.prepareCallHierarchy, {
			textDocument: { uri: filePathToUri(file) },
			position: { line, character },
		}, budget);
	}

	async incomingCalls(
		item: CallHierarchyItem,
		budget?: Budget,
	): Promise<{ from: CallHierarchyItem; fromRanges: Location[] }[] | null> {
		return this.req(`${this.server.id} incomingCalls`, Methods.incomingCalls, { item }, budget);
	}

	async outgoingCalls(
		item: CallHierarchyItem,
		budget?: Budget,
	): Promise<{ to: CallHierarchyItem; fromRanges: Location[] }[] | null> {
		return this.req(`${this.server.id} outgoingCalls`, Methods.outgoingCalls, { item }, budget);
	}

	async rename(
		file: string,
		line: number,
		character: number,
		newName: string,
		budget?: Budget,
	): Promise<WorkspaceEdit | null> {
		return this.req<WorkspaceEdit | null>(`${this.server.id} rename`, Methods.rename, {
			textDocument: { uri: filePathToUri(file) },
			position: { line, character },
			newName,
		}, budget);
	}

	async hover(file: string, line: number, character: number, budget?: Budget): Promise<Hover | null> {
		return this.req<Hover | null>(`${this.server.id} hover`, Methods.hover, {
			textDocument: { uri: filePathToUri(file) },
			position: { line, character },
		}, budget);
	}

	async definition(file: string, line: number, character: number, budget?: Budget): Promise<Location | Location[] | null> {
		return this.req<Location | Location[] | null>(`${this.server.id} definition`, Methods.definition, {
			textDocument: { uri: filePathToUri(file) },
			position: { line, character },
		}, budget);
	}

	async documentSymbol(file: string, budget?: Budget): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
		return this.req<DocumentSymbol[] | SymbolInformation[] | null>(`${this.server.id} documentSymbol`, Methods.documentSymbol, {
			textDocument: { uri: filePathToUri(file) },
		}, budget);
	}

	async shutdown(): Promise<void> {
		const connection = this.connection;
		const child = this.process;
		this.connection = undefined;
		this.process = undefined;
		try {
			if (child && child.exitCode === null) {
				const send = (msg: string) => child.stdin?.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
				send('{"jsonrpc":"2.0","id":9999,"method":"shutdown"}');
				send('{"jsonrpc":"2.0","method":"exit"}');
			}
		} catch {
			// best effort
		}
		connection?.dispose();
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref();
		}
	}
}
