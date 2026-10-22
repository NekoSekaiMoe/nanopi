"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AuthGate } from "@/components/auth-gate";
import { ChatPane } from "@/components/chat-pane";
import { FileViewer } from "@/components/file-viewer";
import { Logo } from "@/components/logo";
import { MobileBar } from "@/components/mobile-bar";
import { SettingsOverlay, type ThemeChoice } from "@/components/settings";
import { Sidebar } from "@/components/sidebar";
import { TerminalPane } from "@/components/terminal-pane";
import {
	ApiError,
	type ConfigInfo,
	type ImageData,
	type ModelInfo,
	type ProjectState,
	type SessionMetaWithProject,
	changeDir,
	deleteSession,
	getConfig,
	getModels,
	getProject,
	getToken,
	listProjectSessions,
	readBranch,
	renameSession,
	resolveSession,
	setReasoningEffort,
} from "@/lib/api";
import { useChat } from "@/lib/use-chat";
import { getLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

function readNotifications(): boolean {
	try {
		return localStorage.getItem("nanopi.notifications") === "1";
	} catch {
		return false;
	}
}

function readStoredTheme(): ThemeChoice {
	try {
		const value = localStorage.getItem("nanopi.theme");
		if (value === "light" || value === "dark" || value === "system") return value;
	} catch {
		/* ignore */
	}
	return "dark";
}

export function AppClient() {
	const [project, setProject] = useState<ProjectState | null>(null);
	const [sessions, setSessions] = useState<SessionMetaWithProject[]>([]);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [config, setConfig] = useState<ConfigInfo | null>(null);
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
	const [notifications, setNotifications] = useState(readNotifications);
	const [effort, setEffort] = useState<string | null>(null);
	const [branch, setBranch] = useState("");
	const [openFile, setOpenFile] = useState<string | null>(null);
	const [terminalOpen, setTerminalOpen] = useState(false);
	const [modelSheetOpen, setModelSheetOpen] = useState(false);
	const restoredRef = useRef(false);
	const titleRef = useRef("NanoPi");
	const notificationsRef = useRef(notifications);

	useEffect(() => {
		notificationsRef.current = notifications;
	}, [notifications]);

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

	const notifyTurnDone = useCallback(() => {
		if (!notificationsRef.current) return;
		if (!document.hidden) return;
		if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
		const notification = new Notification("NanoPi", {
			body: `${titleRef.current} · ${t("已完成")}`,
			icon: "/icon-192.png",
		});
		notification.onclick = () => {
			window.focus();
			notification.close();
		};
	}, []);

	const chat = useChat({
		projectHash,
		workingDir,
		provider,
		onSessionsChanged: refreshSessions,
		onTurnDone: notifyTurnDone,
		onThinkingLevel: (level) => {
			if (level) setEffort(level);
		},
	});

	// Boot: project + model catalog.
	useEffect(() => {
		if (!getToken()) {
			setAuthRequired(true);
			setBooted(true);
			return;
		}
		let cancelled = false;
		void Promise.all([getProject(), getModels(), getConfig().catch(() => null)])
			.then(([nextProject, nextModels, nextConfig]) => {
				if (cancelled) return;
				setProject(nextProject);
				setModels(nextModels);
				setConfig(nextConfig);
				const usable = nextModels.filter((model) => model.provider_type !== "unknown");
				const fallback =
					usable.find((model) => model.is_default)?.provider ?? usable[0]?.provider ?? "";
				let saved = "";
				try {
					saved = localStorage.getItem("nanopi.provider") ?? "";
				} catch {
					/* ignore */
				}
				// Stored credentials can arrive or disappear between runs; never
				// restore a model whose provider has no key.
				const runnable = usable.filter((model) => model.available);
				const storedUsable = saved && runnable.some((model) => model.provider === saved);
				setProvider(
					storedUsable
						? saved
						: (runnable.find((model) => model.is_default)?.provider ?? runnable[0]?.provider ?? ""),
				);
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

	// Runs before the model sheet opens, so the catalog is fresh. It must not
	// touch `provider`: the effect below refills `effort` from the new rows, and
	// /models reports the level for a model that is not the active one as null
	// (nothing picked yet); that null then replaced the level the user just
	// chose, because the refill effect wrote it straight into `effort`.
	const refreshProviders = useCallback(async () => {
		const [nextConfig, nextModels] = await Promise.all([getConfig(), getModels()]);
		setConfig(nextConfig);
		setModels(nextModels);
	}, []);

	const onChangeEffort = useCallback(
		async (level: string | null) => {
			const previous = effort;
			setEffort(level);
			if (!provider) return;
			try {
				const result = await setReasoningEffort(provider, level);
				// Reflect the clamped level the runtime actually accepted.
				setEffort(result.reasoning_effort);
				setModels((current) =>
					current.map((model) =>
						model.provider === provider ? { ...model, reasoning_effort: result.reasoning_effort } : model,
					),
				);
			} catch (cause) {
				setEffort(previous);
				setBootError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[effort, provider],
	);

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

	// The effort shown belongs to the active model: switching models must not
	// keep the previous model's level on screen, and a refreshed catalog must not
	// drop it either. A model with no stored level (`null`) keeps whatever is
	// local, which is the level the runtime will actually send.
	useEffect(() => {
		const current = models.find((model) => model.provider === provider);
		if (current?.reasoning_effort) setEffort(current.reasoning_effort);
	}, [provider, models]);

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
		document.documentElement.lang = getLocale() === "en" ? "en" : "zh-CN";
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

	// Branch label next to the folder icon. Best-effort: the sidebar still works
	// when git is missing or the directory is not a repository.
	useEffect(() => {
		if (!workingDir) return;
		let cancelled = false;
		void readBranch(workingDir)
			.then((name) => {
				if (!cancelled) setBranch(name);
			})
			.catch(() => {
				if (!cancelled) setBranch("");
			});
		return () => {
			cancelled = true;
		};
	}, [workingDir]);

	const currentSession = chat.sessionId
		? sessions.find((session) => session.id === chat.sessionId) ?? null
		: null;
	const projectName =
		project?.name || workingDir.split("/").filter(Boolean).pop() || "";
	const title = currentSession?.name || "NanoPi";

	useEffect(() => {
		titleRef.current = title;
	}, [title]);

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

	const onRenameSession = useCallback(
		async (session: SessionMetaWithProject, name: string) => {
			if (!projectHash) return;
			try {
				await renameSession(projectHash, session.id, name);
				await refreshSessions();
			} catch (cause) {
				setBootError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[projectHash, refreshSessions],
	);

	const onDeleteSession = useCallback(
		async (session: SessionMetaWithProject) => {
			if (!projectHash) return;
			try {
				await deleteSession(projectHash, session.id);
				if (chat.sessionId === session.id) chat.newSession();
				await refreshSessions();
			} catch (cause) {
				setBootError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[chat, projectHash, refreshSessions],
	);

	const onWorkspaceChange = useCallback(
		async (path: string) => {
			const result = await changeDir(path);
			if (!result.success) throw new Error(result.message || t("切换目录失败"));
			setProject({
				working_dir: result.current_dir,
				project_hash: result.project_hash,
				name: result.current_dir.split("/").filter(Boolean).pop() || "",
			});
			setSessions([]);
			chat.newSession();
		},
		[chat],
	);

	const toggleNotifications = useCallback(async () => {
		if (notifications) {
			setNotifications(false);
			try {
				localStorage.setItem("nanopi.notifications", "0");
			} catch {
				/* ignore */
			}
			return;
		}
		if (typeof Notification === "undefined") {
			setBootError(t("当前浏览器不支持通知"));
			return;
		}
		const permission = await Notification.requestPermission();
		if (permission !== "granted") {
			setBootError(t("通知权限被拒绝"));
			return;
		}
		setNotifications(true);
		try {
			localStorage.setItem("nanopi.notifications", "1");
		} catch {
			/* ignore */
		}
	}, [notifications]);

	const useSkill = useCallback((name: string) => {
		setComposer(`/${name} `);
		setSettingsOpen(false);
	}, []);

	const onOpenFile = useCallback((path: string) => {
		setTerminalOpen(false);
		setOpenFile(path);
		setNavOpen(false);
	}, []);

	const onOpenTerminal = useCallback(() => {
		setOpenFile(null);
		setTerminalOpen(true);
		setNavOpen(false);
	}, []);

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
					onRename={onRenameSession}
					onDelete={onDeleteSession}
					onOpenFile={onOpenFile}
					activeFile={openFile}
					branch={branch}
					onOpenTerminal={onOpenTerminal}
				/>
			</div>

			<main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
				<MobileBar title={title} onOpenMenu={() => setNavOpen(true)} onNew={onNew} />

				{bootError ? (
					<div className="mx-auto w-full max-w-[840px] px-4 pt-4">
						<div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
							{t("连接 nanopi webui 失败：")}{bootError}
						</div>
					</div>
				) : null}

				{terminalOpen ? (
					<TerminalPane cwd={workingDir} />
				) : openFile ? (
					<FileViewer path={openFile} onClose={() => setOpenFile(null)} />
				) : (
					<ChatPane
						messages={chat.messages}
						loading={chat.loading}
						streaming={chat.streaming}
						error={chat.error}
						notice={chat.notice}
						permission={chat.permission}
						userInput={chat.userInput}
						plan={chat.plan}
						models={usableModels}
						provider={provider}
						onProvider={setProvider}
						effort={effort}
						onEffort={(level) => void onChangeEffort(level)}
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
						modelSheetOpen={modelSheetOpen}
						onModelSheet={(open) => {
							if (open) void refreshProviders();
							setModelSheetOpen(open);
						}}
					/>
				)}
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
				{/* Scrim. Kept as its own full-bleed button (a 0.5-opacity surface
				    reads as decoration otherwise) so tapping the dimmed area always
				    dismisses, and `touch-action: manipulation` kills the double-tap
				    zoom delay that made the tap feel ignored on a phone. */}
				<button
					type="button"
					aria-label={t("关闭导航")}
					onClick={() => setNavOpen(false)}
					className={cn(
						"absolute inset-0 cursor-default touch-manipulation bg-black/50 transition-opacity duration-200",
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
						onRename={onRenameSession}
						onDelete={onDeleteSession}
						onOpenFile={onOpenFile}
						activeFile={openFile}
						branch={branch}
						onOpenTerminal={onOpenTerminal}
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
				config={config}
				onRefreshProviders={refreshProviders}
				onChangeDir={onWorkspaceChange}
				onUseSkill={useSkill}
				notifications={notifications}
				onToggleNotifications={toggleNotifications}
			/>
		</div>
	);
}
