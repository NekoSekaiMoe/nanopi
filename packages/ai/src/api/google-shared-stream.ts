/**
 * The stream loop both Google adapters share.
 *
 * `google-generative-ai` and `google-vertex` speak the same Gemini
 * `GenerateContent` wire format through `@google/genai`; they differ only in how
 * the client is built (API key vs Vertex project/location/ADC) and in the
 * adapter name carried on the error messages. Everything below the client used
 * to be duplicated verbatim in both files, so it lives here.
 */

import type { GenerateContentConfig, GenerateContentParameters, GoogleGenAI, ThinkingConfig } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	isThinkingPart,
	mapStopReason,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	retryGoogleRequest,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/** The thinking controls both Google adapters expose. */
export interface GoogleThinkingOptions {
	enabled: boolean;
	budgetTokens?: number; // -1 for dynamic, 0 to disable
	level?: GoogleApiThinkingLevel;
}

export interface GoogleSharedStreamOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: GoogleThinkingOptions;
	/**
	 * Per-level token budgets for the token-based Gemini models. `SimpleStreamOptions`
	 * carries the same field, but the object `streamSimple` hands to `stream` is built
	 * here, so the shape has to declare it.
	 */
	thinkingBudgets?: ThinkingBudgets;
}

/** What one adapter has to supply: its label and its client. */
export interface GoogleAdapter<TApi extends GoogleApiType, TOptions extends GoogleSharedStreamOptions> {
	/** Adapter label used in the error messages only that adapter can raise. */
	adapterName: string;
	/**
	 * Validate credentials before a stream exists. `StreamFunction` may throw
	 * synchronously when auth is missing, and the shared loop compares a custom
	 * `fetch` first, so this runs as `stream()` is called.
	 */
	assertCredentials: (model: Model<TApi>, options: TOptions | undefined) => void;
	createClient: (model: Model<TApi>, context: TranscriptContext, options: TOptions) => GoogleGenAI;
}

/** `stream`/`streamSimple` shape that keeps the adapter's own option type. */
export type GoogleStreamFunction<TApi extends GoogleApiType, TOptions extends StreamOptions> = (
	model: Model<TApi>,
	context: TranscriptContext,
	options?: TOptions,
) => AssistantMessageEventStream;

/** Bind the shared loop to one adapter. */
export function createGoogleStream<TApi extends GoogleApiType, TOptions extends GoogleSharedStreamOptions>(
	api: TApi,
	adapter: GoogleAdapter<TApi, TOptions>,
): {
	stream: GoogleStreamFunction<TApi, TOptions>;
	streamSimple: GoogleStreamFunction<TApi, SimpleStreamOptions>;
} {
	const stream: GoogleStreamFunction<TApi, TOptions> = (model, context, options) => {
		adapter.assertCredentials(model, options);
		return streamGoogleContent(api, model, context, adapter, options);
	};

	const streamSimple: GoogleStreamFunction<TApi, SimpleStreamOptions> = (model, context, options) => {
		const base = {
			...buildBaseOptions(model, context, options),
			toolChoice: options?.toolChoice,
			thinkingBudgets: options?.thinkingBudgets,
		} satisfies GoogleSharedStreamOptions;
		if (!options?.reasoning) {
			return stream(model, context, { ...base, thinking: { enabled: false } } as TOptions);
		}

		const clampedReasoning = clampThinkingLevel(model, options.reasoning);
		if (clampedReasoning === "off") {
			return stream(model, context, { ...base, thinking: { enabled: false } } as TOptions);
		}
		const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);

		if (usesGoogleThinkingLevel(model)) {
			return stream(model, context, {
				...base,
				thinking: { enabled: true, level: toGoogleThinkingLevel(resolvedLevel) },
			} as TOptions);
		}

		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets),
			},
		} as TOptions);
	};

	return { stream, streamSimple };
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

function streamGoogleContent<TApi extends GoogleApiType, TOptions extends GoogleSharedStreamOptions>(
	api: TApi,
	model: Model<TApi>,
	context: TranscriptContext,
	adapter: GoogleAdapter<TApi, TOptions>,
	options: TOptions | undefined,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: api as Api,
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

		try {
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				throw new Error(`Custom fetch is not supported by the ${adapter.adapterName} adapter`);
			}
			const client = adapter.createClient(model, context, (options ?? {}) as TOptions);
			let params = buildGoogleParams(model, normalizedContext, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				await options?.onProviderStreamEvent?.(chunk, model);
				// @google/genai documents GenerateContentResponse.responseId as an output-only
				// identifier for each response. Keep the first non-empty one from the stream.
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							const isThinking = isThinkingPart(part);
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blocks.length - 1,
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							// Generate unique ID if not provided or if it's a duplicate
							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							output.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					output.usage = {
						input:
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, output.usage);
				}
			}

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error(`${adapter.adapterName} stream ended without a finish reason`);
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new Error(errorMessage);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Remove internal index property used during streaming
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/** Build the `GenerateContentParameters` both adapters send. */
function buildGoogleParams<TApi extends GoogleApiType>(
	model: Model<TApi>,
	context: TranscriptContext,
	options: GoogleSharedStreamOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const currentTools = getCurrentTools(context.messages);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode =
		currentTools.length > 0
			? resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode)
			: undefined;
	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(systemInstruction && { systemInstruction: sanitizeSurrogates(systemInstruction) }),
		...(currentTools.length > 0 && {
			tools: convertTools(currentTools, false, supportsStrictMode),
		}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

/**
 * Per-level thinking budgets for the token-based Gemini models. One table serves
 * both adapters: the Gemini 2.5 tier is the same model family wherever it runs.
 * `google-generative-ai` also carried a `2.5-flash-lite` table, which no id could
 * reach — `gemini-2.5-flash-lite` contains `2.5-flash`, so that branch answered
 * first with the same numbers up to `medium` and 24576 at `high`.
 */
function getGoogleBudget<TApi extends GoogleApiType>(
	model: Model<TApi>,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[level] !== undefined) {
		return customBudgets[level]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	return -1;
}
