"use client";

import {
	ChevronLeft,
	ChevronRight,
	CircleUser,
	Contrast,
	CreditCard,
	Gauge,
	Info,
	Keyboard,
	LayoutGrid,
	Monitor,
	Moon,
	Package,
	Send,
	Sparkles,
	Sun,
	Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	getMcpStatus,
	getSkills,
	type ApprovalMode,
	type ConfigInfo,
	type McpStatusInfo,
	type ModelInfo,
	type ProjectState,
	type SkillInfo,
} from "@/lib/api";
import { ProviderSettings } from "@/components/provider-settings";
import { cn } from "@/lib/utils";
import { getLocale, setLocale, t } from "@/lib/i18n";

export type ThemeChoice = "system" | "light" | "dark";

export type SettingSection =
	| "bot"
	| "providers"
	| "computer"
	| "marketplace"
	| "general"
	| "usage"
	| "billing"
	| "account"
	| "appearance"
	| "shortcuts"
	| "about";

interface SettingItem {
	id: SettingSection;
	label: string;
	icon: React.ReactNode;
}

const GROUP_1: SettingItem[] = [
	{ id: "bot", label: t("Bot"), icon: <Send className="size-5" strokeWidth={1.75} /> },
	{ id: "providers", label: t("服务商"), icon: <Package className="size-5" strokeWidth={1.75} /> },
	{ id: "computer", label: t("电脑"), icon: <Monitor className="size-5" strokeWidth={1.75} /> },
	{ id: "marketplace", label: t("应用市场"), icon: <LayoutGrid className="size-5" strokeWidth={1.75} /> },
];

const GROUP_2: SettingItem[] = [
	{ id: "general", label: t("常规"), icon: <Users className="size-5" strokeWidth={1.75} /> },
	{ id: "usage", label: t("用量"), icon: <Gauge className="size-5" strokeWidth={1.75} /> },
	{ id: "billing", label: t("账单"), icon: <CreditCard className="size-5" strokeWidth={1.75} /> },
];

const GROUP_3: SettingItem[] = [
	{ id: "account", label: t("账户"), icon: <CircleUser className="size-5" strokeWidth={1.75} /> },
	{ id: "appearance", label: t("外观"), icon: <Contrast className="size-5" strokeWidth={1.75} /> },
	{ id: "shortcuts", label: t("快捷键"), icon: <Keyboard className="size-5" strokeWidth={1.75} /> },
	{ id: "about", label: t("关于"), icon: <Info className="size-5" strokeWidth={1.75} /> },
];

const ALL_ITEMS = [...GROUP_1, ...GROUP_2, ...GROUP_3];

export function SettingsOverlay({
	open,
	onClose,
	theme,
	onTheme,
	models,
	provider,
	onProvider,
	project,
	approvalMode,
	onApprovalMode,
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
	approvalMode: ApprovalMode;
	onApprovalMode: (mode: ApprovalMode) => void;
	config: ConfigInfo | null;
	onRefreshProviders: () => Promise<void>;
	onChangeDir: (path: string) => Promise<void>;
	onUseSkill: (name: string) => void;
	notifications: boolean;
	onToggleNotifications: () => void;
}) {
	const [activeSection, setActiveSection] = useState<SettingSection | null>(null);
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
		if (activeSection !== "marketplace" || mcp !== null) return;
		let cancelled = false;
		void getMcpStatus()
			.then((status) => {
				if (!cancelled) setMcp(status);
			})
			.catch((cause) => {
				if (!cancelled) setMcpError(cause instanceof Error ? cause.message : String(cause));
			});
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
	}, [activeSection, mcp]);

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

	const currentItem = ALL_ITEMS.find((it) => it.id === activeSection);

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-[#050506] text-foreground">
			{/* Top Bar matching Screenshot 6 */}
			<header className="flex h-14 shrink-0 items-center px-3 border-b border-white/[0.05] pt-[env(safe-area-inset-top)]">
				<button
					type="button"
					aria-label={activeSection ? t("返回") : t("关闭设置")}
					onClick={() => {
						if (activeSection) setActiveSection(null);
						else onClose();
					}}
					className="grid size-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
				>
					<ChevronLeft className="size-6" strokeWidth={1.75} />
				</button>
				<h1 className="min-w-0 flex-1 text-center text-[16px] font-medium text-foreground pr-10">
					{activeSection ? currentItem?.label : t("设置")}
				</h1>
			</header>

			{/* Content Area */}
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(16px,env(safe-area-inset-bottom))]">
				<div className="mx-auto max-w-[640px]">
					{/* Index View matching Screenshot 6 */}
					{!activeSection ? (
						<div className="space-y-6 pt-1">
							{/* Group 1: Bot, 服务商, 电脑, 应用市场 */}
							<div className="space-y-1">
								{GROUP_1.map((item) => (
									<button
										key={item.id}
										type="button"
										onClick={() => setActiveSection(item.id)}
										className="flex h-14 w-full items-center gap-4 rounded-xl px-3 text-left transition-colors hover:bg-white/[0.05]"
									>
										<span className="text-muted-foreground/90">{item.icon}</span>
										<span className="text-[15.5px] font-normal text-foreground">{item.label}</span>
									</button>
								))}
							</div>

							{/* Group 2: 团队 -> 常规, 用量, 账单 */}
							<div>
								<p className="px-3 pb-2 text-[13px] text-muted-foreground/60">{t("团队")}</p>
								<div className="space-y-1">
									{GROUP_2.map((item) => (
										<button
											key={item.id}
											type="button"
											onClick={() => setActiveSection(item.id)}
											className="flex h-14 w-full items-center gap-4 rounded-xl px-3 text-left transition-colors hover:bg-white/[0.05]"
										>
											<span className="text-muted-foreground/90">{item.icon}</span>
											<span className="text-[15.5px] font-normal text-foreground">{item.label}</span>
										</button>
									))}
								</div>
							</div>

							{/* Group 3: 个人 -> 账户, 外观, 快捷键, 关于 */}
							<div>
								<p className="px-3 pb-2 text-[13px] text-muted-foreground/60">{t("个人")}</p>
								<div className="space-y-1">
									{GROUP_3.map((item) => (
										<button
											key={item.id}
											type="button"
											onClick={() => setActiveSection(item.id)}
											className="flex h-14 w-full items-center gap-4 rounded-xl px-3 text-left transition-colors hover:bg-white/[0.05]"
										>
											<span className="text-muted-foreground/90">{item.icon}</span>
											<span className="text-[15.5px] font-normal text-foreground">{item.label}</span>
										</button>
									))}
								</div>
							</div>
						</div>
					) : (
						/* Detail Views for each section */
						<div className="pt-2">
							{activeSection === "bot" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("Bot 设置")}</h2>
										<p className="mt-1 text-[13px] text-muted-foreground">
											{t("配置智能助手的执行模式与权限。")}
										</p>
									</div>

									<div className="rounded-2xl border border-white/[0.06] bg-[#141416] p-4 space-y-4">
										<div>
											<label className="text-[13px] font-medium text-foreground">{t("运行模式")}</label>
											<p className="text-[12px] text-muted-foreground mt-0.5">
												{t("标准模式允许所有工具执行；计划模式为只读分析；最小模式仅允许基本命令。")}
											</p>
											<div className="mt-3 flex gap-2">
												{(
													[
														["standard", t("标准")],
														["plan", t("计划")],
														["minimal", t("最小")],
													] as const
												).map(([val, lab]) => (
													<button
														key={val}
														type="button"
														onClick={() => onApprovalMode(val)}
														className={cn(
															"h-9 rounded-xl px-4 text-[13px] font-medium transition-colors",
															approvalMode === val
																? "bg-white text-black"
																: "bg-white/[0.06] text-muted-foreground hover:text-foreground",
														)}
													>
														{lab}
													</button>
												))}
											</div>
										</div>
									</div>
								</div>
							) : null}

							{activeSection === "providers" ? (
								<ProviderSettings
									config={config}
									models={models}
									provider={provider}
									onProvider={onProvider}
									onRefresh={onRefreshProviders}
								/>
							) : null}

							{activeSection === "computer" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("电脑 / 工作区")}</h2>
										<p className="mt-1 text-[13px] text-muted-foreground">
											{t("当前会话的工作目录。切换后新会话会使用该目录。")}
										</p>
									</div>

									<form onSubmit={submitDir} className="rounded-2xl border border-white/[0.06] bg-[#141416] p-4">
										<label className="block text-[12px] text-muted-foreground">{t("当前工作目录")}</label>
										<input
											value={dirDraft}
											onChange={(e) => setDirDraft(e.target.value)}
											spellCheck={false}
											className="mt-2 h-10 w-full rounded-xl border border-white/[0.1] bg-black/40 px-3 font-mono text-[13px] text-foreground outline-none focus:border-white/30"
										/>
										<div className="mt-3 flex items-center justify-between">
											{dirNotice ? <span className="text-[12px] text-green-400">{dirNotice}</span> : null}
											{dirError ? <span className="text-[12px] text-destructive">{dirError}</span> : null}
											<div className="flex-1" />
											<button
												type="submit"
												disabled={changingDir || !dirDraft.trim()}
												className="h-9 rounded-xl bg-white px-4 text-[13px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
											>
												{changingDir ? t("切换中…") : t("切换目录")}
											</button>
										</div>
									</form>
								</div>
							) : null}

							{activeSection === "marketplace" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("应用市场 (技能 & MCP)")}</h2>
										<p className="mt-1 text-[13px] text-muted-foreground">
											{t("查看可用的 Skills 和 MCP 扩展。")}
										</p>
									</div>

									<div className="space-y-3">
										<h3 className="text-[14px] font-medium text-muted-foreground">{t("技能")}</h3>
										{skillsError ? (
											<p className="text-[12px] text-destructive">{skillsError}</p>
										) : skills?.length ? (
											<div className="space-y-2">
												{skills.map((skill) => (
													<button
														key={skill.name}
														type="button"
														onClick={() => {
															onUseSkill(skill.name);
															onClose();
														}}
														className="flex w-full items-start gap-3 rounded-2xl border border-white/[0.06] bg-[#141416] p-3 text-left transition-colors hover:bg-white/[0.04]"
													>
														<Sparkles className="size-4 shrink-0 text-amber-400 mt-0.5" />
														<div>
															<div className="font-mono text-[13px] text-foreground">/{skill.name}</div>
															<div className="text-[12px] text-muted-foreground mt-0.5">
																{skill.description}
															</div>
														</div>
													</button>
												))}
											</div>
										) : (
											<p className="text-[12px] text-muted-foreground/60">{t("暂无技能")}</p>
										)}
									</div>
								</div>
							) : null}

							{activeSection === "general" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("常规设置")}</h2>
									</div>

									<div className="rounded-2xl border border-white/[0.06] bg-[#141416] p-4 divide-y divide-white/[0.06]">
										<div className="flex items-center justify-between pb-4">
											<div>
												<div className="text-[14px] font-medium text-foreground">{t("语言")}</div>
												<div className="text-[12px] text-muted-foreground">{t("切换界面语言。")}</div>
											</div>
											<div className="flex gap-1.5">
												{(["zh", "en"] as const).map((lang) => (
													<button
														key={lang}
														type="button"
														onClick={() => {
															setLocale(lang);
															window.location.reload();
														}}
														className={cn(
															"h-8 rounded-lg px-3 text-[12.5px] transition-colors",
															getLocale() === lang
																? "bg-white text-black font-medium"
																: "bg-white/[0.06] text-muted-foreground hover:text-foreground",
														)}
													>
														{lang === "zh" ? "中文" : "English"}
													</button>
												))}
											</div>
										</div>

										<div className="flex items-center justify-between pt-4">
											<div>
												<div className="text-[14px] font-medium text-foreground">{t("后台通知")}</div>
												<div className="text-[12px] text-muted-foreground">
													{t("页面在后台时，回合完成发送系统通知。")}
												</div>
											</div>
											<button
												type="button"
												onClick={onToggleNotifications}
												className={cn(
													"h-8 rounded-lg px-3 text-[12.5px] font-medium transition-colors",
													notifications
														? "bg-brand text-white"
														: "bg-white/[0.06] text-muted-foreground hover:text-foreground",
												)}
											>
												{notifications ? t("已开启") : t("开启")}
											</button>
										</div>
									</div>
								</div>
							) : null}

							{activeSection === "usage" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("用量与统计")}</h2>
										<p className="mt-1 text-[13px] text-muted-foreground">
											{t("实时会话与模型调用监控。")}
										</p>
									</div>
									<div className="rounded-2xl border border-white/[0.06] bg-[#141416] p-4 text-[13px] space-y-3">
										<div className="flex justify-between">
											<span className="text-muted-foreground">{t("当前上下文占用")}</span>
											<span className="font-medium text-foreground">2%</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">{t("活跃模型")}</span>
											<span className="font-medium text-foreground">{provider || "Default"}</span>
										</div>
									</div>
								</div>
							) : null}

							{activeSection === "billing" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("账单与套餐")}</h2>
										<p className="mt-1 text-[13px] text-muted-foreground">
											{t("本地运行版无需订阅计费。")}
										</p>
									</div>
									<div className="rounded-2xl border border-white/[0.06] bg-[#141416] p-4 text-[13.5px]">
										{t("NanoPi 处于本地或自建模式，不收取任何平台服务费用。")}
									</div>
								</div>
							) : null}

							{activeSection === "account" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("账户信息")}</h2>
									</div>
									<div className="rounded-2xl border border-white/[0.06] bg-[#141416] p-4 text-[13.5px] space-y-2">
										<div className="flex justify-between">
											<span className="text-muted-foreground">{t("用户")}</span>
											<span className="font-medium text-foreground">Ayayoku Togetsu</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">{t("模式")}</span>
											<span className="font-medium text-foreground">Local Daemon</span>
										</div>
									</div>
								</div>
							) : null}

							{activeSection === "appearance" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("外观设置")}</h2>
										<p className="mt-1 text-[13px] text-muted-foreground">
											{t("选择界面颜色主题。")}
										</p>
									</div>
									<div className="grid grid-cols-3 gap-2">
										{(
											[
												["system", t("跟随系统"), <Monitor key="sys" className="size-4" />],
												["light", t("浅色"), <Sun key="light" className="size-4" />],
												["dark", t("深色"), <Moon key="dark" className="size-4" />],
											] as const
										).map(([themeMode, label, icon]) => (
											<button
												key={themeMode}
												type="button"
												onClick={() => onTheme(themeMode)}
												className={cn(
													"flex h-16 flex-col items-center justify-center gap-1.5 rounded-2xl border transition-colors",
													theme === themeMode
														? "border-white/[0.3] bg-white/[0.08] text-foreground font-medium"
														: "border-white/[0.06] bg-[#141416] text-muted-foreground hover:text-foreground",
												)}
											>
												{icon}
												<span className="text-[12.5px]">{label}</span>
											</button>
										))}
									</div>
								</div>
							) : null}

							{activeSection === "shortcuts" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("快捷键")}</h2>
									</div>
									<div className="rounded-2xl border border-white/[0.06] bg-[#141416] p-4 text-[13px] space-y-3">
										<div className="flex justify-between">
											<span className="text-muted-foreground">Tab</span>
											<span className="text-foreground">{t("接受 AI 联想补全")}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Enter</span>
											<span className="text-foreground">{t("发送消息")}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Shift + Enter</span>
											<span className="text-foreground">{t("换行")}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Escape</span>
											<span className="text-foreground">{t("关闭弹窗 / 忽略补全")}</span>
										</div>
									</div>
								</div>
							) : null}

							{activeSection === "about" ? (
								<div className="space-y-6">
									<div>
										<h2 className="text-[18px] font-medium text-foreground">{t("关于 NanoPi")}</h2>
									</div>
									<div className="rounded-2xl border border-white/[0.06] bg-[#141416] p-4 text-[13px] space-y-2">
										<div className="flex justify-between">
											<span className="text-muted-foreground">{t("版本")}</span>
											<span className="text-foreground">0.12.3</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">{t("架构")}</span>
											<span className="text-foreground">Next.js App Router (Memoh Clean-Room)</span>
										</div>
									</div>
								</div>
							) : null}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
