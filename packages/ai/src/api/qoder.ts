/**
 * Qoder's own inference API: signed agent-chat turns against `/algo`, not an
 * OpenAI-compatible gateway.
 *
 * The provider used to point its models at `<openApiHost>/v1` and speak Chat
 * Completions. That gateway does not serve the model keys the account's
 * catalogue lists, so a model picked from `/model` answered "not found" or was
 * routed to whatever fallback the host had. The account's models live behind
 * the signed stream endpoint instead: one envelope per turn, answered by SSE
 * frames carrying OpenAI-shaped deltas.
 *
 * Credentials: the stream is signed with the COSY bearer an OAuth login
 * stores. `QODER_*` env vars on the resolved credential carry the account
 * facts the signing identity needs, so a device token alone is enough to
 * start a turn.
 *
 * An expired login is reported inside the stream (`403` / `105 Login expired`),
 * which no retry fixes. When the credential carries an account refresh token,
 * the turn renews the pair through the job-token endpoint once and reports the
 * new tokens on `message.authorizationUpdate`, so the caller can store them; a
 * renewed device token that lands after the refresh hook already needs it would
 * otherwise be thrown away and every turn would renew again.
 */

import type { QoderListedModel } from "../qoder/catalog.ts";
import { parseQoderStreamFrame, type QoderStreamDelta, qoderChatBody } from "../qoder/chat.ts";
import { type QoderFingerprint, qoderFingerprint } from "../qoder/cosy.ts";
import { type QoderApi, type QoderRegion, qoderEndpoints } from "../qoder/endpoints.ts";
import { renewQoderToken } from "../qoder/job-token.ts";
import { createQoderCosySession, qoderSessionHeaders } from "../qoder/signature.ts";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream as Stream } from "../utils/event-stream.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { resolveTranscriptTools } from "../utils/transcript.ts";
import { buildBaseOptions } from "./simple-options.ts";

/** The list entry a model id stands for; a custom id keeps the shape of the fallback. */
function listedModel(model: Model<QoderApi>): QoderListedModel {
	return {
		key: model.id,
		displayName: model.name,
		isDefault: false,
		isReasoning: model.reasoning,
		contextWindow: model.contextWindow,
	};
}

function regionFor(model: Model<QoderApi>, env: ProviderEnv | undefined): QoderRegion {
	const stored = getProviderEnvValue("QODER_REGION", env)?.trim().toLowerCase();
	if (stored === "cn" || stored === "global") return stored;
	return model.provider === "qoder-cn" ? "cn" : "global";
}

/**
 * The account the turn is signed for. A device token is the access string;
 * `QODER_ACCOUNT_ID` is what the derived device identity hangs on, so a
 * credential that never recorded one signs as the token itself.
 */
function signingIdentity(model: Model<QoderApi>, apiKey: string | undefined, env: ProviderEnv | undefined) {
	const token =
		apiKey ?? getProviderEnvValue("QODER_DEVICE_TOKEN", env) ?? getProviderEnvValue("QODER_CN_DEVICE_TOKEN", env);
	if (!token) throw new Error(`No Qoder device token for provider ${model.provider}. Sign in again.`);
	const uid = getProviderEnvValue("QODER_ACCOUNT_ID", env) ?? token;
	return {
		uid,
		token,
		name: getProviderEnvValue("QODER_ACCOUNT_NAME", env),
		organizationId: getProviderEnvValue("QODER_ACCOUNT_ORG_ID", env),
		organizationName: getProviderEnvValue("QODER_ACCOUNT_ORG_NAME", env),
		userType: getProviderEnvValue("QODER_ACCOUNT_USER_TYPE", env),
		refreshToken: getProviderEnvValue("QODER_ACCOUNT_REFRESH_TOKEN", env),
	};
}

/** What the caller does with tokens the turn renewed: store them. */
export interface QoderAuthorizationUpdate {
	token: string;
	refreshToken?: string;
}

interface Turn {
	identity: ReturnType<typeof signingIdentity>;
	fingerprint: QoderFingerprint;
}

/** One signed request's credentials; rebuilt from renewed tokens between attempts. */
function turnFor(model: Model<QoderApi>, apiKey: string, env: ProviderEnv | undefined): Turn {
	const identity = signingIdentity(model, apiKey, env);
	return { identity, fingerprint: qoderFingerprint(identity.uid) };
}

interface StreamState {
	output: AssistantMessage;
	blocks: Array<TextContent | ThinkingContent | StreamingToolCall>;
	textBlock: TextContent | null;
	thinkingBlock: ThinkingContent | null;
	toolBlocks: Map<string, StreamingToolCall>;
}

interface StreamingToolCall extends ToolCall {
	partialArgs?: string;
	streamIndex?: number;
}

function contentIndex(state: StreamState, block: TextContent | ThinkingContent | StreamingToolCall): number {
	return state.blocks.indexOf(block);
}

function ensureTextBlock(state: StreamState, stream: Stream): TextContent {
	if (!state.textBlock) {
		const block: TextContent = { type: "text", text: "" };
		state.blocks.push(block);
		state.textBlock = block;
		stream.push({ type: "text_start", contentIndex: contentIndex(state, block), partial: state.output });
	}
	return state.textBlock;
}

function ensureThinkingBlock(state: StreamState, stream: Stream): ThinkingContent {
	if (!state.thinkingBlock) {
		const block: ThinkingContent = { type: "thinking", thinking: "", thinkingSignature: "reasoning_content" };
		state.blocks.push(block);
		state.thinkingBlock = block;
		stream.push({ type: "thinking_start", contentIndex: contentIndex(state, block), partial: state.output });
	}
	return state.thinkingBlock;
}

function ensureToolCall(state: StreamState, stream: Stream, delta: Record<string, unknown>): StreamingToolCall {
	const id = typeof delta.id === "string" ? delta.id : "";
	const wanted = typeof delta.index === "number" ? delta.index : undefined;
	const fn = (delta.function ?? {}) as Record<string, unknown>;
	const name = typeof fn.name === "string" ? fn.name : "";
	let block = id ? state.toolBlocks.get(id) : undefined;
	if (!block && wanted !== undefined) block = state.toolBlocks.get(`index:${wanted}`);
	if (!block) {
		block = { type: "toolCall", id, name, arguments: {}, partialArgs: "", streamIndex: wanted };
		state.blocks.push(block);
		stream.push({ type: "toolcall_start", contentIndex: contentIndex(state, block), partial: state.output });
	}
	if (id) {
		block.id = id;
		state.toolBlocks.set(id, block);
	}
	if (wanted !== undefined) {
		block.streamIndex = wanted;
		state.toolBlocks.set(`index:${wanted}`, block);
	}
	if (name && !block.name) block.name = name;
	return block;
}

function applyDelta(state: StreamState, stream: Stream, delta: QoderStreamDelta): void {
	if (delta.reasoning) {
		const block = ensureThinkingBlock(state, stream);
		block.thinking += delta.reasoning;
		stream.push({
			type: "thinking_delta",
			contentIndex: contentIndex(state, block),
			delta: delta.reasoning,
			partial: state.output,
		});
	}
	if (delta.content) {
		const block = ensureTextBlock(state, stream);
		block.text += delta.content;
		stream.push({
			type: "text_delta",
			contentIndex: contentIndex(state, block),
			delta: delta.content,
			partial: state.output,
		});
	}
	for (const raw of delta.toolCalls ?? []) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		const block = ensureToolCall(state, stream, entry);
		const fn = (entry.function ?? {}) as Record<string, unknown>;
		const args = typeof fn.arguments === "string" ? fn.arguments : "";
		if (args.length > 0) {
			block.partialArgs = `${block.partialArgs ?? ""}${args}`;
			block.arguments = parseStreamingJson(block.partialArgs);
			stream.push({
				type: "toolcall_delta",
				contentIndex: contentIndex(state, block),
				delta: args,
				partial: state.output,
			});
		}
	}
	if (delta.inputTokens || delta.outputTokens) {
		state.output.usage = {
			input: delta.inputTokens ?? state.output.usage.input,
			output: delta.outputTokens ?? state.output.usage.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens:
				(delta.inputTokens ?? state.output.usage.input) + (delta.outputTokens ?? state.output.usage.output),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}
}

function finishBlocks(state: StreamState, stream: Stream): void {
	for (const block of state.blocks) {
		const index = contentIndex(state, block);
		if (block.type === "text") {
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: state.output });
		} else if (block.type === "thinking") {
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: state.output });
		} else {
			Object.assign(block, parseToolCallArguments(block.partialArgs));
			delete block.partialArgs;
			delete block.streamIndex;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: state.output });
		}
	}
}

/** SSE payloads of one response body, in arrival order. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = raw
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice("data:".length).trim())
					.join("");
				if (data.length > 0) yield data;
				boundary = buffer.indexOf("\n\n");
			}
		}
		const tail = buffer.trim();
		if (tail.startsWith("data:")) {
			const data = tail.slice("data:".length).trim();
			if (data.length > 0) yield data;
		}
	} finally {
		reader.releaseLock();
	}
}

const stream: StreamFunction<QoderApi, StreamOptions> = (
	model: Model<QoderApi>,
	context,
	options?: StreamOptions,
): AssistantMessageEventStream => {
	const stream = new Stream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};

	(async () => {
		const blocks: Array<TextContent | ThinkingContent | StreamingToolCall> = [];
		const state: StreamState = { output, blocks, textBlock: null, thinkingBlock: null, toolBlocks: new Map() };
		output.content = blocks as AssistantMessage["content"];
		try {
			const region = regionFor(model, options?.env);
			const initialToken = options?.apiKey ?? signingIdentity(model, options?.apiKey, options?.env).token;
			const endpoints = qoderEndpoints(region);
			const body = JSON.stringify(
				qoderChatBody({
					model: listedModel(model),
					messages: context.messages,
					tools: resolveTranscriptTools(context.messages, false).requestTools,
					maxTokens: options?.maxTokens,
					// Both are account facts the credential recorded; the model decides reasoning.
					reasoning: model.reasoning,
					userType: getProviderEnvValue("QODER_ACCOUNT_USER_TYPE", options?.env),
				}),
			);

			/** One signed POST of the turn; `token` is the device token this attempt carries. */
			const send = async (token: string) => {
				const turn = turnFor(model, token, options?.env);
				const session = createQoderCosySession(turn.identity, turn.fingerprint);
				const response = await fetch(endpoints.chatUrl, {
					method: "POST",
					headers: {
						...qoderSessionHeaders(session, { url: endpoints.chatUrl, body }),
						accept: "text/event-stream",
						"content-type": "application/json",
					},
					body,
					signal: options?.signal,
				});
				await options?.onResponse?.({ status: response.status, headers: {} }, model);
				return response;
			};

			/**
			 * Renew the pair once per turn. Only a credential that carries the account
			 * refresh token can rotate it; without one the token is already as fresh as
			 * this process can make it, and renewing would hand upstream the same dead
			 * credential twice.
			 */
			let token = initialToken;
			let renewed = false;
			const renewToken = async () => {
				const refreshToken = getProviderEnvValue("QODER_ACCOUNT_REFRESH_TOKEN", options?.env);
				if (renewed || !refreshToken) return false;
				renewed = true;
				const next = await renewQoderToken({
					credential: refreshToken,
					jobTokenUrl: endpoints.jobTokenUrl,
					signal: options?.signal ?? new AbortController().signal,
				});
				token = next.token;
				// The renewal continues the credential this turn started from, so storing it
				// cannot overwrite a login that replaced that credential mid-turn.
				output.authorizationUpdate = { token: next.token, refreshToken: next.refreshToken, continues: true };
				return true;
			};

			let response = await send(token);
			if (response.status === 401 || response.status === 403) {
				// The stream carries this error inside a 200 most of the time; an outright
				// 403 means the same thing, so both renew before the turn gives up.
				await response.text();
				if (!(await renewToken())) {
					throw new Error(`Qoder chat failed (HTTP ${response.status}): the device token was rejected.`);
				}
				response = await send(token);
			}
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Qoder chat failed (HTTP ${response.status}): ${text.slice(0, 500)}`);
			}
			if (!response.body) throw new Error("Qoder chat returned no stream");
			stream.push({ type: "start", partial: output });

			let finished = false;
			let upstreamError: string | undefined;
			for await (const payload of sseFrames(response.body)) {
				const delta = parseQoderStreamFrame(payload);
				if (delta.error) {
					upstreamError = delta.error;
					if (!delta.tokenExpired) break;
					// Nothing was emitted for this turn yet: renewing the token and sending
					// the same envelope again cannot duplicate content.
					if (!(await renewToken())) break;
					const retried = await send(token);
					if (retried.ok && retried.body) {
						upstreamError = undefined;
						for await (const payload of sseFrames(retried.body)) {
							const next = parseQoderStreamFrame(payload);
							if (next.error) {
								upstreamError = next.error;
								break;
							}
							if (next.finishReason) finished = true;
							applyDelta(state, stream, next);
						}
					}
					break;
				}
				if (delta.finishReason) finished = true;
				applyDelta(state, stream, delta);
			}
			if (upstreamError) throw new Error(upstreamError);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.authorizationUpdate) await options?.onAuthorizationUpdate?.(output.authorizationUpdate);
			finishBlocks(state, stream);
			const hasToolCall = state.blocks.some((block) => block.type === "toolCall");
			output.stopReason = hasToolCall ? "toolUse" : "stop";
			if (!finished && !hasToolCall && output.content.length === 0) {
				throw new Error("Qoder stream ended without content");
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end(output);
		}
	})();

	return stream;
};

const streamSimple: StreamFunction<QoderApi, SimpleStreamOptions> = (model, context, options) =>
	stream(model, context, buildBaseOptions(model, context, options, options?.apiKey));

export { stream, streamSimple };
