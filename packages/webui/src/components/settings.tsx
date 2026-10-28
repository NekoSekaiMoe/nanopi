"use client";

import { ArrowLeft, ChevronRight, Cpu, Info, Monitor, Moon, Network, Palette, Sparkles, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getMcpStatus, getSkills, type ConfigInfo, type McpStatusInfo, type ModelInfo, type ProjectState, type SkillInfo } from "@/lib/api";
import { ProviderSettings } from "@/components/provider-settings";
import { cn } from "@/lib/utils";
import { getLocale, setLocale, t } from "@/lib/i18n";

type Section = "appearance" | "models" | "skills" | "mcp" | "workspace" | "about";
export type ThemeChoice = "system" | "light" | "dark";

const SECTIONS: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
	{ id: "appearance", label: t("外观"), icon: <Palette className="size-4" strokeWidth={1.75} /> },
	{ id: "models", label: t("模型"), icon: <Cpu className="size-4" strokeWidth={1.75} /> },
	{ id: "skills", label: t("技能"), icon: <Sparkles className="size-4" strokeWidth={1.75} /> },
	{ id: "mcp", label: "MCP", icon: <Network className="size-4" strokeWidth={1.75} /> },
	{ id: "workspace", label: t("工作区"), icon: <Monitor className="size-4" strokeWidth={1.75} /> },
	{ id: "about", label: t("关于"), icon: <Info className="size-4" strokeWidth={1.75} /> },
];

export function SettingsOverlay({
	open,
	onClose,
	theme,
	onTheme,
	models,
	provider,
	onProvider,
	project,
	config,
	onRefreshProviders,
	onChangeDir,
	onUseSkill,
	notifications,
	onToggleNotifications,
}: {
	open: boolean;
	onClose: () => void;
	theme: ThemeChoice;
	onTheme: (theme: ThemeChoice) => void;
	models: ModelInfo[];
	provider: string;
	onProvider: (provider: string) => void;
	project: ProjectState | null;
	config: ConfigInfo | null;
	onRefreshProviders: () => Promise<void>;
	onChangeDir: (path: string) => Promise<void>;
	onUseSkill: (name: string) => void;
	notifications: boolean;
	onToggleNotifications: () => void;
}) {
	const [section, setSection] = useState<Section>("appearance");
	const [mobileDetail, setMobileDetail] = useState(false);
	const [dirDraft, setDirDraft] = useState(project?.working_dir ?? "");
	const [changingDir, setChangingDir] = useState(false);
	const [dirError, setDirError] = useState<string | null>(null);
	const [dirNotice, setDirNotice] = useState<string | null>(null);
	const [skills, setSkills] = useState<SkillInfo[] | null>(null);
	const [skillsError, setSkillsError] = useState<string | null>(null);
	const [mcp, setMcp] = useState<McpStatusInfo | null>(null);
	const [mcpError, setMcpError] = useState<string | null>(null);

	useEffect(() => {
		setDirDraft(project?.working_dir ?? "");
	}, [project?.working_dir]);

	useEffect(() => {
		if (section !== "mcp" || mcp !== null) return;
		let cancelled = false;
		void getMcpStatus()
			.then((status) => {
				if (!cancelled) setMcp(status);
			})
			.catch((cause) => {
				if (!cancelled) setMcpError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [section, mcp]);

	useEffect(() => {
		if (section !== "skills" || skills !== null) return;
		let cancelled = false;
		void getSkills()
			.then((list) => {
				if (!cancelled) setSkills(list);
			})
			.catch((cause) => {
				if (!cancelled) setSkillsError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [section, skills]);

	if (!open) return null;

	async function submitDir(event: React.FormEvent) {
		event.preventDefault();
		if (!dirDraft.trim() || changingDir) return;
		setChangingDir(true);
		setDirError(null);
		setDirNotice(null);
		try {
			await onChangeDir(dirDraft.trim());
			setDirNotice(t("工作目录已切换；新会话会使用该目录。"));
		} catch (cause) {
			setDirError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setChangingDir(false);
		}
	}

	return (
		<div className="fixed inset-0 z-50 flex bg-background">
			<aside className="hidden w-[264px] shrink-0 flex-col border-r border-border bg-sidebar p-3 md:flex">
				<div className="flex h-11 items-center px-2">
					<span className="text-[15px] font-medium tracking-[-0.01em]">{t("设置")}</span>
				</div>
				<nav className="mt-2 space-y-0.5">
					{SECTIONS.map((item) => (
						<button
							key={item.id}
							type="button"
							onClick={() => setSection(item.id)}
							className={cn(
								"flex h-11 w-full items-center gap-3 rounded-xl px-2.5 text-left text-[14px] transition-colors",
								section === item.id
									? "bg-sidebar-accent font-medium text-foreground"
									: "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
							)}
						>
							{item.icon}
							{item.label}
						</button>
					))}
				</nav>
				<div className="flex-1" />
				<button
					type="button"
					onClick={onClose}
					className="flex h-10 items-center gap-2 rounded-xl px-2.5 text-[13.5px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
				>
					<ArrowLeft className="size-4" />
					{t("返回")}
				</button>
			</aside>

			<section className="flex min-w-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
				<header className="flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center px-1.5 pt-[env(safe-area-inset-top)] md:hidden">
					<button
						type="button"
						aria-label={mobileDetail ? t("返回") : t("关闭设置")}
						onClick={() => {
							if (mobileDetail) setMobileDetail(false);
							else onClose();
						}}
						className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-overlay-hover hover:text-foreground"
					>
						{mobileDetail ? (
							<ArrowLeft className="size-5" strokeWidth={1.75} />
						) : (
							<X className="size-5" strokeWidth={1.75} />
						)}
					</button>
					<span className="min-w-0 flex-1 truncate px-2 text-center text-[15px] font-medium text-foreground">
						{mobileDetail ? SECTIONS.find((item) => item.id === section)?.label : t("设置")}
					</span>
					<span className="size-10 shrink-0" />
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{/* Mobile settings index */}
					<div className={cn("px-2 pb-8 pt-2 md:hidden", mobileDetail && "hidden")}>
						<p className="px-3 pb-1 pt-3 text-[12px] text-muted-foreground/70">{t("常规")}</p>
						{SECTIONS.filter((item) => item.id !== "about").map((item) => (
							<button
								key={item.id}
								type="button"
								onClick={() => {
									setSection(item.id);
									setMobileDetail(true);
								}}
								className="flex h-14 w-full items-center gap-3.5 rounded-xl px-3 text-left text-[15px] text-foreground transition-colors hover:bg-overlay-hover-light"
							>
								<span className="text-muted-foreground">{item.icon}</span>
								<span className="min-w-0 flex-1 truncate">{item.label}</span>
								<ChevronRight className="size-4 shrink-0 text-muted-foreground/50" strokeWidth={1.75} />
							</button>
						))}
						<p className="px-3 pb-1 pt-5 text-[12px] text-muted-foreground/70">{t("关于")}</p>
						{SECTIONS.filter((item) => item.id === "about").map((item) => (
							<button
								key={item.id}
								type="button"
								onClick={() => {
									setSection(item.id);
									setMobileDetail(true);
								}}
								className="flex h-14 w-full items-center gap-3.5 rounded-xl px-3 text-left text-[15px] text-foreground transition-colors hover:bg-overlay-hover-light"
							>
								<span className="text-muted-foreground">{item.icon}</span>
								<span className="min-w-0 flex-1 truncate">{item.label}</span>
								<ChevronRight className="size-4 shrink-0 text-muted-foreground/50" strokeWidth={1.75} />
							</button>
						))}
					</div>

					<div className={cn("mx-auto w-full max-w-[680px] px-4 py-5 md:px-8 md:py-8", !mobileDetail && "max-md:hidden")}>
						{section === "appearance" ? (
							<div>
								<h1 className="text-[24px] font-medium tracking-[-0.02em]">{t('外观')}</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									{t("选择界面主题。跟随系统会响应操作系统的浅色/深色设置。")}
								</p>
								<div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
									<ThemeCard
										active={theme === "system"}
										label={t("跟随系统")}
										icon={<Monitor className="size-4" />}
										onClick={() => onTheme("system")}
									/>
									<ThemeCard
										active={theme === "light"}
										label={t("浅色")}
										icon={<Sun className="size-4" />}
										onClick={() => onTheme("light")}
									/>
									<ThemeCard
										active={theme === "dark"}
										label={t("深色")}
										icon={<Moon className="size-4" />}
										onClick={() => onTheme("dark")}
									/>
								</div>


								<div className="mt-2 flex items-center justify-between gap-4 border-b border-border-soft py-4">
									<div>
										<h2 className="text-[13px] font-medium">{t("语言")}</h2>
										<p className="mt-0.5 text-[11.5px] text-muted-foreground">
											{t("切换界面语言，页面会刷新。")}
										</p>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										{(["zh", "en"] as const).map((value) => (
											<button
												key={value}
												type="button"
												onClick={() => {
													setLocale(value);
													window.location.reload();
												}}
												className={cn(
													"h-8 rounded-full border px-3 text-[12px] transition-colors",
													getLocale() === value
														? "border-foreground bg-foreground text-background"
														: "border-border text-muted-foreground hover:bg-overlay-hover hover:text-foreground",
												)}
											>
												{value === "zh" ? "中文" : "English"}
											</button>
										))}
									</div>
								</div>

								<div className="mt-2 flex items-center justify-between gap-4 border-b border-border-soft py-4">
									<div>
										<h2 className="text-[13px] font-medium">{t('完成通知')}</h2>
										<p className="mt-0.5 text-[11.5px] text-muted-foreground">
											{t("页面在后台时，回合完成会发送浏览器通知。")}
										</p>
									</div>
									<button
										type="button"
										onClick={onToggleNotifications}
										className={cn(
											"h-8 shrink-0 rounded-full border px-3 text-[12px] transition-colors",
											notifications
												? "border-brand bg-brand-soft/50 text-brand"
												: "border-border text-muted-foreground hover:bg-overlay-hover hover:text-foreground",
										)}
									>
										{notifications ? t("已开启") : t("开启")}
									</button>
								</div>
							</div>
						) : null}

						{section === "models" ? (
							<ProviderSettings
								config={config}
								models={models}
								provider={provider}
								onProvider={onProvider}
								onRefresh={onRefreshProviders}
							/>
						) : null}

						{section === "skills" ? (
							<div>
								<h1 className="text-[24px] font-medium tracking-[-0.02em]">{t('技能')}</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									{t("选择一个技能会把它插入到输入框，发送后由 agent 执行。")}
								</p>
								<div className="mt-4 space-y-1.5">
									{skillsError ? (
										<p className="text-[11.5px] text-destructive">{skillsError}</p>
									) : skills === null ? (
										<p className="text-[12px] text-muted-foreground">{t('加载中…')}</p>
									) : skills.length === 0 ? (
										<div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
											<p className="text-[12.5px] text-muted-foreground">{t('还没有可用技能')}</p>
											<p className="mt-1 text-[11px] text-muted-foreground/70">
												{t("把技能放到工作区的 skill 目录后刷新。")}
											</p>
										</div>
									) : (
										skills.map((skill) => (
											<button
												key={skill.name}
												type="button"
												onClick={() => onUseSkill(skill.name)}
												className="flex w-full items-start gap-3 rounded-xl border border-border px-3 py-2.5 text-left transition-colors hover:bg-overlay-hover"
											>
												<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
													<Sparkles className="size-3.5" strokeWidth={1.75} />
												</span>
												<span className="min-w-0 flex-1">
													<span className="block truncate font-mono text-[12px] text-foreground">
														/{skill.name}
													</span>
													{skill.description ? (
														<span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
															{skill.description}
														</span>
													) : null}
												</span>
											</button>
										))
									)}
								</div>
							</div>
						) : null}

						{section === "mcp" ? (
							<div>
								<h1 className="text-[24px] font-medium tracking-[-0.02em]">MCP</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									{t("当前工作区配置的 MCP 服务器。工具仍由 agent 在会话中调用。")}
								</p>
								{mcpError ? (
									<p className="mt-4 text-[11.5px] text-destructive">{mcpError}</p>
								) : mcp === null ? (
									<p className="mt-4 text-[12px] text-muted-foreground">{t('加载中…')}</p>
								) : (
									<>
										{mcp.trusted === false ? (
											<p className="mt-4 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11.5px] text-warning">
												{t("当前项目尚未信任 MCP，服务器可能被隐藏。")}
											</p>
										) : null}
										<div className="mt-3 space-y-1.5">
											{mcp.servers.length === 0 ? (
												<div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
													<p className="text-[12.5px] text-muted-foreground">{t('还没有 MCP 服务器')}</p>
													<p className="mt-1 text-[11px] text-muted-foreground/70">
														{t("在配置文件中添加 MCP server 后刷新。")}
													</p>
												</div>
											) : (
												mcp.servers.map((server) => (
													<div
														key={server.name}
														className="flex items-center gap-3 rounded-xl border border-border px-3 py-2.5"
													>
														<span
															className={cn(
																"size-2 shrink-0 rounded-full",
																server.status === "connected" || server.status === "ready"
																	? "bg-success"
																	: server.status === "error"
																		? "bg-destructive"
																		: "bg-muted-foreground/50",
															)}
														/>
														<span className="min-w-0 flex-1">
															<span className="block truncate font-mono text-[12px] text-foreground">
																{server.name}
															</span>
															<span className="block text-[10.5px] text-muted-foreground">
																{server.status}
																{server.tool_count != null ? ` · ${server.tool_count} tools` : ""}
															</span>
															{server.error ? (
																<span className="mt-0.5 block text-[10.5px] text-destructive">
																	{server.error}
																</span>
															) : null}
														</span>
													</div>
												))
											)}
										</div>
									</>
								)}
							</div>
						) : null}

						{section === "workspace" ? (
							<div>
								<h1 className="text-[24px] font-medium tracking-[-0.02em]">{t('工作区')}</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									{t("当前会话的工作目录。切换后新会话会使用新的目录。")}
								</p>
								<form onSubmit={submitDir} className="mt-4 rounded-2xl bg-muted p-3">
									<label className="block">
										<span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
											{t("当前目录")}
										</span>
										<input
											value={dirDraft}
											onChange={(event) => setDirDraft(event.target.value)}
											placeholder="/path/to/project"
											spellCheck={false}
											className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2.5 font-mono text-[12px] text-foreground outline-none focus:border-foreground/30"
										/>
									</label>
									<div className="mt-2 flex items-center justify-end gap-2">
										{dirNotice ? (
											<span className="mr-auto text-[11px] text-success">{dirNotice}</span>
										) : null}
										{dirError ? (
											<span className="mr-auto text-[11px] text-destructive">{dirError}</span>
										) : null}
										<button
											type="submit"
											disabled={changingDir || !dirDraft.trim()}
											className="h-8 rounded-lg bg-foreground px-3 text-[12px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-40"
										>
											{changingDir ? t("切换中…") : t("切换目录")}
										</button>
									</div>
								</form>
							</div>
						) : null}

						{section === "about" ? (
							<div>
								<h1 className="text-[24px] font-medium tracking-[-0.02em]">{t('关于')}</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									{t("NanoPi 的浏览器界面，使用 Next.js 重写，视觉参考 Memoh。")}
								</p>
								<div className="mt-4 space-y-2 rounded-2xl bg-muted p-3 text-[12px]">
									<Row label={t("前端")} value="Next.js static export" />
									<Row label={t("设计")} value="Memoh-inspired clean-room" />
									<Row label={t("后端")} value="nanopi webui" />
								</div>
							</div>
						) : null}
					</div>
				</div>
			</section>
		</div>
	);
}

function ThemeCard({
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
			className={cn(
				"flex h-16 flex-col items-start justify-center gap-1 rounded-2xl px-3 text-left transition-colors",
				active
					? "bg-overlay-hover-strong text-foreground ring-1 ring-border-menu"
					: "bg-overlay-hover-light text-muted-foreground hover:bg-overlay-hover hover:text-foreground",
			)}
		>
			<span className="flex items-center gap-2 text-[12.5px] font-medium">
				{icon}
				{label}
			</span>
			<span className="text-[10.5px] opacity-70">{active ? t("当前选择") : t("点击切换")}</span>
		</button>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-4">
			<span className="text-muted-foreground">{label}</span>
			<span className="text-right text-foreground">{value}</span>
		</div>
	);
}
