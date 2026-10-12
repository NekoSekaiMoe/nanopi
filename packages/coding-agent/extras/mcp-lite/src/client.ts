/**
 * Lean MCP client: JSON-RPC over stdio (ndjson) and streamable-http (POST).
 * Slimmed from irahardianto/pi-mcp-extension: no OAuth, no health pings, no
 * reconnect backoff — connect, list tools, call tools, cancel, close.
 */

import { spawn, type ChildProcess } from "node:child_process";

const PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 120_000;

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
}

export interface McpCallResult {
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface StdioServerConfig {
	transport: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface HttpServerConfig {
	transport: "http" | "sse";
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

let nextRequestId = 1;

abstract class McpTransport {
	protected pending = new Map<number, PendingRequest>();

	protected handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return; // stray stdout noise
		}
		if (!message || typeof message !== "object" || !("id" in message)) return;
		const id = (message as { id: unknown }).id;
		if (typeof id !== "number") return;
		const record = message as { result?: unknown; error?: { message?: string } };
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (record.error) pending.reject(new Error(record.error.message ?? "MCP request failed"));
		else pending.resolve(record.result);
	}

	protected failAll(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	protected request(
		payload: Record<string, unknown>,
		write: (data: string) => void,
		signal: AbortSignal | undefined,
		onCancel: ((id: number) => void) | undefined,
	): Promise<unknown> {
		const id = nextRequestId++;
		const frame = { jsonrpc: "2.0", id, ...payload };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request ${String(id)} timed out`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			const abort = () => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				clearTimeout(timer);
				onCancel?.(id);
				reject(new Error("MCP request was cancelled"));
			};
			if (signal) {
				if (signal.aborted) {
					abort();
					return;
				}
				signal.addEventListener("abort", abort, { once: true });
			}
			try {
				write(`${JSON.stringify(frame)}\n`);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	abstract rpc(
		method: string,
		params?: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<unknown>;
	abstract notify(method: string, params?: Record<string, unknown>): void;
	abstract close(): void;
}

class StdioTransport extends McpTransport {
	private proc: ChildProcess | undefined;
	private buffer = "";
	private closed = false;

	constructor(private readonly config: StdioServerConfig) {
		super();
	}

	private ensureProcess(): ChildProcess {
		if (this.proc) return this.proc;
		const env = { ...process.env, ...this.config.env };
		delete env.NODE_OPTIONS;
		this.proc = spawn(this.config.command, this.config.args ?? [], {
			cwd: this.config.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout?.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				if (line.trim()) this.handleLine(line);
			}
		});
		this.proc.on("error", (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
		this.proc.on("exit", () => {
			this.closed = true;
			this.failAll(new Error("MCP server process exited"));
		});
		return this.proc;
	}

	rpc(
		method: string,
		params?: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<unknown> {
		const proc = this.ensureProcess();
		if (!proc.stdin) return Promise.reject(new Error("MCP server stdin unavailable"));
		return this.request(
			{ method, params },
			(data) => proc.stdin?.write(data),
			options?.signal,
			(id) => this.notify("notifications/cancelled", { requestId: id, reason: "client aborted" }),
		);
	}

	notify(method: string, params?: Record<string, unknown>): void {
		const proc = this.proc;
		if (!proc?.stdin || this.closed) return;
		proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	close(): void {
		this.closed = true;
		this.failAll(new Error("MCP client closed"));
		this.proc?.kill();
	}
}

class HttpTransport extends McpTransport {
	private sessionId: string | undefined;
	private closed = false;

	constructor(private readonly config: HttpServerConfig) {
		super();
	}

	private async exchange(payload: Record<string, unknown>): Promise<string> {
		if (this.closed) throw new Error("MCP client closed");
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(this.config.headers ?? {}),
		};
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		const response = await fetch(this.config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		});
		const sessionHeader = response.headers.get("mcp-session-id");
		if (sessionHeader) this.sessionId = sessionHeader;
		if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			// Single-response SSE: return the first data frame.
			const reader = response.body?.getReader();
			if (!reader) throw new Error("MCP SSE body unavailable");
			const decoder = new TextDecoder();
			let text = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
				const frame = /^data: (.+)$/m.exec(text);
				if (frame) {
					await reader.cancel().catch(() => {});
					return frame[1];
				}
			}
			throw new Error("MCP SSE stream ended without a response");
		}
		return response.text();
	}

	async rpc(
		method: string,
		params?: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<unknown> {
		const id = nextRequestId++;
		const frame = { jsonrpc: "2.0", id, method, params };
		options?.signal?.throwIfAborted();
		const body = await this.exchange(frame);
		let message: unknown;
		try {
			message = JSON.parse(body);
		} catch {
			throw new Error("MCP HTTP response was not JSON");
		}
		const record = message as { result?: unknown; error?: { message?: string } };
		if (record.error) throw new Error(record.error.message ?? "MCP request failed");
		return record.result;
	}

	notify(method: string, params?: Record<string, unknown>): void {
		void this.exchange({ jsonrpc: "2.0", method, params }).catch(() => {});
	}

	close(): void {
		this.closed = true;
		this.failAll(new Error("MCP client closed"));
	}
}

/** One connected MCP server. */
export class McpClient {
	private transport: McpTransport | undefined;
	readonly serverInfo: { name?: string; version?: string } = {};

	constructor(
		readonly serverName: string,
		readonly config: McpServerConfig,
	) {}

	get connected(): boolean {
		return this.transport !== undefined;
	}

	async connect(): Promise<void> {
		const transport =
			this.config.transport === "stdio" ? new StdioTransport(this.config) : new HttpTransport(this.config);
		const result = (await transport.rpc("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "nanopi-mcp-lite", version: "1.0.0" },
		})) as { serverInfo?: { name?: string; version?: string } };
		if (result?.serverInfo) {
			this.serverInfo.name = result.serverInfo.name;
			this.serverInfo.version = result.serverInfo.version;
		}
		transport.notify("notifications/initialized");
		this.transport = transport;
	}

	async listTools(): Promise<McpToolDefinition[]> {
		if (!this.transport) return [];
		const tools: McpToolDefinition[] = [];
		let cursor: string | undefined;
		do {
			const result = (await this.transport.rpc("tools/list", cursor ? { cursor } : {})) as {
				tools?: McpToolDefinition[];
				nextCursor?: string;
			};
			tools.push(...(result?.tools ?? []));
			cursor = result?.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<McpCallResult> {
		if (!this.transport) throw new Error(`MCP server "${this.serverName}" is not connected`);
		const result = (await this.transport.rpc("tools/call", { name, arguments: args }, { signal })) as McpCallResult;
		return {
			content: result?.content ?? [{ type: "text", text: "(empty result)" }],
			isError: result?.isError === true,
		};
	}

	close(): void {
		this.transport?.close();
		this.transport = undefined;
	}
}
