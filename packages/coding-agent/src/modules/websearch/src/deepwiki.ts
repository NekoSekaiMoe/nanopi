/** DeepWiki's hosted MCP endpoint, called over plain HTTP+JSON-RPC. */

const DEFAULT_BASE_URL = "https://mcp.deepwiki.com/mcp";
const REQUEST_TIMEOUT_MS = 90_000;

interface JsonRpcResponse<T> {
	jsonrpc: "2.0";
	id: number | string;
	result?: T;
	error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

export class DeepWikiError extends Error {
	readonly status: number;
	readonly isRateLimited: boolean;
	constructor(message: string, status = 0, isRateLimited = false) {
		super(message);
		this.name = "DeepWikiError";
		this.status = status;
		this.isRateLimited = isRateLimited;
	}
}

function baseUrl(): string {
	return process.env.DEEPWIKI_MCP_URL?.trim() || DEFAULT_BASE_URL;
}

export function parseSseJson(body: string): unknown {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload) continue;
		try {
			return JSON.parse(payload);
		} catch {
			// Only one real frame is expected; skip malformed ones.
		}
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new DeepWikiError("DeepWiki returned an unparseable response.");
	}
}

export function friendlyStatus(status: number): string {
	if (status === 429) return "DeepWiki rate limit reached. Wait a moment and retry.";
	if (status === 404) {
		return "Repository not indexed by DeepWiki, or the repoName is malformed. Use owner/repo (e.g. solidjs/solid).";
	}
	if (status === 401 || status === 403) {
		return "DeepWiki denied access. Public repos need no auth; check the repoName and that the repo is public.";
	}
	if (status >= 500) return `DeepWiki server error (${status}). Try again later.`;
	return `DeepWiki request failed (HTTP ${status}).`;
}

export async function callDeepWikiTool(
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const forwardAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", forwardAbort, { once: true });
	}
	let response: Response;
	try {
		response = await fetch(baseUrl(), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
			signal: controller.signal,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("abort")) {
			throw new DeepWikiError(`DeepWiki request timed out after ${REQUEST_TIMEOUT_MS / 1000}s or was cancelled.`);
		}
		throw new DeepWikiError(`Network error reaching DeepWiki: ${msg}`);
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", forwardAbort);
	}

	if (!response.ok) {
		throw new DeepWikiError(friendlyStatus(response.status), response.status, response.status === 429);
	}
	const parsed = parseSseJson(await response.text()) as JsonRpcResponse<ToolResult>;
	if (parsed.error) throw new DeepWikiError(parsed.error.message || "DeepWiki JSON-RPC error.");
	const result = parsed.result;
	if (!result?.content?.length) throw new DeepWikiError("DeepWiki returned an empty result.");
	const content = result.content
		.map((part) => (part.type === "text" ? part.text ?? "" : ""))
		.join("\n")
		.trim();
	if (result.isError) throw new DeepWikiError(content || "DeepWiki reported a tool error.");
	return content;
}

export function errorText(err: unknown): string {
	return err instanceof Error ? `DeepWiki error: ${err.message}` : "DeepWiki error: unknown failure.";
}
