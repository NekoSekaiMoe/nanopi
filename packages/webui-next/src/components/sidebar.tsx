"use client";

import {
	ChevronLeft,
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
import { Logo } from "@/components/logo";
import {
	type FsListResult,
	type SessionMetaWithProject,
	listDir,
	openWorkspaceFile,
} from "@/lib/api";
import { asMs, cn, relativeTime } from "@/lib/utils";

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
	if (days <= 0) return "今天";
	if (days === 1) return "昨天";
	if (days < 7) return "最近 7 天";
	return "更早";
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

	return (
		<aside
			className={cn(
				"relative flex h-full w-[256px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar",
				mobile && "w-[86vw] max-w-[340px] border-r-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
			)}
		>
			<header className="flex h-11 shrink-0 items-center gap-2 pl-3 pr-2">
				<Logo size={26} />
				<div className="min-w-0 flex-1">
					<div className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">
						NanoPi
					</div>
					<div className="truncate text-[10.5px] leading-3 text-muted-foreground">
						{projectName || "本地工作区"}
					</div>
				</div>
				{mobile ? (
					<IconButton label="关闭导航" onClick={onClose}>
						<X className="size-[18px]" strokeWidth={1.75} />
					</IconButton>
				) : (
					<IconButton label="新建会话" onClick={onNew}>
						<Plus className="size-[18px]" strokeWidth={1.75} />
					</IconButton>
				)}
			</header>

			<nav className="flex shrink-0 items-center gap-1 py-1.5 pl-3 pr-2">
				<NavPill
					active={view === "sessions"}
					label="会话"
					icon={<MessageCircle className="size-[18px]" strokeWidth={1.75} />}
					onClick={() => setView("sessions")}
				/>
				<NavPill
					active={view === "files"}
					label="文件"
					icon={<Folder className="size-[18px]" strokeWidth={1.75} />}
					onClick={() => setView("files")}
				/>
				<div className="flex-1" />
				<IconButton
					label="搜索会话"
					active={searchOpen}
					onClick={() => {
						setView("sessions");
						setSearchOpen((open) => !open);
					}}
				>
					<Search className="size-[18px]" strokeWidth={1.75} />
				</IconButton>
			</nav>

			{searchOpen && view === "sessions" ? (
				<div className="shrink-0 px-3 pb-2">
					<input
						autoFocus
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="搜索会话"
						className="h-8 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/25"
					/>
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				{view === "sessions" ? (
					<div className="space-y-4">
						<button
							type="button"
							onClick={onNew}
							className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-medium md:h-9 text-foreground transition-colors hover:bg-sidebar-accent"
						>
							<Plus className="size-4 text-muted-foreground" strokeWidth={2} />
							新建会话
						</button>
						{groups.length === 0 ? (
							<p className="px-2 py-6 text-center text-[12px] text-muted-foreground">
								暂无会话
							</p>
						) : (
							groups.map(([label, items]) => (
								<section key={label}>
									<h2 className="px-2 pb-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
										{label}
									</h2>
									<ul className="space-y-px">
										{items.map((session) => (
											<li key={session.id} className="relative">
												<div
													className={cn(
														"group flex h-10 w-full items-center gap-1 rounded-lg pr-1 transition-colors md:h-9",
														session.id === currentSessionId
															? "bg-sidebar-accent text-foreground"
															: "text-foreground/85 hover:bg-sidebar-accent",
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
																	className="mx-1 h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[12.5px] text-foreground outline-none focus:border-foreground/30"
														/>
													) : (
														<button
															type="button"
															onClick={() => {
																setRenaming(null);
																onSelectSession(session);
															}}
															className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 text-left"
														>
															<span className="min-w-0 flex-1 truncate text-[13px]">
																{session.name || "新会话"}
															</span>
															<span className="shrink-0 pr-1 text-[10.5px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
																{relativeTime(session.updated_at)}
															</span>
														</button>
													)}
													<button
														type="button"
														aria-label="会话操作"
														title="会话操作"
														onClick={(event) => {
															event.stopPropagation();
															setMenuFor(menuFor === session.id ? null : session.id);
														}}
														className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background/60 hover:text-foreground group-hover:opacity-100"
													>
														<MoreHorizontal className="size-3.5" />
													</button>
												</div>
												{menuFor === session.id ? (
													<>
														<button
															type="button"
															aria-label="关闭会话菜单"
															onClick={() => setMenuFor(null)}
															className="fixed inset-0 z-10 cursor-default"
														/>
														<div className="absolute right-1 top-9 z-20 w-32 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-md">
														<button
															type="button"
															onClick={() => {
																setMenuFor(null);
																setRenaming(session.id);
																setRenameValue(session.name || "新会话");
															}}
															className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-foreground hover:bg-accent"
														>
															<Pencil className="size-3.5 text-muted-foreground" />
															重命名
														</button>
														<button
															type="button"
															onClick={() => {
																setMenuFor(null);
																setConfirmingDelete(session);
															}}
															className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-destructive hover:bg-destructive/10"
														>
															<Trash2 className="size-3.5" />
															删除
														</button>
														</div>
													</>
												) : null}
											</li>
										))}
									</ul>
								</section>
							))
						)}
					</div>
				) : (
					<div className="space-y-1">
						<div className="flex items-center gap-1 px-1 pb-1">
							<IconButton
								label="上一级"
								disabled={!dir || dir === "/"}
								onClick={() => setDir(parentPath(dir))}
							>
								<ChevronLeft className="size-4" />
							</IconButton>
							<div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={dir}>
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
								className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-foreground/85 transition-colors hover:bg-sidebar-accent"
							>
								<Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
								<span className="min-w-0 flex-1 truncate">{name}</span>
							</button>
						))}
						{(listing?.files ?? []).map((name) => (
							<button
								key={`file-${name}`}
								type="button"
								title="在编辑器中打开"
								onClick={() => {
									setFilesError(null);
									void openWorkspaceFile(
										joinPath(listing?.path || dir, name),
										currentSessionId ?? undefined,
									).catch((cause) => {
										setFilesError(cause instanceof Error ? cause.message : String(cause));
									});
								}}
								className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
							>
								<File className="size-4 shrink-0" strokeWidth={1.75} />
								<span className="min-w-0 flex-1 truncate">{name}</span>
							</button>
						))}
					</div>
				)}
			</div>

			{confirmingDelete ? (
				<div className="absolute inset-0 z-50 flex items-end bg-black/30 p-3">
					<div className="w-full rounded-xl border border-border bg-card p-3 shadow-lg">
						<p className="text-[12.5px] font-medium text-foreground">删除会话？</p>
						<p className="mt-1 text-[11.5px] text-muted-foreground">
							{confirmingDelete.name || "新会话"} 将从本机移除，无法撤销。
						</p>
						<div className="mt-3 flex justify-end gap-1.5">
							<button
								type="button"
								onClick={() => setConfirmingDelete(null)}
								className="h-8 rounded-lg px-2.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								取消
							</button>
							<button
								type="button"
								onClick={() => {
									onDelete(confirmingDelete);
									setConfirmingDelete(null);
								}}
								className="h-8 rounded-lg bg-destructive px-3 text-[12px] font-medium text-white"
							>
								删除
							</button>
						</div>
					</div>
				</div>
			) : null}

			<footer className="shrink-0 border-t border-sidebar-border p-2">
				<button
					type="button"
					onClick={onOpenSettings}
					className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-foreground/85 transition-colors hover:bg-sidebar-accent md:h-9"
				>
					<Settings className="size-4 text-muted-foreground" strokeWidth={1.75} />
					<span className="flex-1">设置</span>
				</button>
			</footer>
		</aside>
	);
}

function NavPill({
	active,
	label,
	icon,
	onClick,
}: {
	active: boolean;
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
				"inline-flex h-8 items-center rounded-full text-[13px] transition-colors",
				active
					? "gap-1.5 bg-sidebar-accent px-2.5 font-medium text-foreground"
					: "w-8 justify-center text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
			)}
		>
			{icon}
			{active ? <span className="pl-0.5">{label}</span> : null}
		</button>
	);
}
