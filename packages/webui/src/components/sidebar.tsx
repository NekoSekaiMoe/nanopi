"use client";

import {
	Calendar,
	ChevronDown,
	ChevronRight,
	FileText,
	Folder,
	Lightbulb,
	MessageSquare,
	MoreHorizontal,
	Plus,
	Sliders,
	SquarePen,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	type FsListResult,
	type SessionMetaWithProject,
	listDir,
	openWorkspaceFile,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

type SidebarView = "sessions" | "files" | "calendar";

export function Sidebar({
	sessions,
	currentSessionId,
	projectName,
	workingDir,
	onSelectSession,
	onNew,
	onOpenSettings,
	onClose,
	onRename,
	onDelete,
	mobile,
}: {
	sessions: SessionMetaWithProject[];
	currentSessionId: string | null;
	projectName: string;
	workingDir: string;
	onSelectSession: (session: SessionMetaWithProject) => void;
	onNew: () => void;
	onOpenSettings: () => void;
	onClose?: () => void;
	onRename: (session: SessionMetaWithProject, name: string) => void;
	onDelete: (session: SessionMetaWithProject) => void;
	mobile?: boolean;
}) {
	const [view, setView] = useState<SidebarView>("sessions");
	const [foldersOpen, setFoldersOpen] = useState(false);
	const [recentOpen, setRecentOpen] = useState(true);
	const [dir, setDir] = useState(workingDir);
	const [listing, setListing] = useState<FsListResult | null>(null);
	const [filesError, setFilesError] = useState<string | null>(null);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	useEffect(() => {
		if (workingDir) setDir(workingDir);
	}, [workingDir]);

	useEffect(() => {
		if (view !== "files" || !dir) return;
		let cancelled = false;
		setFilesError(null);
		void listDir(dir)
			.then((result) => {
				if (!cancelled) setListing(result);
			})
			.catch((cause) => {
				if (!cancelled) setFilesError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [dir, view]);

	const initial = (projectName.trim()[0] || "T").toUpperCase();
	const displayName = projectName || "test";

	return (
		<aside
			className={cn(
				"relative flex h-full w-[280px] shrink-0 flex-col overflow-hidden bg-[#111113] text-foreground",
				mobile && "w-[82vw] max-w-[320px] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
			)}
		>
			{/* Header matching Screenshot 2: Avatar with 'T', name 'test', right '+' */}
			<header className="flex h-14 shrink-0 items-center justify-between px-4 pt-1">
				<div className="flex items-center gap-3 min-w-0">
					<div className="grid size-8 shrink-0 place-items-center rounded-full bg-[#27272a] text-[14px] font-medium text-foreground">
						{initial}
					</div>
					<span className="truncate text-[16px] font-medium text-foreground">
						{displayName}
					</span>
				</div>
				<button
					type="button"
					aria-label={t("新对话")}
					onClick={onNew}
					className="grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
				>
					<Plus className="size-5" strokeWidth={1.75} />
				</button>
			</header>

			{/* Main Nav: 对话, 文件, 日程 */}
			<div className="shrink-0 space-y-0.5 px-3 pt-2">
				<button
					type="button"
					onClick={() => setView("sessions")}
					className={cn(
						"flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] transition-colors",
						view === "sessions"
							? "bg-[#242428] font-medium text-foreground"
							: "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
					)}
				>
					<MessageSquare className="size-5 shrink-0" strokeWidth={1.75} />
					<span>{t("对话")}</span>
				</button>
				<button
					type="button"
					onClick={() => setView("files")}
					className={cn(
						"flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] transition-colors",
						view === "files"
							? "bg-[#242428] font-medium text-foreground"
							: "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
					)}
				>
					<FileText className="size-5 shrink-0" strokeWidth={1.75} />
					<span>{t("文件")}</span>
				</button>
				<button
					type="button"
					onClick={() => setView("calendar")}
					className={cn(
						"flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] transition-colors",
						view === "calendar"
							? "bg-[#242428] font-medium text-foreground"
							: "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
					)}
				>
					<Calendar className="size-5 shrink-0" strokeWidth={1.75} />
					<span>{t("日程")}</span>
				</button>
			</div>

			{/* 快捷操作 */}
			<div className="shrink-0 px-3 pt-5">
				<p className="px-3 pb-1.5 text-[12px] text-muted-foreground/60">{t("快捷操作")}</p>
				<div className="space-y-0.5">
					<button
						type="button"
						onClick={onNew}
						className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
					>
						<SquarePen className="size-5 shrink-0" strokeWidth={1.75} />
						<span>{t("新对话")}</span>
					</button>
					<button
						type="button"
						onClick={onOpenSettings}
						className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
					>
						<Sliders className="size-5 shrink-0" strokeWidth={1.75} />
						<span>{t("Bot 设置")}</span>
					</button>
				</div>
			</div>

			{/* 文件夹 > 与 + */}
			<div className="shrink-0 px-3 pt-4">
				<div className="flex h-9 items-center justify-between px-3">
					<button
						type="button"
						onClick={() => setFoldersOpen((v) => !v)}
						className="flex items-center gap-1 text-[13px] text-muted-foreground/80 hover:text-foreground"
					>
						<span>{t("文件夹")}</span>
						<ChevronRight
							className={cn("size-3.5 transition-transform duration-150", foldersOpen && "rotate-90")}
						/>
					</button>
					<button
						type="button"
						aria-label={t("新建文件夹")}
						onClick={() => setFoldersOpen(true)}
						className="grid size-6 place-items-center rounded text-muted-foreground/70 hover:text-foreground"
					>
						<Plus className="size-4" />
					</button>
				</div>
				{foldersOpen ? (
					<div className="px-3 py-1 text-[12px] text-muted-foreground/60">
						{t("暂无文件夹")}
					</div>
				) : null}
			</div>

			{/* 最近 ∨ 与 + */}
			<div className="flex min-h-0 flex-1 flex-col px-3 pt-3">
				<div className="flex h-9 shrink-0 items-center justify-between px-3">
					<button
						type="button"
						onClick={() => setRecentOpen((v) => !v)}
						className="flex items-center gap-1 text-[13px] text-muted-foreground/80 hover:text-foreground"
					>
						<span>{t("最近")}</span>
						<ChevronDown
							className={cn("size-3.5 transition-transform duration-150", !recentOpen && "-rotate-90")}
						/>
					</button>
					<button
						type="button"
						aria-label={t("新建会话")}
						onClick={onNew}
						className="grid size-6 place-items-center rounded text-muted-foreground/70 hover:text-foreground"
					>
						<Plus className="size-4" />
					</button>
				</div>

				{/* Sessions list */}
				<div className="min-h-0 flex-1 overflow-y-auto pt-1">
					{recentOpen ? (
						view === "files" ? (
							<FilesView
								dir={dir}
								listing={listing}
								error={filesError}
								sessionId={currentSessionId}
								onCd={(next) => setDir(next)}
							/>
						) : sessions.length === 0 ? (
							<p className="px-3 py-4 text-[12.5px] text-muted-foreground/60">
								{t("暂无会话")}
							</p>
						) : (
							<ul className="space-y-1">
								{sessions.map((session) => (
									<li key={session.id} className="relative">
										<div
											className={cn(
												"group flex h-10 w-full items-center gap-1 rounded-xl px-2 transition-colors",
												session.id === currentSessionId
													? "bg-[#242428] text-foreground font-medium"
													: "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
											)}
										>
											{renaming === session.id ? (
												<input
													autoFocus
													value={renameValue}
													onChange={(e) => setRenameValue(e.target.value)}
													onKeyDown={(e) => {
														if (e.key === "Enter") {
															const val = renameValue.trim();
															if (val) onRename(session, val);
															setRenaming(null);
														}
														if (e.key === "Escape") setRenaming(null);
													}}
													className="h-7 w-full rounded bg-white/[0.1] px-2 text-[13px] text-foreground outline-none"
												/>
											) : (
												<button
													type="button"
													onClick={() => onSelectSession(session)}
													className="flex h-full min-w-0 flex-1 items-center truncate text-left text-[14px]"
												>
													<span className="truncate">{session.name || t("新会话")}</span>
												</button>
											)}

											<button
												type="button"
												aria-label={t("更多")}
												onClick={(e) => {
													e.stopPropagation();
													setMenuFor(menuFor === session.id ? null : session.id);
												}}
												className="grid size-7 shrink-0 place-items-center rounded-lg opacity-0 transition-opacity hover:bg-white/[0.08] group-hover:opacity-100"
											>
												<MoreHorizontal className="size-4" />
											</button>
										</div>

										{/* Session menu popup */}
										{menuFor === session.id ? (
											<>
												<button
													type="button"
													aria-label="close"
													onClick={() => setMenuFor(null)}
													className="fixed inset-0 z-20 cursor-default"
												/>
												<div className="absolute right-2 top-full z-30 min-w-[120px] rounded-xl border border-white/[0.1] bg-[#1a1a1d] p-1 shadow-lg text-[13px]">
													<button
														type="button"
														onClick={() => {
															setRenameValue(session.name);
															setRenaming(session.id);
															setMenuFor(null);
														}}
														className="flex h-8 w-full items-center px-2 rounded-lg hover:bg-white/[0.06]"
													>
														{t("重命名")}
													</button>
													<button
														type="button"
														onClick={() => {
															onDelete(session);
															setMenuFor(null);
														}}
														className="flex h-8 w-full items-center px-2 rounded-lg text-destructive hover:bg-white/[0.06]"
													>
														{t("删除")}
													</button>
												</div>
											</>
										) : null}
									</li>
								))}
							</ul>
						)
					) : null}
				</div>
			</div>

			{/* Bottom section matching Screenshot 2 */}
			<footer className="shrink-0 border-t border-white/[0.05] p-3 space-y-2">
				{/* 看看 Memoh 能做什么 */}
				<button
					type="button"
					onClick={onOpenSettings}
					className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[13.5px] text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
				>
					<Lightbulb className="size-4 shrink-0 text-amber-400/90" />
					<span className="truncate">{t("看看 Memoh 能做什么")}</span>
				</button>

				{/* User Profile row: Avatar & Ayayoku Togetsu */}
				<div className="flex h-11 w-full items-center gap-3 rounded-xl px-2.5">
					<div className="size-8 shrink-0 overflow-hidden rounded-full border border-white/[0.1] bg-purple-900/40">
						<img
							src="/favicon.png"
							alt="User Avatar"
							className="size-full object-cover"
							onError={(e) => {
								(e.target as HTMLImageElement).src = "/icon-192.png";
							}}
						/>
					</div>
					<div className="min-w-0 flex-1 truncate">
						<span className="block truncate text-[14px] font-medium text-foreground">
							Ayayoku Togetsu
						</span>
					</div>
				</div>
			</footer>
		</aside>
	);
}

function FilesView({
	dir,
	listing,
	error,
	sessionId,
	onCd,
}: {
	dir: string;
	listing: FsListResult | null;
	error: string | null;
	sessionId: string | null;
	onCd: (path: string) => void;
}) {
	if (error) {
		return <p className="p-3 text-[12px] text-destructive">{error}</p>;
	}
	if (!listing) {
		return <p className="p-3 text-[12px] text-muted-foreground/60">{t("加载中…")}</p>;
	}
	return (
		<div className="space-y-0.5 text-[13px]">
			<div className="truncate px-2 py-1 font-mono text-[11px] text-muted-foreground">
				{dir}
			</div>
			{listing.dirs.map((name) => (
				<button
					key={name}
					type="button"
					onClick={() => onCd(`${dir.replace(/\/+$/, "")}/${name}`)}
					className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
				>
					<Folder className="size-4 shrink-0 text-muted-foreground/70" />
					<span className="truncate">{name}</span>
				</button>
			))}
			{(listing.files ?? []).map((name) => (
				<button
					key={name}
					type="button"
					onClick={() => {
						const path = `${dir.replace(/\/+$/, "")}/${name}`;
						void openWorkspaceFile(path, sessionId ?? undefined);
					}}
					className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
				>
					<FileText className="size-4 shrink-0 text-muted-foreground/50" />
					<span className="truncate">{name}</span>
				</button>
			))}
		</div>
	);
}
