/**
 * One Qoder agent-chat turn: the request body the `/algo` stream endpoint
 * expects, and the frame decoder for what it answers.
 *
 * Qoder does not speak Chat Completions. A turn is an agent envelope
 * (`chat_task`, `session_type`, `agent_id`, a `model_config` naming the model
 * key) whose `messages` happen to be Chat-Completions-shaped, answered by an
 * SSE stream where each frame is `{ headers, body, statusCodeValue }` and
 * `body` is the JSON chunk as a string. The chunk's `choices[0].delta` carries
 * `content`, `reasoning_content` and `tool_calls` like the OpenAI shape, so the
 * adapter converts at the frame boundary and reuses nothing else.
 *
 * `model_config.key` is the whole model contract: upstream routes on it and
 * silently falls back to the account's auto model for a key it does not know,
 * without charging the call. The catalog keys therefore travel as model ids.
 */

import { randomUUID } from "node:crypto";
import type { Message, Tool } from "../types.ts";
import { getInitialSystemMessage } from "../utils/transcript.ts";
import type { QoderListedModel } from "./catalog.ts";
import type { QoderJson } from "./client.ts";

/** The reasoning/answer budget an envelope asks for; upstream caps it per model anyway. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

/** Message content the envelope accepts: a plain string, or text items. */
function contentText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

interface WireAssistantMessage {
	role: "assistant";
	content: string;
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

interface WireToolMessage {
	role: "tool";
	tool_call_id: string;
	content: string;
}

type WireMessage = { role: "system" | "user"; content: string } | WireAssistantMessage | WireToolMessage;

/**
 * Transcript to envelope messages. The leading system message stays first:
 * upstream carries it as a normal system message and appends the agent
 * template's own prompt behind it.
 */
function envelopeMessages(messages: readonly Message[]): WireMessage[] {
	const wire: WireMessage[] = [];
	for (const message of messages) {
		if (message.role === "system") {
			const text = getInitialSystemMessage([message]) ? contentText(message) : "";
			if (text.length > 0) wire.push({ role: "system", content: text });
			continue;
		}
		if (message.role === "user") {
			wire.push({ role: "user", content: contentText(message) });
			continue;
		}
		if (message.role === "toolResult") {
			wire.push({ role: "tool", tool_call_id: message.toolCallId, content: contentText(message) });
			continue;
		}
		const toolCalls = message.content
			.filter((block) => block.type === "toolCall")
			.map((block) => ({
				id: block.id,
				type: "function" as const,
				function: { name: block.name, arguments: JSON.stringify(block.arguments) },
			}));
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		// Upstream rejects an assistant turn with neither text nor calls.
		if (text.length === 0 && toolCalls.length === 0) continue;
		wire.push({ ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}), role: "assistant", content: text });
	}
	return wire;
}

function envelopeTools(tools: readonly Tool[] | undefined): QoderJson[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}

/** Last user text, which upstream copies into the turn's title and chat context. */
function promptOf(messages: readonly WireMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "user" && message.content.trim().length > 0) return message.content;
	}
	return "";
}

export interface QoderChatRequest {
	model: QoderListedModel;
	messages: readonly Message[];
	tools?: readonly Tool[];
	maxTokens?: number;
	/** Upstream switches the agent into reasoning mode from here. */
	reasoning: boolean;
	userType?: string;
}

/** Body of one `/algo` chat turn, signed as-is by the caller. */
export function qoderChatBody(request: QoderChatRequest): QoderJson {
	const messages = envelopeMessages(request.messages);
	const prompt = promptOf(messages);
	const maxTokens = request.maxTokens && request.maxTokens > 0 ? request.maxTokens : DEFAULT_MAX_OUTPUT_TOKENS;
	return {
		request_id: randomUUID(),
		request_set_id: randomUUID(),
		chat_record_id: randomUUID(),
		stream: true,
		chat_task: "FREE_INPUT",
		chat_context: {
			chatPrompt: "",
			extra: {
				context: [],
				modelConfig: { is_reasoning: request.reasoning, key: request.model.key },
				originalContent: { type: "text", text: prompt },
			},
			features: [],
			imageUrls: null,
			text: { type: "text", text: prompt },
		},
		image_urls: null,
		is_reply: true,
		is_retry: false,
		session_id: randomUUID(),
		code_language: "",
		source: 1,
		version: "3",
		chat_prompt: "",
		parameters: { max_tokens: maxTokens },
		aliyun_user_type: request.userType ?? "personal_standard",
		session_type: "qoder",
		agent_id: "agent_common",
		task_id: "common",
		model_config: {
			key: request.model.key,
			display_name: request.model.displayName,
			model: "",
			format: "openai",
			is_vl: false,
			is_reasoning: request.reasoning,
			api_key: "",
			url: "",
			source: "system",
			max_input_tokens: request.model.contextWindow || request.model.maxInputTokens || 200000,
		},
		messages,
		// `business` and the tool list stay optional: upstream fills the first in.
		...(envelopeTools(request.tools) ? { tools: envelopeTools(request.tools) } : {}),
	};
}

/**
 * Upstream's "sign in again" family: `105 Login expired` for a device token
 * that aged out, and `TOKEN_EXPIRE` when the token was revoked. Both answer 403
 * and both are fixed by renewing the token, not by retrying as-is.
 */
const EXPIRED_TOKEN_CODES = new Set(["105", "TOKEN_EXPIRE"]);

/** What to do about an expired token, once the provider has nothing left to retry with. */
export const TOKEN_EXPIRED_HINT =
	"Qoder rejected the device token. Run '/login qoder' (or set QODER_ACCOUNT_REFRESH_TOKEN so the token renews itself).";

function expiredToken(body: QoderJson | undefined): boolean {
	if (!body) return false;
	for (const key of ["code", "subCode", "message", "msg", "error"]) {
		const value = body[key];
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (EXPIRED_TOKEN_CODES.has(text) || /login expired/i.test(text)) return true;
	}
	return false;
}

/** One decoded frame: the delta upstream sent, or the error it reported. */
export interface QoderStreamDelta {
	role?: string;
	content?: string;
	reasoning?: string;
	toolCalls?: unknown[];
	inputTokens?: number;
	outputTokens?: number;
	finishReason?: string;
	/** Upstream refused or failed the turn inside the stream. */
	error?: string;
	/** `error` is an expired (or revoked) device token, which a renewal fixes. */
	tokenExpired?: boolean;
}

function jsonObject(value: unknown): QoderJson | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as QoderJson) : undefined;
}

function numberField(record: QoderJson | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Decode one `data:` payload. Frames are envelopes: a non-200
 * `statusCodeValue` is an error the stream carries after a 200 response,
 * while an in-band `code` (anything but "0") is the agent's own business
 * error. Both end the turn.
 */
export function parseQoderStreamFrame(payload: string): QoderStreamDelta {
	let envelope: QoderJson | undefined;
	try {
		envelope = jsonObject(JSON.parse(payload));
	} catch {
		return {};
	}
	if (!envelope) return {};
	const status = envelope.statusCodeValue;
	if (typeof status === "number" && status !== 200) {
		const detail = typeof envelope.body === "string" ? envelope.body : JSON.stringify(envelope.body ?? {});
		let parsed: QoderJson | undefined;
		try {
			parsed = jsonObject(JSON.parse(detail));
		} catch {
			parsed = undefined;
		}
		const expiry = expiredToken(parsed);
		const suffix = expiry ? ` ${TOKEN_EXPIRED_HINT}` : "";
		const failure: QoderStreamDelta = { error: `Qoder stream failed (HTTP ${status}): ${detail}${suffix}` };
		if (expiry) failure.tokenExpired = true;
		return failure;
	}
	const body = typeof envelope.body === "string" ? envelope.body : undefined;
	if (!body) return {};
	let chunk: QoderJson | undefined;
	try {
		chunk = jsonObject(JSON.parse(body));
	} catch {
		return {};
	}
	if (!chunk) return {};
	const usage = jsonObject(chunk.usage);
	const delta: QoderStreamDelta = {
		inputTokens: numberField(usage, "prompt_tokens"),
		outputTokens: numberField(usage, "completion_tokens"),
	};
	const code = chunk.code;
	if (typeof code === "string" && code.length > 0 && code !== "0") {
		const message = typeof chunk.message === "string" ? chunk.message : "";
		const expiry = expiredToken(chunk);
		const renewal = expiry ? ` ${TOKEN_EXPIRED_HINT}` : "";
		const failure: QoderStreamDelta = { ...delta, error: `Qoder error ${code}: ${message}${renewal}` };
		if (expiry) failure.tokenExpired = true;
		return failure;
	}
	const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
	const choice = jsonObject(choices[0]);
	if (!choice) return delta;
	if (typeof choice.finish_reason === "string") delta.finishReason = choice.finish_reason;
	const turn = jsonObject(choice.delta);
	if (!turn) return delta;
	if (typeof turn.role === "string") delta.role = turn.role;
	if (typeof turn.content === "string" && turn.content.length > 0) delta.content = turn.content;
	for (const key of ["reasoning_content", "reasoning", "reasoning_text"]) {
		const value = turn[key];
		if (typeof value === "string" && value.length > 0) {
			delta.reasoning = value;
			break;
		}
	}
	if (Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0) {
		delta.toolCalls = turn.tool_calls;
	}
	return delta;
}
