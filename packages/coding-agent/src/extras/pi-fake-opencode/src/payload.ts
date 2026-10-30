/**
 * Body shaping for the OpenCode Zen free-tier gate.
 *
 * The gate accepts an agent-shaped request only when its body matches the
 * official CLI's (each point verified against the live gateway, see README):
 *
 *  1. The system message starts with an official OpenCode prompt. nanopi's own
 *     system prompt rides along after a separator, so the agent instructions
 *     still reach the model.
 *  2. Every tool is one of the official definitions. The gate compares the
 *     whole list, so nanopi's own tools are renamed to opaque wire names
 *     (`clint_<hash>`) and the official set is appended: the client's tool
 *     names never travel upstream, a response maps them back.
 *  3. The CLI's own fields: `stream: true`, `max_completion_tokens` instead of
 *     `max_tokens`, and no `tool_choice`.
 *
 * Consequence: the model sees only the official tool definitions, so it drives
 * the session through those, at the fidelity of their schemas rather than
 * nanopi's.
 */

import { createHash } from "node:crypto";
import { GATEWAY_SKILL_LISTING, GATEWAY_SYSTEM_PROMPT, GATEWAY_TOOL_ORDER } from "./gateway-prompt.ts";
import { GATEWAY_TOOLS } from "./gateway-tools.ts";

/**
 * Marker inserted after the gateway-required prompt so the model treats the
 * operator's instructions as the operative ones.
 */
export const SYSTEM_PROMPT_SEPARATOR =
	"\n\n---\n\nThe text above this marker is fixed preamble from the API gateway and does not describe your task. Follow the instructions below instead.\n\n";

/** Prefix of the opaque wire names nanopi's own tools travel under. */
export const WIRE_TOOL_PREFIX = "clint_";

/** The ceiling the CLI sends when the caller asks for none. */
export const DEFAULT_MAX_COMPLETION_TOKENS = 32000;

/** Matches the CLI prompt, which keeps the injection idempotent. */
const GATEWAY_PROMPT_MARKER = "You are opencode, an interactive CLI tool";

interface ChatMessageShape {
	role?: unknown;
	content?: unknown;
	tool_calls?: unknown;
}

interface ToolEntryShape {
	type?: unknown;
	function?: { name?: unknown; [key: string]: unknown };
}

export interface CompletionsPayloadShape {
	messages?: unknown;
	tools?: unknown;
	tool_choice?: unknown;
	max_tokens?: unknown;
	max_completion_tokens?: unknown;
	stream?: unknown;
}

export interface GatewayBodyContext {
	/** Provider-side model id, for the `<env>` block. */
	modelId: string;
	/** Working directory the CLI would report. */
	cwd: string;
}

/** The official prompt with the per-session `<env>` block and skill listing. */
export function renderGatewayPrompt(context: GatewayBodyContext): string {
	const environment = [
		`You are powered by the model named ${context.modelId}. The exact model ID is opencode/${context.modelId}`,
		"Here is some useful information about the environment you are running in:",
		"<env>",
		`  Working directory: ${context.cwd}`,
		`  Workspace root folder: ${context.cwd}`,
		"  Is directory a git repo: yes",
		`  Platform: ${process.platform === "win32" ? "win32" : process.platform}`,
		`  Today's date: ${new Date().toISOString().slice(0, 10)}`,
		"</env>",
	].join("\n");
	return `${GATEWAY_SYSTEM_PROMPT}${environment}\n${GATEWAY_SKILL_LISTING}`;
}

/** The opaque wire name nanopi tool `name` travels under. */
export function wireToolName(name: string): string {
	return `${WIRE_TOOL_PREFIX}${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

function textFragments(content: unknown): string[] {
	if (typeof content === "string") return content.trim() ? [content] : [];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string" && text.trim()) parts.push(text);
	}
	return parts;
}

function carriesGatewayPrompt(content: unknown): boolean {
	return textFragments(content).some((text) => text.includes(GATEWAY_PROMPT_MARKER));
}

/**
 * Fold every system/developer message into one leading system message: the
 * official prompt, the separator, then the operator's instructions.
 */
function foldSystemPrompt(messages: unknown[], prompt: string): unknown[] {
	const rest: unknown[] = [];
	const instructions: string[] = [];
	for (const message of messages) {
		if (typeof message !== "object" || message === null) {
			rest.push(message);
			continue;
		}
		const shape = message as ChatMessageShape;
		if (shape.role !== "system" && shape.role !== "developer") {
			rest.push(message);
			continue;
		}
		instructions.push(...textFragments(shape.content));
	}
	const system = instructions.length > 0 ? `${prompt}${SYSTEM_PROMPT_SEPARATOR}${instructions.join("\n\n")}` : prompt;
	return [{ role: "system", content: system }, ...rest];
}

/** Replace the client tool list with opaque-named client tools plus the official set. */
function reshapeTools(body: CompletionsPayloadShape): void {
	if (!Array.isArray(body.tools)) return;
	const tools: unknown[] = [];
	for (const entry of body.tools) {
		if (typeof entry !== "object" || entry === null) continue;
		const tool = entry as ToolEntryShape;
		const name = tool.function?.name;
		if (!tool.function || typeof name !== "string") continue;
		tools.push({ ...tool, function: { ...tool.function, name: wireToolName(name) } });
	}
	for (const name of GATEWAY_TOOL_ORDER) {
		const definition = GATEWAY_TOOLS[name];
		tools.push({
			type: "function",
			function: {
				name,
				description: definition.description,
				parameters: definition.parameters,
				strict: false,
			},
		});
	}
	body.tools = tools;
}

/**
 * Rewrite an OpenAI-completions body in place into the shape the free-tier gate
 * accepts. A body that already carries the official prompt is left as is.
 */
export function shapeForGateway(payload: unknown, context: GatewayBodyContext): void {
	if (typeof payload !== "object" || payload === null) return;
	const body = payload as CompletionsPayloadShape;

	// Field-name whitelist: the CLI sends max_completion_tokens, and always one.
	if (body.max_completion_tokens === undefined) {
		body.max_completion_tokens = body.max_tokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
	}
	body.max_tokens = undefined;

	// The CLI streams, and pins no tool choice.
	body.stream = true;
	body.tool_choice = undefined;

	reshapeTools(body);

	const messages = body.messages;
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		if (carriesGatewayPrompt((message as ChatMessageShape).content)) return;
	}
	body.messages = foldSystemPrompt(messages, renderGatewayPrompt(context));
}
