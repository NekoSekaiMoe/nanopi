"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ApprovalMode,
	type ImageData,
	type PlanItem,
	type SessionMessage,
	type SSEEvent,
	type UserInputRequestEvent,
	type UserInputResponse,
	createSession,
	getChatActive,
	getSession,
	postChatUserInput,
	respondPermission,
	setApprovalMode as putApprovalMode,
	stopChat,
	streamApprovalMode,
	streamChat,
} from "@/lib/api";
import { randomId } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** Answers a permission card can send; `ai_decide` lets the model rule on the call. */
export type PermissionAnswer = "allow" | "deny" | "allow_session" | "ai_decide";

export interface TextBlock {
	kind: "text";
	text: string;
}

export interface ReasoningBlock {
	kind: "reasoning";
	text: string;
}

export interface ToolBlock {
	kind: "tool";
	id: string;
	name: string;
	args: unknown;
	display: string;
	output: string;
	status: "running" | "done" | "error";
	durationMs?: number;
	progress?: string;
}

export type UiBlock = TextBlock | ReasoningBlock | ToolBlock;

export interface UiMessage {
	id: string;
	role: "user" | "assistant" | "system";
	blocks: UiBlock[];
	/** `provider/model` that produced an assistant reply, when the transcript knows it. */
	provider?: string;
	images?: ImageData[];
	createdAt?: number;
}

/** A turn failure the UI can show verbatim, including the provider status. */
export interface TurnError {
	message: string;
	code?: number;
	retrying: boolean;
}

export interface PendingPermission {
	sessionId: string;
	toolName: string;
	reason: string;
	callId: string;
	args: unknown;
	allowAllBash?: boolean;
}

interface UseChatOptions {
	projectHash: string;
	workingDir: string;
	provider: string;
	onSessionsChanged: () => void;
	onTurnDone?: () => void;
	/** Thinking level recorded in a loaded transcript; the picker adopts it. */
	onThinkingLevel?: (level: string | undefined) => void;
}

function fromSessionMessages(messages: SessionMessage[]): UiMessage[] {
	const out: UiMessage[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			out.push({
				id: randomId(),
				role: "user",
				blocks: message.content ? [{ kind: "text", text: message.content }] : [],
				images: message.images,
				createdAt: message.created_at,
			});
			continue;
		}
		if (message.role === "assistant") {
			const blocks: UiBlock[] = [];
			if (message.content) blocks.push({ kind: "text", text: message.content });
			for (const call of message.tool_calls ?? []) {
				blocks.push({
					kind: "tool",
					id: call.id,
					name: call.name,
					args: call.arguments,
					display: call.display,
					output: "",
					status: "done",
				});
			}
			out.push({
				id: randomId(),
				role: "assistant",
				blocks,
				provider: message.provider,
				createdAt: message.created_at,
			});
			continue;
		}
		if (message.role === "tool") {
			const block: ToolBlock = {
				kind: "tool",
				id: message.tool_result?.call_id ?? randomId(),
				name: "tool",
				args: "",
				display: "",
				output: message.content,
				status: message.tool_result?.success === false ? "error" : "done",
			};
			for (let index = out.length - 1; index >= 0; index -= 1) {
				const candidate = out[index];
				if (candidate.role !== "assistant") continue;
				const existing = candidate.blocks.find(
					(item): item is ToolBlock =>
						item.kind === "tool" && item.id === message.tool_result?.call_id,
				);
				if (existing) {
					existing.output = message.content;
					existing.status = message.tool_result?.success === false ? "error" : "done";
					break;
				}
			}
			continue;
		}
		if (message.content && !message.synthetic) {
			out.push({
				id: randomId(),
				role: "system",
				blocks: [{ kind: "text", text: message.content }],
				createdAt: message.created_at,
			});
		}
	}
	return out;
}

function updateLastAssistant(
	messages: UiMessage[],
	update: (blocks: UiBlock[]) => UiBlock[],
): UiMessage[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const copy = [...messages];
		copy[index] = { ...message, blocks: update(message.blocks) };
		return copy;
	}
	return messages;
}

function appendStreamBlock(
	blocks: UiBlock[],
	kind: "text" | "reasoning",
	text: string,
): UiBlock[] {
	const last = blocks[blocks.length - 1];
	if (last && last.kind === kind) {
		const copy = [...blocks];
		copy[copy.length - 1] = { ...last, text: last.text + text };
		return copy;
	}
	return [...blocks, { kind, text }];
}

function appendToolOutput(blocks: UiBlock[], chunk: string): UiBlock[] {
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (block.kind === "tool" && block.status === "running") {
			const copy = [...blocks];
			copy[index] = { ...block, output: block.output + chunk };
			return copy;
		}
	}
	return blocks;
}

function finishTool(
	blocks: UiBlock[],
	event: { id: string; name: string; output: string; success: boolean; duration_ms: number },
): UiBlock[] {
	let index = blocks.findIndex((block) => block.kind === "tool" && block.id === event.id);
	if (index < 0) {
		for (let cursor = blocks.length - 1; cursor >= 0; cursor -= 1) {
			const block = blocks[cursor];
			if (block.kind === "tool" && block.name === event.name) {
				index = cursor;
				break;
			}
		}
	}
	if (index < 0) return blocks;
	const block = blocks[index] as ToolBlock;
	const copy = [...blocks];
	copy[index] = {
		...block,
		output: event.output || block.output,
		status: event.success ? "done" : "error",
		durationMs: event.duration_ms,
	};
	return copy;
}

/** Normalize a thrown transport/HTTP failure into the banner shape. */
function turnErrorFrom(cause: unknown): TurnError {
	const message = cause instanceof Error ? cause.message : String(cause);
	const code =
		typeof (cause as { status?: unknown })?.status === "number"
			? ((cause as { status: number }).status as number)
			: undefined;
	return { message, code, retrying: false };
}

export function useChat({
	projectHash,
	workingDir,
	provider,
	onSessionsChanged,
	onTurnDone,
	onThinkingLevel,
}: UseChatOptions) {
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [messages, setMessages] = useState<UiMessage[]>([]);
	const [streaming, setStreaming] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<TurnError | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [permission, setPermission] = useState<PendingPermission | null>(null);
	const [userInput, setUserInput] = useState<UserInputRequestEvent | null>(null);
	const [plan, setPlan] = useState<PlanItem[]>([]);
	const [approvalMode, setApprovalModeState] = useState<ApprovalMode>("standard");

	const abortRef = useRef<AbortController | null>(null);
	const requestIdRef = useRef<string | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const generationRef = useRef(0);
	const artifactRef = useRef<{ lang: string; buffer: string } | null>(null);

	const setCurrentSession = useCallback((id: string | null) => {
		sessionIdRef.current = id;
		setSessionId(id);
	}, []);

	const detachStream = useCallback(() => {
		const alias = requestIdRef.current;
		abortRef.current?.abort();
		abortRef.current = null;
		requestIdRef.current = null;
		if (alias) void stopChat(alias).catch(() => {});
	}, []);

	const loadSession = useCallback(
		async (id: string) => {
			if (!projectHash) return;
			const generation = generationRef.current + 1;
			generationRef.current = generation;
			detachStream();
			setStreaming(false);
			setPermission(null);
			setUserInput(null);
			setPlan([]);
			setError(null);
			artifactRef.current = null;
			setLoading(true);
			setCurrentSession(id);
			try {
				const detail = await getSession(projectHash, id);
				if (generationRef.current !== generation) return;
				setMessages(fromSessionMessages(detail.messages));
				// The plan is a tool detail the transcript does not carry per message,
				// so the backend derives it from the log; without it a reloaded
				// session would stay plan-less until the next todo call.
				setPlan(detail.plan ?? []);
				// A transcript carries its own thinking level; show the one the
				// resumed session will actually use instead of the previous model's.
				onThinkingLevel?.(detail.thinking_level);
				const url = new URL(window.location.href);
				url.searchParams.set("session", id.slice(0, 8));
				window.history.replaceState(null, "", url.toString());
			} catch (cause) {
				if (generationRef.current === generation) {
					setError(turnErrorFrom(cause));
				}
			} finally {
				if (generationRef.current === generation) setLoading(false);
			}
		},
		[projectHash, setCurrentSession, detachStream, onThinkingLevel],
	);

	const newSession = useCallback(() => {
		generationRef.current += 1;
		detachStream();
		setStreaming(false);
		setPermission(null);
		setUserInput(null);
		setPlan([]);
		setError(null);
		artifactRef.current = null;
		setMessages([]);
		setCurrentSession(null);
		try {
			const url = new URL(window.location.href);
			url.searchParams.delete("session");
			window.history.replaceState(null, "", url.toString());
		} catch {
			/* ignore */
		}
	}, [setCurrentSession, detachStream]);

	const onSseEvent = (
		event: SSEEvent,
		generation: number,
		targetSession: string | null,
	): void => {
		if (generationRef.current !== generation) return;
		switch (event.type) {
			case "session_assigned": {
				setCurrentSession(event.session_id);
				try {
					const url = new URL(window.location.href);
					url.searchParams.set("session", event.session_id.slice(0, 8));
					window.history.replaceState(null, "", url.toString());
				} catch {
					/* ignore */
				}
				break;
			}
			case "text":
				setMessages((current) =>
					updateLastAssistant(current, (blocks) =>
						appendStreamBlock(blocks, "text", event.content),
					),
				);
				break;
			case "reasoning":
				setMessages((current) =>
					updateLastAssistant(current, (blocks) =>
						appendStreamBlock(blocks, "reasoning", event.content),
					),
				);
				break;
			case "tool_start":
				setMessages((current) =>
					updateLastAssistant(current, (blocks) => [
						...blocks,
						{
							kind: "tool",
							id: event.id,
							name: event.name,
							args: event.arguments,
							display: "",
							output: "",
							status: "running",
						},
					]),
				);
				break;
			case "tool_output":
				setMessages((current) =>
					updateLastAssistant(current, (blocks) =>
						appendToolOutput(blocks, event.chunk),
					),
				);
				break;
			case "tool_progress":
				setMessages((current) =>
					updateLastAssistant(current, (blocks) => {
						for (let index = blocks.length - 1; index >= 0; index -= 1) {
							const block = blocks[index];
							if (block.kind === "tool" && block.id === event.id) {
								const copy = [...blocks];
								copy[index] = { ...block, progress: event.progress };
								return copy;
							}
						}
						return blocks;
					}),
				);
				break;
			case "tool_result":
				// Plan snapshots ride on the todo tool's result; keep the
				// latest one instead of deriving it from the transcript.
				if (event.plan) setPlan(event.plan);
				setMessages((current) =>
					updateLastAssistant(current, (blocks) => finishTool(blocks, event)),
				);
				break;
			case "artifact_start":
				artifactRef.current = { lang: event.language ?? "", buffer: "" };
				break;
			case "artifact_content":
				if (artifactRef.current) artifactRef.current.buffer += event.content;
				break;
			case "artifact_end": {
				const artifact = artifactRef.current;
				artifactRef.current = null;
				if (!artifact) break;
				const fence = "```";
				const block = `\n\n${fence}${artifact.lang}\n${artifact.buffer}\n${fence}\n\n`;
				setMessages((current) =>
					updateLastAssistant(current, (blocks) =>
						appendStreamBlock(blocks, "text", block),
					),
				);
				break;
			}
			case "command_output":
				setMessages((current) =>
					updateLastAssistant(current, (blocks) =>
						appendStreamBlock(blocks, "text", `\n\n${event.text}\n\n`),
					),
				);
				break;
			case "permission_request":
				setPermission({
					sessionId: event.session_id || targetSession || "",
					toolName: event.tool_name,
					reason: event.reason,
					callId: event.call_id,
					args: event.arguments,
					allowAllBash: event.allow_all_bash,
				});
				break;
			case "user_input_request":
				setUserInput(event);
				break;
			case "warning":
				setNotice(event.message);
				break;
			case "persistence_warning":
				setNotice(event.message);
				break;
			case "rate_limited":
				setNotice(event.message ?? t("请求过于频繁，请稍后再试"));
				break;
			case "error":
				// The backend forwards the provider status; show it as is.
				// `retrying` means the runtime may recover, which the
				// composer reflects instead of a stuck "thinking" state.
				setError({
					message: event.message,
					code: event.code,
					retrying: event.retrying === true,
				});
				break;
			case "retry":
				setNotice(
					`${t("重试中")} (${event.attempt}/${event.max_attempts}) · ${event.message}`,
				);
				break;
			case "stopped":
				setStreaming(false);
				break;
			case "done":
				setStreaming(false);
				setPermission(null);
				setUserInput(null);
				window.setTimeout(onSessionsChanged, 250);
				if (event.stop_reason === "error" && event.message) {
					setError({ message: event.message, code: event.code, retrying: false });
				}
				onTurnDone?.();
				break;
			default:
				break;
		}
	};

	/**
	 * Mirror the daemon run mode. The mode lives in the process, not in this tab,
	 * so the highlight follows the engine: the settings page switches it, and a
	 * turn can switch it too (plan mode ends with an approval prompt). The stream
	 * seeds from the current mode and keeps following from there.
	 */
	useEffect(() => {
		const controller = new AbortController();
		// The mode is a display detail: a dropped stream must not raise a banner.
		void streamApprovalMode((event) => setApprovalModeState(event.mode), controller.signal).catch(() => {});
		return () => controller.abort();
	}, []);

	/**
	 * Switch the run mode. The optimistic update keeps the button responsive, and
	 * the reply (or the stream) settles the state when the daemon disagrees.
	 */
	const setApprovalMode = useCallback((mode: ApprovalMode) => {
		setApprovalModeState(mode);
		void putApprovalMode(mode)
			.then((applied) => setApprovalModeState(applied))
			.catch((cause: unknown) => setError(turnErrorFrom(cause)));
	}, []);

	const send = useCallback(
		async (text: string, images: ImageData[] = []) => {
			const trimmed = text.trim();
			if ((!trimmed && images.length === 0) || streaming) return;
			const generation = generationRef.current + 1;
			generationRef.current = generation;
			setError(null);
			setNotice(null);
			artifactRef.current = null;

			let targetSession = sessionIdRef.current;
			if (!targetSession) {
				try {
					const created = await createSession(workingDir || undefined);
					if (generationRef.current !== generation) return;
					targetSession = created.id;
					setCurrentSession(created.id);
					const url = new URL(window.location.href);
					url.searchParams.set("session", created.id.slice(0, 8));
					window.history.replaceState(null, "", url.toString());
					onSessionsChanged();
				} catch (cause) {
					setError(turnErrorFrom(cause));
					return;
				}
			}

			const now = Date.now();
			setMessages((previous) => [
				...previous,
				{
					id: randomId(),
					role: "user",
					blocks: trimmed ? [{ kind: "text", text: trimmed }] : [],
					images: images.length ? images : undefined,
					createdAt: now,
				},
				{ id: randomId(), role: "assistant", blocks: [], createdAt: now },
			]);
			setStreaming(true);

			const controller = new AbortController();
			abortRef.current = controller;
			const requestId = randomId();
			requestIdRef.current = requestId;

			try {
				await streamChat(
					{
						message: trimmed,
						session_id: targetSession ?? undefined,
						request_id: requestId,
						working_dir: workingDir || undefined,
						provider: provider || undefined,
						images: images.length ? images : undefined,
						approval_mode: approvalMode,
					},
					(event: SSEEvent) => onSseEvent(event, generation, targetSession),
					controller.signal,
				);
			} catch (cause) {
				const aborted = cause instanceof Error && cause.name === "AbortError";
				if (!aborted && generationRef.current === generation) {
					const message = cause instanceof Error ? cause.message : String(cause);
					setError(turnErrorFrom(cause));
					setMessages((current) =>
						updateLastAssistant(current, (blocks) =>
							appendStreamBlock(blocks, "text", `\n\n${t("连接中断：")}${message}`),
						),
					);
				}
			} finally {
				if (generationRef.current === generation) {
					setStreaming(false);
					if (abortRef.current === controller) abortRef.current = null;
					if (requestIdRef.current === requestId) requestIdRef.current = null;
				}
			}
		},
		[
			approvalMode,
			onSessionsChanged,
			onTurnDone,
			provider,
			setCurrentSession,
			streaming,
			workingDir,
		],
	);

	/**
	 * Follow a turn this tab did not ask for.
	 *
	 * A background turn (a job reporting in, a prompt queued behind the running one)
	 * has no HTTP response behind it: its events go nowhere, so the report only lands
	 * in the transcript and the chat sits unchanged until a reload. Polling
	 * `/chat/active` catches the start, and a session reload is what turns a settled
	 * turn into what the user sees. While a local turn streams, its own SSE handler
	 * already updates the view.
	 */
	const backgroundWatchRef = useRef<{ busy: boolean; generation: number }>({ busy: false, generation: -1 });
	useEffect(() => {
		if (streaming) {
			backgroundWatchRef.current = { busy: false, generation: generationRef.current };
			return;
		}
		let cancelled = false;
		let timer: number | undefined;
		const tick = () => {
			void getChatActive()
				.then((sessions) => {
					if (cancelled) return;
					const active = sessions.length > 0;
					const previous = backgroundWatchRef.current;
					if (previous.busy && !active && previous.generation === generationRef.current) {
						// The background turn just settled: reload the transcript it wrote.
						const id = sessionIdRef.current;
						if (id) void loadSession(id);
						onSessionsChanged();
					}
					backgroundWatchRef.current = {
						busy: active,
						generation: active ? generationRef.current : backgroundWatchRef.current.generation,
					};
				})
				.catch(() => {
					/* a poll that fails is not worth a banner */
				})
				.finally(() => {
					if (!cancelled) timer = window.setTimeout(tick, 2000);
				});
		};
		timer = window.setTimeout(tick, 1500);
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [streaming, loadSession, onSessionsChanged]);

	const stop = useCallback(async () => {
		const alias = requestIdRef.current;
		abortRef.current?.abort();
		abortRef.current = null;
		setStreaming(false);
		setPermission(null);
		setUserInput(null);
		if (!alias) return;
		try {
			await stopChat(alias);
		} catch {
			/* the stream is already detached */
		}
		onSessionsChanged();
	}, [onSessionsChanged]);

	const answerPermission = useCallback(
		async (decision: PermissionAnswer) => {
			const pending = permission;
			if (!pending) return;
			setPermission(null);
			try {
				await respondPermission(
					pending.sessionId || sessionIdRef.current || "",
					decision,
					pending.toolName,
					pending.callId,
				);
			} catch (cause) {
				setError(turnErrorFrom(cause));
			}
		},
		[permission],
	);

	const answerUserInput = useCallback(
		async (answer: UserInputResponse) => {
			const pending = userInput;
			if (!pending) return;
			setUserInput(null);
			try {
				const body =
					"responses" in answer
						? { request_id: pending.request_id, responses: answer.responses }
						: { request_id: pending.request_id, ...answer };
				await postChatUserInput(pending.session_id || sessionIdRef.current || "", body);
			} catch (cause) {
				setError(turnErrorFrom(cause));
			}
		},
		[userInput],
	);

	return {
		sessionId,
		messages,
		streaming,
		loading,
		error,
		notice,
		permission,
		userInput,
		plan,
		approvalMode,
		setApprovalMode,
		setError,
		setNotice,
		loadSession,
		newSession,
		send,
		stop,
		answerPermission,
		answerUserInput,
	};
}
