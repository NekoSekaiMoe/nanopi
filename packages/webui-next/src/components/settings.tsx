"use client";

import { ArrowLeft, Check, ChevronRight, Cpu, Info, Monitor, Moon, Palette, Sun, X } from "lucide-react";
import { useState } from "react";
import type { ApprovalMode, ModelInfo, ProjectState } from "@/lib/api";
import { cn } from "@/lib/utils";

type Section = "appearance" | "models" | "workspace" | "about";
export type ThemeChoice = "system" | "light" | "dark";

const SECTIONS: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
	{ id: "appearance", label: "外观", icon: <Palette className="size-4" strokeWidth={1.75} /> },
	{ id: "models", label: "模型", icon: <Cpu className="size-4" strokeWidth={1.75} /> },
	{ id: "workspace", label: "工作区", icon: <Monitor className="size-4" strokeWidth={1.75} /> },
	{ id: "about", label: "关于", icon: <Info className="size-4" strokeWidth={1.75} /> },
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
	approvalMode,
	onApprovalMode,
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
}) {
	const [section, setSection] = useState<Section>("appearance");
	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex bg-background">
			<aside className="hidden w-[248px] shrink-0 flex-col border-r border-border bg-sidebar p-2 md:flex">
				<div className="flex h-11 items-center gap-2 px-2">
					<span className="text-[13.5px] font-semibold tracking-[-0.01em]">设置</span>
				</div>
				<nav className="mt-1 space-y-0.5">
					{SECTIONS.map((item) => (
						<button
							key={item.id}
							type="button"
							onClick={() => setSection(item.id)}
							className={cn(
								"flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[12.5px] transition-colors",
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
					className="flex h-9 items-center gap-2 rounded-lg px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
				>
					<ArrowLeft className="size-4" />
					返回
				</button>
			</aside>

			<section className="flex min-w-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
				<header className="flex h-[calc(2.75rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border px-2 pt-[env(safe-area-inset-top)] md:hidden">
					<button
						type="button"
						aria-label="关闭设置"
						onClick={onClose}
						className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<X className="size-[18px]" />
					</button>
					<span className="text-[13px] font-medium">设置</span>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-[680px] px-4 py-6 md:px-8">
						{/* Mobile section switcher */}
						<div className="mb-5 flex gap-1 overflow-x-auto pb-1 md:hidden">
							{SECTIONS.map((item) => (
								<button
									key={item.id}
									type="button"
									onClick={() => setSection(item.id)}
									className={cn(
										"shrink-0 rounded-full border px-3 py-1.5 text-[12px]",
										section === item.id
											? "border-foreground bg-foreground text-background"
											: "border-border text-muted-foreground",
									)}
								>
									{item.label}
								</button>
							))}
						</div>

						{section === "appearance" ? (
							<div>
								<h1 className="text-[18px] font-semibold tracking-[-0.02em]">外观</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									选择界面主题。跟随系统会响应操作系统的浅色/深色设置。
								</p>
								<div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
									<ThemeCard
										active={theme === "system"}
										label="跟随系统"
										icon={<Monitor className="size-4" />}
										onClick={() => onTheme("system")}
									/>
									<ThemeCard
										active={theme === "light"}
										label="浅色"
										icon={<Sun className="size-4" />}
										onClick={() => onTheme("light")}
									/>
									<ThemeCard
										active={theme === "dark"}
										label="深色"
										icon={<Moon className="size-4" />}
										onClick={() => onTheme("dark")}
									/>
								</div>

								<h2 className="mt-8 text-[13.5px] font-medium">运行模式</h2>
								<p className="mt-1 text-[12px] text-muted-foreground">
									标准模式允许全部工具；计划模式只读；最小模式只开放 shell 工具。
								</p>
								<div className="mt-3 flex flex-wrap gap-1.5">
									{(
										[
											["standard", "标准"],
											["plan", "计划"],
											["minimal", "最小"],
										] as const
									).map(([value, label]) => (
										<button
											key={value}
											type="button"
											onClick={() => onApprovalMode(value)}
											className={cn(
												"h-8 rounded-full border px-3 text-[12px] transition-colors",
												approvalMode === value
													? "border-foreground bg-foreground text-background"
													: "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
											)}
										>
											{label}
										</button>
									))}
								</div>
							</div>
						) : null}

						{section === "models" ? (
							<div>
								<h1 className="text-[18px] font-semibold tracking-[-0.02em]">模型</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									选择当前会话使用的 provider。添加或编辑 provider 请使用 CLI。
								</p>
								<div className="mt-4 overflow-hidden rounded-xl border border-border">
									{models.length === 0 ? (
										<p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
											还没有可用模型
										</p>
									) : (
										models.map((model, index) => (
											<button
												key={model.provider}
												type="button"
												onClick={() => onProvider(model.provider)}
												className={cn(
													"flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent",
													index > 0 && "border-t border-border-soft",
												)}
											>
												<span className="grid size-4 shrink-0 place-items-center">
													{model.provider === provider ? (
														<Check className="size-3.5 text-brand" />
													) : null}
												</span>
												<span className="min-w-0 flex-1">
													<span className="block truncate text-[12.5px] text-foreground">
														{model.model}
													</span>
													<span className="block truncate text-[10.5px] text-muted-foreground">
														{model.provider} · {model.provider_type}
													</span>
												</span>
												{model.is_default ? (
													<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
														默认
													</span>
												) : null}
												<ChevronRight className="size-3.5 text-muted-foreground" />
											</button>
										))
									)}
								</div>
							</div>
						) : null}

						{section === "workspace" ? (
							<div>
								<h1 className="text-[18px] font-semibold tracking-[-0.02em]">工作区</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									会话的工作目录。切换目录请使用 CLI 或在侧栏进入其他项目。
								</p>
								<div className="mt-4 rounded-xl border border-border p-3">
									<div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
										当前目录
									</div>
									<div className="mt-1 break-all font-mono text-[12px] text-foreground">
										{project?.working_dir || "未连接"}
									</div>
								</div>
							</div>
						) : null}

						{section === "about" ? (
							<div>
								<h1 className="text-[18px] font-semibold tracking-[-0.02em]">关于</h1>
								<p className="mt-1 text-[12.5px] text-muted-foreground">
									NanoPi 的浏览器界面，使用 Next.js 重写，视觉参考 Memoh。
								</p>
								<div className="mt-4 space-y-2 rounded-xl border border-border p-3 text-[12px]">
									<Row label="前端" value="Next.js static export" />
									<Row label="设计" value="Memoh-inspired clean-room" />
									<Row label="后端" value="nanopi webui" />
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
				"flex h-16 flex-col items-start justify-center gap-1 rounded-xl border px-3 text-left transition-colors",
				active
					? "border-brand bg-brand-soft/40 text-foreground"
					: "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
			)}
		>
			<span className="flex items-center gap-2 text-[12.5px] font-medium">
				{icon}
				{label}
			</span>
			<span className="text-[10.5px] opacity-70">{active ? "当前选择" : "点击切换"}</span>
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
