"use client";

import {
	ChevronLeft,
	File,
	Folder,
	MessageCircle,
	Plus,
	Search,
	Settings,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "@/components/icon-button";
import { Logo } from "@/components/logo";
import { type FsListResult, type SessionMetaWithProject, listDir } from "@/lib/api";
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
	mobile?: boolean;
}) {
	const [view, setView] = useState<SidebarView>("sessions");
	const [searchOpen, setSearchOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [dir, setDir] = useState(workingDir);
	const [listing, setListing] = useState<FsListResult | null>(null);
	const [filesError, setFilesError] = useState<string | null>(null);

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
				"flex h-full w-[256px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar",
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
											<li key={session.id}>
												<button
													type="button"
													onClick={() => onSelectSession(session)}
													className={cn(
														"group flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors md:h-9",
														session.id === currentSessionId
															? "bg-sidebar-accent text-foreground"
															: "text-foreground/85 hover:bg-sidebar-accent",
													)}
												>
													<span className="min-w-0 flex-1 truncate text-[13px]">
														{session.name || "新会话"}
													</span>
													<span className="shrink-0 text-[10.5px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
														{relativeTime(session.updated_at)}
													</span>
												</button>
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
							<div
								key={`file-${name}`}
								className="flex h-8 items-center gap-2 rounded-lg px-2 text-[12.5px] text-muted-foreground"
							>
								<File className="size-4 shrink-0" strokeWidth={1.75} />
								<span className="min-w-0 flex-1 truncate">{name}</span>
							</div>
						))}
					</div>
				)}
			</div>

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
