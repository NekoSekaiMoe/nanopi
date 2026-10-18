"use client";

import { useCallback, useRef, useState } from "react";
import {
	type ApprovalMode,
	type ImageData,
	type SessionMessage,
	type SSEEvent,
	type UserInputRequestEvent,
	type UserInputResponse,
	createSession,
	getSession,
	postChatUserInput,
	respondPermission,
	stopChat,
	streamChat,
} from "@/lib/api";
import { randomId } from "@/lib/utils";

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
	images?: ImageData[];
	createdAt?: number;
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
			out.push({ id: randomId(), role: "assistant", blocks, createdAt: message.created_at });
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

export function useChat({ projectHash, workingDir, provider, onSessionsChanged, onTurnDone }: UseChatOptions) {
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [messages, setMessages] = useState<UiMessage[]>([]);
	const [streaming, setStreaming] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [permission, setPermission] = useState<PendingPermission | null>(null);
	const [userInput, setUserInput] = useState<UserInputRequestEvent | null>(null);
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>("standard");

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
			setError(null);
			artifactRef.current = null;
			setLoading(true);
			setCurrentSession(id);
			try {
				const detail = await getSession(projectHash, id);
				if (generationRef.current !== generation) return;
				setMessages(fromSessionMessages(detail.messages));
				const url = new URL(window.location.href);
				url.searchParams.set("session", id.slice(0, 8));
				window.history.replaceState(null, "", url.toString());
			} catch (cause) {
				if (generationRef.current === generation) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			} finally {
				if (generationRef.current === generation) setLoading(false);
			}
		},
		[projectHash, setCurrentSession, detachStream],
	);

	const newSession = useCallback(() => {
		generationRef.current += 1;
		detachStream();
		setStreaming(false);
		setPermission(null);
		setUserInput(null);
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
					setError(cause instanceof Error ? cause.message : String(cause));
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
					(event: SSEEvent) => {
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
								setNotice(event.message ?? "请求过于频繁，请稍后再试");
								break;
							case "error":
								setError(event.message);
								break;
							case "stopped":
								setStreaming(false);
								break;
							case "done":
								setStreaming(false);
								setPermission(null);
								setUserInput(null);
								window.setTimeout(onSessionsChanged, 250);
								onTurnDone?.();
								break;
							default:
								break;
						}
					},
					controller.signal,
				);
			} catch (cause) {
				const aborted = cause instanceof Error && cause.name === "AbortError";
				if (!aborted && generationRef.current === generation) {
					const message = cause instanceof Error ? cause.message : String(cause);
					setError(message);
					setMessages((current) =>
						updateLastAssistant(current, (blocks) =>
							appendStreamBlock(blocks, "text", `\n\n连接中断：${message}`),
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
		async (decision: "allow" | "deny" | "allow_session") => {
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
				setError(cause instanceof Error ? cause.message : String(cause));
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
				setError(cause instanceof Error ? cause.message : String(cause));
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
