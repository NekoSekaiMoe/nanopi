/**
 * pi-deepwiki — codebase-grounded questions about public GitHub repositories.
 *
 * Two tools speak the hosted DeepWiki MCP endpoint over plain HTTP+JSON-RPC,
 * so no MCP adapter is installed. Tool awareness is a compact system-prompt
 * appendix; the optional `/deepwiki` command only prefills the editor, since
 * commands cannot start a turn themselves.
 */

import type {
	BeforeAgentStartEvent,
	ModuleApi,
	ModuleCommandContext,
	ModuleCommandsSurface,
	ModuleEventsSurface,
	ModuleToolContext,
	ModuleToolsSurface,
} from "../../../core/modules/types.ts";
import { type Static, Type } from "typebox";

const DEFAULT_BASE_URL = "https://mcp.deepwiki.com/mcp";
const REQUEST_TIMEOUT_MS = 90_000;

const TOOL_GUIDANCE = [
	"DeepWiki tools are available for any public GitHub repository.",
	"Use deepwiki_wiki_structure to list a repo's documentation outline (owner/repo).",
	"Use deepwiki_ask_question to ask a codebase-grounded question about one repo (or up to 10).",
	"Reach for them when asked how a specific repo works internally or where logic lives.",
].join(" ");

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

class DeepWikiError extends Error {
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

function parseSseJson(body: string): unknown {
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

function friendlyStatus(status: number): string {
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

async function callDeepWikiTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
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
	const text = result.content
		.map((part) => (part.type === "text" ? part.text ?? "" : ""))
		.join("\n")
		.trim();
	if (result.isError) throw new DeepWikiError(text || "DeepWiki reported a tool error.");
	return text;
}

function errorText(err: unknown): string {
	return err instanceof Error ? `DeepWiki error: ${err.message}` : "DeepWiki error: unknown failure.";
}

function toolResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

const wikiParams = Type.Object({
	repoName: Type.String({ description: 'GitHub repository in owner/repo format (e.g. "solidjs/solid").' }),
});
const askParams = Type.Object({
	repoName: Type.Union(
		[Type.String(), Type.Array(Type.String(), { minItems: 1, maxItems: 10 })],
		{
			description:
				'GitHub repository in owner/repo format (e.g. "solidjs/solid"), or an array of up to 10 owner/repo strings to cross-reference.',
		},
	),
	question: Type.String({ description: "The question to ask about the repository. Be specific." }),
});

export default function deepwiki(
	pi: ModuleEventsSurface & ModuleToolsSurface & ModuleCommandsSurface,
): void {
	pi.registerTool({
		name: "deepwiki_wiki_structure",
		label: "DeepWiki: List Wiki Topics",
		description:
			"Lists the documentation table of contents for a public GitHub repository via DeepWiki. Cheap and small; call it first when exploring an unfamiliar repo. Pass repoName in owner/repo form (e.g. solidjs/solid). Do not call more than 3 times per question.",
		promptSnippet: "List a public repo's documentation outline via DeepWiki",
		annotations: { readOnlyHint: true, openWorldHint: true },
		parameters: wikiParams,
		async execute(_id, params: Static<typeof wikiParams>, signal, _onUpdate, _ctx: ModuleToolContext) {
			try {
				return toolResult(await callDeepWikiTool("read_wiki_structure", { repoName: params.repoName }, signal));
			} catch (err) {
				return toolResult(errorText(err));
			}
		},
	});

	pi.registerTool({
		name: "deepwiki_ask_question",
		label: "DeepWiki: Ask Repo Question",
		description:
			"Asks a codebase-grounded question about a public GitHub repository via DeepWiki. Returns focused prose with citations. Pass repoName in owner/repo form, or up to 10 repos to cross-reference. Be specific in the question. Do not call more than 3 times per question.",
		promptSnippet: "Ask a codebase-grounded question about a public repo via DeepWiki",
		annotations: { readOnlyHint: true, openWorldHint: true },
		parameters: askParams,
		async execute(_id, params: Static<typeof askParams>, signal, _onUpdate, _ctx: ModuleToolContext) {
			try {
				return toolResult(
					await callDeepWikiTool(
						"ask_question",
						{ repoName: params.repoName, question: params.question },
						signal,
					),
				);
			} catch (err) {
				return toolResult(errorText(err));
			}
		},
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => ({
		systemPrompt: [event.systemPrompt, TOOL_GUIDANCE].filter(Boolean).join("\n\n"),
	}));

	pi.registerCommand("deepwiki", {
		description:
			"DeepWiki: ask about a GitHub repo. Usage: /deepwiki <owner/repo> [question]. With a question, asks deepwiki_ask_question; without, lists the wiki outline.",
		handler: async (args: string, ctx: ModuleCommandContext) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /deepwiki <owner/repo> [question]", "warning");
				return;
			}
			const space = trimmed.indexOf(" ");
			const repo = space === -1 ? trimmed : trimmed.slice(0, space);
			const question = space === -1 ? "" : trimmed.slice(space + 1).trim();
			ctx.ui.setEditorText(
				question
					? `Answer this question about the GitHub repository ${repo} using the deepwiki_ask_question tool: ${question}`
					: `List the documentation outline for the GitHub repository ${repo} using the deepwiki_wiki_structure tool.`,
			);
		},
	});
}

// Exported for tests: the SSE parser and error text are pure and carry the
// protocol edge cases that matter (keepalive lines, bare JSON, rate limits).
export { parseSseJson, friendlyStatus, errorText, DeepWikiError };
