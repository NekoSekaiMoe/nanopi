"use client";

import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	FileCode,
	FileText,
	Folder,
	FolderOpen,
	GitBranch,
	MessageCircle,
	MoreHorizontal,
	Pencil,
	Search,
	Settings,
	SquarePen,
	Terminal,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "@/components/icon-button";
import { type FsListResult, type SessionMetaWithProject, listDir } from "@/lib/api";
import { asMs, cn, relativeTime } from "@/lib/utils";
import { t } from "@/lib/i18n";

type SidebarView = "sessions" | "files" | "terminal";

/** A directory row that is expanded inline with its children. */
interface OpenDir {
	path: string;
	dirs: string[];
	files: string[];
}

const C_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "css", "py", "rs", "go", "sh"]);

function fileIcon(name: string): React.ReactNode {
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	if (C_EXTENSIONS.has(ext)) return <FileCode className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />;
	return <FileText className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />;
}

function joinPath(base: string, name: string): string {
	const trimmed = base.replace(/\/+$/, "");
	return `${trimmed}/${name}`;
}

function parentPath(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const index = trimmed.lastIndexOf("/");
	return index <= 0 ? "/" : trimmed.slice(0, index);
}

function dayGroup(timestamp: number): string {
	const date = new Date(asMs(timestamp));
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const value = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const days = Math.round((start - value) / 86_400_000);
	if (days <= 0) return t("今天");
	if (days === 1) return t("昨天");
	if (days < 7) return t("最近 7 天");
	return t("更早");
}

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
	onOpenFile,
	activeFile,
	branch,
	onOpenTerminal,
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
	onOpenFile: (path: string) => void;
	activeFile?: string | null;
	branch?: string;
	onOpenTerminal: () => void;
	mobile?: boolean;
}) {
	const [view, setView] = useState<SidebarView>("sessions");
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [dir, setDir] = useState(workingDir);
	const [listing, setListing] = useState<FsListResult | null>(null);
	const [filesError, setFilesError] = useState<string | null>(null);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [confirmingDelete, setConfirmingDelete] = useState<SessionMetaWithProject | null>(null);
	const [openDirs, setOpenDirs] = useState<OpenDir[]>([]);

	useEffect(() => {
		if (workingDir) setDir(workingDir);
		setOpenDirs([]);
	}, [workingDir]);

	const loadDir = (path: string, apply: (result: FsListResult) => void) => {
		setFilesError(null);
		void listDir(path)
			.then(apply)
			.catch((cause) => {
				setFilesError(cause instanceof Error ? cause.message : String(cause));
			});
	};

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

	// Inline expansion: a second click collapses, and switching directories
	// replaces the open set instead of accumulating stale listings.
	const toggleDir = (path: string) => {
		if (openDirs.some((entry) => entry.path === path)) {
			setOpenDirs((current) => current.filter((entry) => entry.path !== path));
			return;
		}
		loadDir(path, (result) => {
			setOpenDirs((current) => [...current, { path: result.path || path, dirs: result.dirs, files: result.files ?? [] }]);
		});
	};

	const filtered = useMemo(() => {
		const term = query.trim().toLowerCase();
		if (!term) return sessions;
		return sessions.filter((session) => session.name.toLowerCase().includes(term));
	}, [query, sessions]);

	const groups = useMemo(() => {
		const buckets = new Map<string, SessionMetaWithProject[]>();
		for (const session of filtered) {
			const label = dayGroup(session.updated_at);
			const list = buckets.get(label) ?? [];
			list.push(session);
			buckets.set(label, list);
		}
		return [...buckets.entries()];
	}, [filtered]);

	return (
		<aside
			className={cn(
				"relative flex h-full w-[268px] shrink-0 flex-col overflow-hidden bg-sidebar",
				mobile &&
					"w-[88vw] max-w-[360px] rounded-r-3xl pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
			)}
			style={{
				borderRight: mobile ? undefined : "var(--workspace-divider-width) solid var(--workspace-divider-color)",
			}}
		>
			{/* Workspace / branch switcher. No bottom divider: the header
			    blends into the nav below, and its own vertical padding keeps
			    the hover fill clear of the window's top edge (Memoh's
			    sidebar header). */}
			<header className="flex h-12 shrink-0 items-center pl-3 pr-2">
				<button
					type="button"
					onClick={onOpenSettings}
					title={workingDir || "NanoPi"}
					className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 pl-1.5 pr-1 text-left transition-colors hover:bg-sidebar-hover"
				>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-control font-medium text-sidebar-foreground">
							{projectName || t("本地工作区")}
						</span>
						<span className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground">
							<GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
							<span className="min-w-0 truncate">{branch || workingDir || "NanoPi"}</span>
						</span>
					</span>
					<ChevronDown className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
				</button>
			</header>

			<nav className="flex min-w-0 shrink-0 items-center gap-1 py-1.5 pl-3 pr-2">
				<NavTab
					active={view === "sessions"}
					label={t("对话")}
					icon={<MessageCircle className="size-[18px]" strokeWidth={1.75} />}
					onClick={() => setView("sessions")}
				/>
				<NavTab
					active={view === "files"}
					label={t("文件")}
					icon={<Folder className="size-[18px]" strokeWidth={1.75} />}
					onClick={() => setView("files")}
				/>
				<NavTab
					active={view === "terminal"}
					label={t("终端")}
					icon={<Terminal className="size-[18px]" strokeWidth={1.75} />}
					onClick={() => {
						setView("terminal");
						onOpenTerminal();
					}}
				/>
				<div className="flex-1" />
				<IconButton
					label={t("搜索会话")}
					active={searchOpen}
					onClick={() => {
						setView("sessions");
						setSearchOpen((open) => !open);
					}}
					className="size-8"
				>
					<Search className="size-[17px]" strokeWidth={1.7} />
				</IconButton>
				{mobile ? (
					<IconButton label={t("关闭导航")} onClick={onClose} className="size-8">
						<X className="size-[17px]" strokeWidth={1.7} />
					</IconButton>
				) : null}
			</nav>

			{/* Memoh's sessions panel leads with a section label, then the
			    action rows. Without the label the actions read as peers of the
			    nav tab above (both are medium-weight rows at the same x), which
			    is why the reference keeps that structural break.
			    Action rows share the sidebar icon column: px-2 container +
			    px-[11px] row + an 18px icon puts the glyph at x=19 and the
			    label at x=45, matching the nav tabs, session rows and files
			    tree. */}
			<div className="flex shrink-0 flex-col px-2 pt-2">
				<SidebarGroupLabel>{t("快捷操作")}</SidebarGroupLabel>
				<div className="flex flex-col pb-0.5">
					<SidebarAction
						label={t("新对话")}
						icon={<SquarePen className="size-[18px]" strokeWidth={1.75} />}
						onClick={onNew}
					/>
					<SidebarAction
						label={t("设置")}
						icon={<Settings className="size-[18px]" strokeWidth={1.75} />}
						onClick={onOpenSettings}
					/>
				</div>
			</div>

			{/* The panel: one label, one scrollport. The list dissolves into
			    the rail at the bottom instead of ending on a hard rule — the
			    nav above has no divider of its own, so a rule here reads
			    lopsided. */}
			<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
				<div className="flex min-w-0 shrink-0 flex-col px-2 pt-1">
					<SidebarGroupLabel>
						{view === "sessions" ? t("最近") : view === "files" ? t("文件") : t("终端")}
					</SidebarGroupLabel>
				</div>

				{searchOpen && view === "sessions" ? (
					<div className="shrink-0 px-2 pb-2">
						<input
							autoFocus
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("搜索会话")}
							className="h-9 w-full rounded-lg bg-overlay-hover-light px-3 text-control text-foreground outline-none placeholder:text-muted-foreground focus:bg-overlay-hover"
						/>
					</div>
				) : null}

				<div
					className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
					onClick={(event) => {
						// Clicking blank space in the list (never a row or control) collapses
						// the secondary view back to the session list.
						if (event.target !== event.currentTarget) return;
						setMenuFor(null);
						setSearchOpen(false);
						if (view !== "sessions") setView("sessions");
					}}
				>
					{view === "sessions" ? (
						groups.length === 0 ? (
							<p className="px-2 py-6 text-center text-label text-muted-foreground">
								{t("暂无会话")}
							</p>
						) : (
							<div className="space-y-1">
								{groups.map(([label, items]) => (
									<section key={label}>
										<SidebarGroupLabel>{label}</SidebarGroupLabel>
										<ul className="space-y-px">
											{items.map((session) => (
												<li key={session.id} className="relative">
													<div
														className={cn(
															"group flex min-h-[2.125rem] w-full items-center rounded-[9px] px-[11px] transition-colors",
															session.id === currentSessionId
																? "bg-sidebar-accent text-sidebar-foreground"
																: "text-sidebar-foreground/90 hover:bg-sidebar-hover",
														)}
													>
														{renaming === session.id ? (
															<input
																autoFocus
																value={renameValue}
																onChange={(event) => setRenameValue(event.target.value)}
																onClick={(event) => event.stopPropagation()}
																onKeyDown={(event) => {
																	event.stopPropagation();
																	if (event.key === "Enter") {
																		const name = renameValue.trim();
																		if (name) onRename(session, name);
																		setRenaming(null);
																	}
																	if (event.key === "Escape") setRenaming(null);
																}}
																className="mx-1 h-7 min-w-0 flex-1 rounded-lg bg-overlay-hover px-2 text-control text-foreground outline-none"
															/>
														) : (
															<button
																type="button"
																onClick={() => {
																	setRenaming(null);
																	onSelectSession(session);
																}}
																className="flex min-h-8 min-w-0 flex-1 items-center text-left"
															>
																<span className="min-w-0 flex-1 truncate text-control">
																	{session.name || t("新会话")}
																</span>
																<span className="shrink-0 pl-2 text-caption text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
																	{relativeTime(session.updated_at)}
																</span>
															</button>
														)}
														<button
															type="button"
															aria-label={t("会话操作")}
															title={t("会话操作")}
															onClick={(event) => {
																event.stopPropagation();
																setMenuFor(menuFor === session.id ? null : session.id);
															}}
															className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 transition-colors hover:bg-overlay-hover hover:text-foreground group-hover:opacity-100"
														>
															<MoreHorizontal className="size-3.5" />
														</button>
													</div>
													{menuFor === session.id ? (
														<>
															<button
																type="button"
																aria-label={t("关闭会话菜单")}
																onClick={() => setMenuFor(null)}
																className="fixed inset-0 z-10 cursor-default"
															/>
															<div className="absolute right-1 top-9 z-20 w-32 overflow-hidden rounded-xl border border-border-menu bg-popover p-1 shadow-xl">
																<button
																	type="button"
																	onClick={() => {
																		setMenuFor(null);
																		setRenaming(session.id);
																		setRenameValue(session.name || t("新会话"));
																	}}
																	className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-label text-foreground hover:bg-overlay-hover"
																>
																	<Pencil className="size-3.5 text-muted-foreground" />
																	{t("重命名")}
																</button>
																<button
																	type="button"
																	onClick={() => {
																		setMenuFor(null);
																		setConfirmingDelete(session);
																	}}
																	className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-label text-destructive hover:bg-destructive/12"
																>
																	<Trash2 className="size-3.5" />
																	{t("删除")}
																</button>
															</div>
														</>
													) : null}
												</li>
											))}
										</ul>
									</section>
								))}
							</div>
						)
					) : view === "terminal" ? (
						<div className="px-2 py-4">
							<p className="text-label text-muted-foreground">{t("终端已在右侧打开。")}</p>
							<p className="mt-1 text-caption text-muted-foreground">
								{t("命令只在本机执行，不进入对话上下文。")}
							</p>
						</div>
					) : (
						<div className="space-y-0.5">
							<div className="flex items-center gap-1 pb-1">
								<IconButton
									label={t("上一级")}
									disabled={!dir || dir === "/"}
									onClick={() => {
										setOpenDirs([]);
										setDir(parentPath(dir));
									}}
									className="size-7"
								>
									<ChevronLeft className="size-4" />
								</IconButton>
								<div className="min-w-0 flex-1 truncate text-label text-muted-foreground" title={dir}>
									{dir || workingDir}
								</div>
							</div>
							{filesError ? (
								<p className="px-2 py-4 text-label text-destructive">{filesError}</p>
							) : null}
							{listing === null && !filesError ? (
								<p className="px-2 py-4 text-label text-muted-foreground">{t("加载中…")}</p>
							) : null}
							{(listing?.dirs ?? []).map((name) => {
								const path = joinPath(listing?.path || dir, name);
								const open = openDirs.find((entry) => entry.path === path);
								return (
									<div key={`dir-${name}`}>
										<button
											type="button"
											onClick={() => toggleDir(path)}
											aria-expanded={Boolean(open)}
											className="flex h-9 w-full items-center gap-2 rounded-[9px] px-[11px] text-left text-control text-sidebar-foreground/90 transition-colors hover:bg-sidebar-hover"
										>
											{open ? (
												<FolderOpen className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />
											) : (
												<Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />
											)}
											<span className="min-w-0 flex-1 truncate">{name}</span>
											<ChevronRight
												className={cn(
													"size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
													open && "rotate-90",
												)}
											/>
										</button>
										{open ? (
											<div className="ml-[18px] space-y-px border-l border-sidebar-border pl-1">
												{open.dirs.map((child) => (
													<button
														key={`sub-${child}`}
														type="button"
														onClick={() => setDir(joinPath(path, child))}
														className="flex h-8 w-full items-center gap-2 rounded-lg px-[11px] text-left text-label text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-foreground"
													>
														<Folder className="size-3.5 shrink-0" strokeWidth={1.7} />
														<span className="min-w-0 flex-1 truncate">{child}</span>
													</button>
												))}
												{open.files.map((child) => {
													const childPath = joinPath(path, child);
													return (
														<button
															key={`sub-file-${child}`}
															type="button"
															onClick={() => onOpenFile(childPath)}
															className={cn(
																"flex h-8 w-full items-center gap-2 rounded-lg px-[11px] text-left text-label transition-colors",
																childPath === activeFile
																	? "bg-sidebar-accent text-sidebar-foreground"
																	: "text-sidebar-foreground/80 hover:bg-sidebar-hover hover:text-foreground",
															)}
														>
															{fileIcon(child)}
															<span className="min-w-0 flex-1 truncate">{child}</span>
														</button>
													);
												})}
												{open.dirs.length === 0 && open.files.length === 0 ? (
													<p className="px-2 py-1 text-caption text-muted-foreground">
														{t("空目录")}
													</p>
												) : null}
											</div>
										) : null}
									</div>
								);
							})}
							{(listing?.files ?? []).map((name) => {
								const path = joinPath(listing?.path || dir, name);
								return (
									<button
										key={`file-${name}`}
										type="button"
										onClick={() => onOpenFile(path)}
										className={cn(
											"flex h-9 w-full items-center gap-2 rounded-[9px] px-[11px] text-left text-control transition-colors",
											path === activeFile
												? "bg-sidebar-accent text-sidebar-foreground"
												: "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
										)}
									>
										{fileIcon(name)}
										<span className="min-w-0 flex-1 truncate">{name}</span>
									</button>
								);
							})}
						</div>
					)}
				</div>

				{/* Bottom fade: the list dissolves into the rail instead of
				    ending on a hard rule, so the panel reads as one surface
				    with no footer to sit under. */}
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-sidebar to-transparent" />
			</div>

			{confirmingDelete ? (
				<div className="absolute inset-0 z-50 flex items-end bg-black/50 p-3">
					<div className="w-full rounded-2xl bg-card p-3">
						<p className="text-control font-medium text-foreground">{t("删除会话？")}</p>
						<p className="mt-1 text-label text-muted-foreground">
							{confirmingDelete.name || t("新会话")} 将从本机移除，无法撤销。
						</p>
						<div className="mt-3 flex justify-end gap-1.5">
							<button
								type="button"
								onClick={() => setConfirmingDelete(null)}
								className="h-8 rounded-full px-3 text-label text-muted-foreground hover:bg-overlay-hover hover:text-foreground"
							>
								{t("取消")}
							</button>
							<button
								type="button"
								onClick={() => {
									onDelete(confirmingDelete);
									setConfirmingDelete(null);
								}}
								className="h-8 rounded-full bg-destructive px-3 text-label font-medium text-destructive-foreground"
							>
								{t("删除")}
							</button>
						</div>
					</div>
				</div>
			) : null}
		</aside>
	);
}

/**
 * Section label. Memoh's panel-header.vue owns the label type once —
 * text-xs font-[550] tracking-[-0.02em] at muted-foreground/80 — so the
 * "Quick actions" and "Recent" labels can't drift apart, and every one of
 * them shares the panel's 11px label column.
 */
function SidebarGroupLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex h-[26px] shrink-0 select-none items-center pl-[11px] pr-0.5">
			<span className="min-w-0 flex-1 truncate text-xs font-[550] tracking-[-0.02em] text-muted-foreground/80">
				{children}
			</span>
		</div>
	);
}

/**
 * Sidebar action row. Container px-2 + row px-[11px] + an 18px icon puts the
 * glyph at x=19 and the label at x=45, so icons line up vertically across the
 * nav tabs, these actions and the session rows.
 */
function SidebarAction({
	label,
	icon,
	onClick,
}: {
	label: string;
	icon: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex h-9 w-full items-center gap-[9px] rounded-lg px-[11px] text-left text-control font-medium text-sidebar-foreground/90 transition-colors select-none hover:bg-sidebar-hover hover:text-foreground"
		>
			<span className="shrink-0 text-muted-foreground">{icon}</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}

/**
 * Icon tab. Anchored on the ICON: the glyph never moves between states —
 * hovering an inactive tab shows a circle centered on the icon, activating it
 * grows the pill to the right (label) and bleeds 3px left so ml+pl stays
 * constant.
 */
function NavTab({
	active,
	label,
	icon,
	onClick,
}: {
	active?: boolean;
	label: string;
	icon: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			aria-label={label}
			title={label}
			className={cn(
				"inline-flex h-8 min-w-0 shrink-0 cursor-pointer items-center justify-start rounded-full px-2 text-muted-foreground outline-none",
				"transition-[margin,padding,color,background-color] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
				"hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				active && "-ml-[3px] bg-sidebar-accent pl-2.5 pr-3.5 text-sidebar-foreground/90",
			)}
		>
			<span className="relative shrink-0">{icon}</span>
			<span
				className={cn(
					"grid min-w-0 transition-[grid-template-columns] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
					active ? "grid-cols-[1fr]" : "grid-cols-[0fr]",
				)}
			>
				<span className="min-w-0 overflow-hidden">
					<span className="block whitespace-nowrap pl-2 text-control font-[550]">{label}</span>
				</span>
			</span>
		</button>
	);
}
