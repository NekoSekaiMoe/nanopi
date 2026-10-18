"use client";

import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	File,
	Folder,
	MessageCircle,
	MoreHorizontal,
	Pencil,
	Plus,
	Search,
	Settings,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "@/components/icon-button";
import {
	type FsListResult,
	type SessionMetaWithProject,
	listDir,
	openWorkspaceFile,
} from "@/lib/api";
import { asMs, cn, relativeTime } from "@/lib/utils";
import { t } from "@/lib/i18n";

type SidebarView = "sessions" | "files";

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
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [dir, setDir] = useState(workingDir);
	const [listing, setListing] = useState<FsListResult | null>(null);
	const [filesError, setFilesError] = useState<string | null>(null);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [confirmingDelete, setConfirmingDelete] = useState<SessionMetaWithProject | null>(null);

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

	const initial = (projectName.trim()[0] || "N").toUpperCase();

	return (
		<aside
			className={cn(
				"relative flex h-full w-[268px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar",
				mobile &&
					"w-[88vw] max-w-[360px] rounded-r-3xl border-r-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
			)}
		>
			<header className="shrink-0 p-3">
				<button
					type="button"
					onClick={onOpenSettings}
					className="flex h-12 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-sidebar-accent"
				>
					<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/[0.08] text-[12px] font-medium text-foreground">
						{initial}
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[14px] font-medium text-foreground">
							{projectName || t("本地工作区")}
						</span>
						<span className="block truncate text-[11px] text-muted-foreground">
							{workingDir || "NanoPi"}
						</span>
					</span>
					<ChevronDown className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
				</button>
			</header>

			<div className="shrink-0 space-y-0.5 px-3">
				<NavRow
					active={view === "sessions"}
					label={t("对话")}
					icon={<MessageCircle className="size-[19px]" strokeWidth={1.7} />}
					onClick={() => setView("sessions")}
				/>
				<NavRow
					active={view === "files"}
					label={t("文件")}
					icon={<Folder className="size-[19px]" strokeWidth={1.7} />}
					onClick={() => setView("files")}
				/>
			</div>

			<div className="shrink-0 px-3 pt-5">
				<p className="px-2 pb-1 text-[12px] text-muted-foreground/70">{t("快捷操作")}</p>
				<div className="space-y-0.5">
					<NavRow
						label={t("新对话")}
						icon={<Plus className="size-[19px]" strokeWidth={1.7} />}
						onClick={onNew}
					/>
					<NavRow
						label={t("设置")}
						icon={<Settings className="size-[19px]" strokeWidth={1.7} />}
						onClick={onOpenSettings}
					/>
				</div>
			</div>

			<div className="mt-5 flex min-h-0 flex-1 flex-col px-3">
				<div className="flex h-8 shrink-0 items-center justify-between pl-2 pr-0.5">
					<span className="text-[12px] text-muted-foreground/70">{t("最近")}</span>
					<div className="flex items-center">
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
					</div>
				</div>

				{searchOpen && view === "sessions" ? (
					<div className="shrink-0 pb-2">
						<input
							autoFocus
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("搜索会话")}
							className="h-9 w-full rounded-xl bg-white/[0.05] px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:bg-white/[0.07]"
						/>
					</div>
				) : null}

				<div className="min-h-0 flex-1 overflow-y-auto pb-2">
					{view === "sessions" ? (
						groups.length === 0 ? (
							<p className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">
								{t("暂无会话")}
							</p>
						) : (
							<div className="space-y-4">
								{groups.map(([label, items]) => (
									<section key={label}>
										<h2 className="px-2 pb-1 text-[11px] text-muted-foreground/60">{label}</h2>
										<ul className="space-y-px">
											{items.map((session) => (
												<li key={session.id} className="relative">
													<div
														className={cn(
															"group flex h-10 w-full items-center gap-1 rounded-xl pr-1 transition-colors",
															session.id === currentSessionId
																? "bg-sidebar-accent text-foreground"
																: "text-foreground/80 hover:bg-sidebar-accent",
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
																className="mx-1 h-7 min-w-0 flex-1 rounded-lg bg-white/[0.06] px-2 text-[13px] text-foreground outline-none focus:bg-white/[0.09]"
															/>
														) : (
															<button
																type="button"
																onClick={() => {
																	setRenaming(null);
																	onSelectSession(session);
																}}
																className="flex h-full min-w-0 flex-1 items-center rounded-xl pl-2.5 text-left"
															>
																<span className="min-w-0 flex-1 truncate text-[13.5px]">
																	{session.name || t("新会话")}
																</span>
																<span className="shrink-0 pr-1 text-[10.5px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
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
															className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-white/[0.06] hover:text-foreground group-hover:opacity-100"
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
															<div className="absolute right-1 top-9 z-20 w-32 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
																<button
																	type="button"
																	onClick={() => {
																		setMenuFor(null);
																		setRenaming(session.id);
																		setRenameValue(session.name || t("新会话"));
																	}}
																	className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-foreground hover:bg-accent"
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
																	className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-destructive hover:bg-destructive/10"
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
					) : (
						<div className="space-y-0.5">
							<div className="flex items-center gap-1 pb-1">
								<IconButton
									label={t("上一级")}
									disabled={!dir || dir === "/"}
									onClick={() => setDir(parentPath(dir))}
									className="size-7"
								>
									<ChevronLeft className="size-4" />
								</IconButton>
								<div className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground" title={dir}>
									{dir || workingDir}
								</div>
							</div>
							{filesError ? (
								<p className="px-2 py-4 text-[12px] text-destructive">{filesError}</p>
							) : null}
							{(listing?.dirs ?? []).map((name) => (
								<button
									key={`dir-${name}`}
									type="button"
									onClick={() => setDir(joinPath(listing?.path || dir, name))}
									className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-[13.5px] text-foreground/85 transition-colors hover:bg-sidebar-accent"
								>
									<Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />
									<span className="min-w-0 flex-1 truncate">{name}</span>
									<ChevronRight className="size-3.5 text-muted-foreground/50" />
								</button>
							))}
							{(listing?.files ?? []).map((name) => (
								<button
									key={`file-${name}`}
									type="button"
									title={t("在编辑器中打开")}
									onClick={() => {
										setFilesError(null);
										void openWorkspaceFile(
											joinPath(listing?.path || dir, name),
											currentSessionId ?? undefined,
										).catch((cause) => {
											setFilesError(cause instanceof Error ? cause.message : String(cause));
										});
									}}
									className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
								>
									<File className="size-4 shrink-0" strokeWidth={1.7} />
									<span className="min-w-0 flex-1 truncate">{name}</span>
								</button>
							))}
						</div>
					)}
				</div>
			</div>

			{confirmingDelete ? (
				<div className="absolute inset-0 z-50 flex items-end bg-black/50 p-3">
					<div className="w-full rounded-2xl bg-card p-3">
						<p className="text-[13px] font-medium text-foreground">{t("删除会话？")}</p>
						<p className="mt-1 text-[12px] text-muted-foreground">
							{confirmingDelete.name || t("新会话")} 将从本机移除，无法撤销。
						</p>
						<div className="mt-3 flex justify-end gap-1.5">
							<button
								type="button"
								onClick={() => setConfirmingDelete(null)}
								className="h-8 rounded-full px-3 text-[12.5px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
							>
								{t("取消")}
							</button>
							<button
								type="button"
								onClick={() => {
									onDelete(confirmingDelete);
									setConfirmingDelete(null);
								}}
								className="h-8 rounded-full bg-destructive px-3 text-[12.5px] font-medium text-white"
							>
								{t("删除")}
							</button>
						</div>
					</div>
				</div>
			) : null}

			<footer className="shrink-0 p-3">
				<div className="flex h-12 items-center gap-2.5 rounded-xl px-2">
					<span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.08] text-[12px] font-medium text-foreground">
						N
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[13.5px] text-foreground">NanoPi</span>
						<span className="block truncate text-[11px] text-muted-foreground">
							{workingDir ? workingDir.split("/").filter(Boolean).pop() : t("本地工作区")}
						</span>
					</span>
				</div>
			</footer>
		</aside>
	);
}

function NavRow({
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
			className={cn(
				"flex h-11 w-full items-center gap-3 rounded-xl px-2.5 text-left text-[14.5px] transition-colors",
				active
					? "bg-sidebar-accent font-medium text-foreground"
					: "text-foreground/80 hover:bg-sidebar-accent hover:text-foreground",
			)}
		>
			<span className={cn("shrink-0", active ? "text-foreground" : "text-muted-foreground")}>{icon}</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}
