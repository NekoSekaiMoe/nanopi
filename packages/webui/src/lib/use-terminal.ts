"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "@/lib/api";
import { randomId } from "@/lib/utils";
import { t } from "@/lib/i18n";

/** One running or finished command in the scratch terminal. */
export interface TerminalEntry {
	id: string;
	command: string;
	output: string;
	code: number | null;
	error?: string;
	running: boolean;
}

/** Cap on retained output per entry; a runaway command must not freeze the tab. */
const MAX_ENTRY_CHARS = 200_000;
/** Keep the transcript bounded so long sessions stay responsive. */
const MAX_ENTRIES = 40;

/**
 * WebSocket endpoints cannot carry an Authorization header from a browser, so
 * the bearer token rides in the query string instead.
 */
function terminalUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const token = getToken();
	const query = token ? `?token=${encodeURIComponent(token)}` : "";
	return `${protocol}//${window.location.host}/terminal${query}`;
}

/**
 * Opens a WebSocket to `/terminal` and speaks newline-delimited JSON. The socket
 * is created lazily on the first command so the sidebar stays inert until the
 * terminal tab is actually used.
 */
export function useTerminal(cwd: string) {
	const [entries, setEntries] = useState<TerminalEntry[]>([]);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const socketRef = useRef<WebSocket | null>(null);
	const pendingRef = useRef<string | null>(null);
	const cwdRef = useRef(cwd);
	cwdRef.current = cwd;

	const connect = useCallback((): WebSocket | null => {
		if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
			return socketRef.current;
		}
		try {
			const socket = new WebSocket(terminalUrl());
			socketRef.current = socket;
			socket.addEventListener("open", () => {
				setConnected(true);
				// The directory belongs to the socket, not the credentials: the
				// server already authenticated the upgrade request.
				socket.send(JSON.stringify({ type: "cd", path: cwdRef.current }));
			});
			socket.addEventListener("close", () => {
				setConnected(false);
				socketRef.current = null;
			});
			socket.addEventListener("error", () => {
				setError(t("终端连接失败"));
			});
			socket.addEventListener("message", (event) => {
				// Each frame is one JSON message; a frame may still hold several
				// newline-separated documents if a proxy coalesced them.
				const data = typeof event.data === "string" ? event.data : "";
				for (const line of data.split("\n")) {
					const payload = line.trim();
					if (!payload.startsWith("{")) continue;
					let message: Record<string, unknown>;
					try {
						message = JSON.parse(payload) as Record<string, unknown>;
					} catch {
						continue;
					}
					if (message.type === "start") {
						setError(null);
						continue;
					}
					if (message.type === "output" && typeof message.data === "string") {
						const text = message.data;
						setEntries((current) =>
							current.map((entry) =>
								entry.id === pendingRef.current
									? { ...entry, output: (entry.output + text).slice(-MAX_ENTRY_CHARS) }
									: entry,
							),
						);
						continue;
					}
					if (message.type === "exit") {
						const id = typeof message.id === "string" ? message.id : pendingRef.current;
						pendingRef.current = null;
						setEntries((current) =>
							current.map((entry) =>
								entry.id === id
									? {
											...entry,
											running: false,
											code: typeof message.code === "number" ? message.code : null,
											error: typeof message.error === "string" ? message.error : undefined,
										}
									: entry,
							),
						);
					}
				}
			});
			return socket;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return null;
		}
	}, []);

	const run = useCallback(
		(command: string) => {
			const trimmed = command.trim();
			if (!trimmed) return;
			const socket = connect();
			if (!socket) return;
			const send = () => {
				const id = randomId();
				pendingRef.current = id;
				setEntries((current) =>
					[...current, { id, command: trimmed, output: "", code: null, running: true }].slice(
						-MAX_ENTRIES,
					),
				);
				socket.send(JSON.stringify({ type: "exec", command: trimmed, id }));
			};
			if (socket.readyState === WebSocket.OPEN) send();
			else socket.addEventListener("open", send, { once: true });
		},
		[connect],
	);

	const clear = useCallback(() => {
		setEntries([]);
	}, []);

	// A working directory change starts a fresh shell on the next command.
	useEffect(() => {
		socketRef.current?.close();
		socketRef.current = null;
		setConnected(false);
		setEntries([]);
	}, [cwd]);

	useEffect(() => {
		return () => {
			socketRef.current?.close();
			socketRef.current = null;
		};
	}, []);

	return { entries, connected, error, cwd, run, clear };
}
