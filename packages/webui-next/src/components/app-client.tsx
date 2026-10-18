"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/auth-gate";
import { ChatPane } from "@/components/chat-pane";
import { Logo } from "@/components/logo";
import { MobileBar } from "@/components/mobile-bar";
import { SettingsOverlay, type ThemeChoice } from "@/components/settings";
import { Sidebar } from "@/components/sidebar";
import {
	ApiError,
	type ImageData,
	type ModelInfo,
	type ProjectState,
	type SessionMetaWithProject,
	getModels,
	getProject,
	getToken,
	listProjectSessions,
	resolveSession,
} from "@/lib/api";
import { useChat } from "@/lib/use-chat";
import { cn } from "@/lib/utils";

function readStoredTheme(): ThemeChoice {
	try {
		const value = localStorage.getItem("nanopi.theme");
		if (value === "light" || value === "dark" || value === "system") return value;
	} catch {
		/* ignore */
	}
	return "system";
}

export function AppClient() {
	const [project, setProject] = useState<ProjectState | null>(null);
	const [sessions, setSessions] = useState<SessionMetaWithProject[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [provider, setProvider] = useState("");
	const [theme, setTheme] = useState<ThemeChoice>(readStoredTheme);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [navOpen, setNavOpen] = useState(false);
	const [composer, setComposer] = useState("");
	const [images, setImages] = useState<ImageData[]>([]);
	const [bootError, setBootError] = useState<string | null>(null);
	const [booted, setBooted] = useState(false);
	const [authRequired, setAuthRequired] = useState(false);
	const [pendingSession, setPendingSession] = useState<string | null>(null);
	const restoredRef = useRef(false);

	const projectHash = project?.project_hash ?? "";
	const workingDir = project?.working_dir ?? "";

	const refreshSessions = useCallback(async () => {
		if (!projectHash) return;
		try {
			const list = await listProjectSessions(projectHash);
			setSessions(list);
		} catch (cause) {
			setBootError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [projectHash]);

	const chat = useChat({
		projectHash,
		workingDir,
		provider,
		onSessionsChanged: refreshSessions,
	});

	// Boot: project + model catalog.
	useEffect(() => {
		if (!getToken()) {
			setAuthRequired(true);
			setBooted(true);
			return;
		}
		let cancelled = false;
		void Promise.all([getProject(), getModels()])
			.then(([nextProject, nextModels]) => {
				if (cancelled) return;
				setProject(nextProject);
				setModels(nextModels);
				const usable = nextModels.filter((model) => model.provider_type !== "unknown");
				const fallback =
					usable.find((model) => model.is_default)?.provider ?? usable[0]?.provider ?? "";
				let saved = "";
				try {
					saved = localStorage.getItem("nanopi.provider") ?? "";
				} catch {
					/* ignore */
				}
				setProvider(saved && usable.some((model) => model.provider === saved) ? saved : fallback);
				setBooted(true);
			})
			.catch((cause) => {
				if (cancelled) return;
				if (cause instanceof ApiError && cause.status === 401) {
					setAuthRequired(true);
				} else {
					setBootError(cause instanceof Error ? cause.message : String(cause));
				}
				setBooted(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		void refreshSessions();
	}, [refreshSessions]);

	// Restore a session from the short id in the URL, inside the current project.
	useEffect(() => {
		if (!projectHash || restoredRef.current) return;
		restoredRef.current = true;
		let cancelled = false;
		try {
			const short = new URLSearchParams(window.location.search).get("session");
			if (!short) return;
			void resolveSession(short).then((meta) => {
				if (cancelled || !meta) return;
				if (meta.project_hash === projectHash) {
					void chat.loadSession(meta.id);
					return;
				}
				setProject({
					working_dir: meta.working_dir,
					project_hash: meta.project_hash,
					name: meta.working_dir.split("/").filter(Boolean).pop() || "",
				});
				setPendingSession(meta.id);
			});
		} catch {
			/* ignore */
		}
		return () => {
			cancelled = true;
		};
		// chat.loadSession is stable enough for the one-shot URL restore.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projectHash]);

	useEffect(() => {
		if (!pendingSession || !projectHash) return;
		setPendingSession(null);
		void chat.loadSession(pendingSession);
		// chat.loadSession is intentionally excluded: it changes every render,
		// and this effect must fire once per pending session.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingSession, projectHash]);

	// Theme.
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const dark = theme === "dark" || (theme === "system" && media.matches);
			document.documentElement.classList.toggle("dark", dark);
			document.documentElement.style.colorScheme = dark ? "dark" : "light";
		};
		apply();
		try {
			localStorage.setItem("nanopi.theme", theme);
		} catch {
			/* ignore */
		}
		if (theme !== "system") return;
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [theme]);

	useEffect(() => {
		try {
			if (provider) localStorage.setItem("nanopi.provider", provider);
		} catch {
			/* ignore */
		}
	}, [provider]);

	useEffect(() => {
		try {
			const url = new URL(window.location.href);
			if (!url.searchParams.has("token")) return;
			url.searchParams.delete("token");
			window.history.replaceState(null, "", url.toString());
		} catch {
			/* ignore */
		}
	}, []);

	useEffect(() => {
		if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
		void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
			/* offline shell is optional */
		});
	}, []);

	useEffect(() => {
		if (!navOpen && !settingsOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (settingsOpen) setSettingsOpen(false);
			else setNavOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [navOpen, settingsOpen]);

	const usableModels = models.filter((model) => model.provider_type !== "unknown");

	const currentSession = chat.sessionId
		? sessions.find((session) => session.id === chat.sessionId) ?? null
		: null;
	const projectName =
		project?.name || workingDir.split("/").filter(Boolean).pop() || "";
	const title = currentSession?.name || "NanoPi";

	const onSend = useCallback(() => {
		const text = composer;
		const pendingImages = images;
		if (!text.trim() && pendingImages.length === 0) return;
		setComposer("");
		setImages([]);
		void chat.send(text, pendingImages);
	}, [chat, composer, images]);

	const onNew = useCallback(() => {
		chat.newSession();
		setComposer("");
		setImages([]);
		setNavOpen(false);
	}, [chat]);

	const onSelectSession = useCallback(
		(session: SessionMetaWithProject) => {
			setNavOpen(false);
			setComposer("");
			setImages([]);
			void chat.loadSession(session.id);
		},
		[chat],
	);

	const openSettings = useCallback(() => {
		setSettingsOpen(true);
		setNavOpen(false);
	}, []);

	if (authRequired) return <AuthGate />;

	if (!booted) {
		return (
			<div className="grid h-dvh w-screen place-items-center bg-background">
				<div className="flex flex-col items-center gap-3">
					<Logo size={40} />
					<div className="h-0.5 w-20 overflow-hidden rounded-full bg-muted">
						<div className="h-full w-1/2 animate-pulse rounded-full bg-foreground/40" />
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-dvh w-screen overflow-hidden bg-background text-foreground">
			<div className="hidden h-full shrink-0 md:block">
				<Sidebar
					sessions={sessions}
					currentSessionId={chat.sessionId}
					projectName={projectName}
					workingDir={workingDir}
					onSelectSession={onSelectSession}
					onNew={onNew}
					onOpenSettings={openSettings}
				/>
			</div>

			<main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
				<MobileBar title={title} onOpenMenu={() => setNavOpen(true)} onNew={onNew} />

				{bootError ? (
					<div className="mx-auto w-full max-w-[840px] px-4 pt-4">
						<div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
							连接 nanopi webui 失败：{bootError}
						</div>
					</div>
				) : null}

				<ChatPane
					messages={chat.messages}
					loading={chat.loading}
					streaming={chat.streaming}
					error={chat.error}
					notice={chat.notice}
					permission={chat.permission}
					userInput={chat.userInput}
					models={usableModels}
					provider={provider}
					onProvider={setProvider}
					onConfigure={openSettings}
					onDismissError={() => chat.setError(null)}
					onDismissNotice={() => chat.setNotice(null)}
					onSend={onSend}
					onStop={() => void chat.stop()}
					onAnswerPermission={(decision) => void chat.answerPermission(decision)}
					onAnswerUserInput={(answer) => void chat.answerUserInput(answer)}
					composer={composer}
					onComposer={setComposer}
					images={images}
					onImages={setImages}
					sessionName={title}
				/>
			</main>

			{/* Mobile navigation sheet */}
			<div
				className={cn(
					"fixed inset-0 z-40 md:hidden",
					navOpen ? "pointer-events-auto" : "pointer-events-none",
				)}
				aria-hidden={!navOpen}
				inert={!navOpen}
			>
				<button
					type="button"
					aria-label="关闭导航"
					onClick={() => setNavOpen(false)}
					className={cn(
						"absolute inset-0 bg-black/35 transition-opacity duration-200",
						navOpen ? "opacity-100" : "opacity-0",
					)}
				/>
				<div
					className={cn(
						"relative h-full transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
						navOpen ? "translate-x-0" : "-translate-x-full",
					)}
				>
					<Sidebar
						mobile
						sessions={sessions}
						currentSessionId={chat.sessionId}
						projectName={projectName}
						workingDir={workingDir}
						onSelectSession={onSelectSession}
						onNew={onNew}
						onOpenSettings={openSettings}
						onClose={() => setNavOpen(false)}
					/>
				</div>
			</div>

			<SettingsOverlay
				open={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				theme={theme}
				onTheme={setTheme}
				models={usableModels}
				provider={provider}
				onProvider={setProvider}
				project={project}
				approvalMode={chat.approvalMode}
				onApprovalMode={chat.setApprovalMode}
			/>
		</div>
	);
}
