"use client";

import { Check, ChevronDown, ChevronRight, Cpu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
	none: t("无"),
	low: t("低"),
	medium: t("中"),
	high: t("高"),
};

export function ModelPicker({
	models,
	provider,
	onChange,
	onConfigure,
	reasoningEffort = "medium",
	onReasoningEffort,
	compact,
}: {
	models: ModelInfo[];
	provider: string;
	onChange: (provider: string) => void;
	onConfigure: () => void;
	reasoningEffort?: ReasoningEffort;
	onReasoningEffort?: (effort: ReasoningEffort) => void;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [subView, setSubView] = useState<"menu" | "models" | "effort">("menu");
	const ref = useRef<HTMLDivElement>(null);
	const current = models.find((model) => model.provider === provider) ?? models[0];

	useEffect(() => {
		if (!open) {
			setSubView("menu");
			return;
		}
		const onPointerDown = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) {
				setOpen(false);
				setSubView("menu");
			}
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [open]);

	if (models.length === 0) {
		return (
			<button
				type="button"
				onClick={onConfigure}
				className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<Cpu className="size-3.5" />
				{t("配置模型")}
			</button>
		);
	}

	const modelLabel = current?.model ?? t("选择模型");
	const effortLabel = EFFORT_LABELS[reasoningEffort] ?? t("中");
	const displayPill = `${modelLabel} · ${effortLabel}`;

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => {
					setOpen((value) => !value);
					setSubView("menu");
				}}
				className={cn(
					"inline-flex h-9 max-w-[260px] items-center gap-1 rounded-full px-2 text-[13.5px] text-foreground/85 transition-colors hover:bg-white/[0.06] hover:text-foreground",
					open && "bg-white/[0.06] text-foreground",
					compact && "max-w-[200px]",
				)}
			>
				<span className="min-w-0 truncate">{displayPill}</span>
				<ChevronDown
					className={cn("size-3.5 shrink-0 opacity-70 transition-transform", open && "rotate-180")}
					strokeWidth={1.75}
				/>
			</button>

			{open ? (
				<div className="absolute bottom-full left-0 z-50 mb-2 w-[280px] overflow-hidden rounded-2xl border border-white/[0.1] bg-[#1a1a1d] p-1.5 shadow-2xl">
					{subView === "menu" ? (
						<div className="space-y-0.5">
							{/* Row 1: Model */}
							<button
								type="button"
								onClick={() => setSubView("models")}
								className="flex h-11 w-full items-center justify-between rounded-xl px-3 text-[14px] text-foreground transition-colors hover:bg-white/[0.06]"
							>
								<span className="text-muted-foreground">{t("模型")}</span>
								<div className="flex items-center gap-1.5 text-foreground/90">
									<span className="max-w-[150px] truncate text-[13.5px]">{modelLabel}</span>
									<ChevronRight className="size-4 opacity-50" />
								</div>
							</button>

							{/* Row 2: Reasoning effort */}
							<button
								type="button"
								onClick={() => setSubView("effort")}
								className="flex h-11 w-full items-center justify-between rounded-xl px-3 text-[14px] text-foreground transition-colors hover:bg-white/[0.06]"
							>
								<span className="text-muted-foreground">{t("推理")}</span>
								<div className="flex items-center gap-1.5 text-foreground/90">
									<span className="text-[13.5px]">{effortLabel}</span>
									<ChevronRight className="size-4 opacity-50" />
								</div>
							</button>
						</div>
					) : subView === "models" ? (
						<div>
							<div className="flex h-9 items-center justify-between px-2 pb-1 text-[12px] text-muted-foreground border-b border-white/[0.06]">
								<button
									type="button"
									onClick={() => setSubView("menu")}
									className="text-foreground hover:underline"
								>
									← {t("返回")}
								</button>
								<span>{t("选择模型")}</span>
							</div>
							<div className="max-h-64 overflow-y-auto pt-1">
								{models.map((model) => (
									<button
										key={model.provider}
										type="button"
										onClick={() => {
											onChange(model.provider);
											setOpen(false);
											setSubView("menu");
										}}
										className="flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/[0.06]"
									>
										<span className="mt-0.5 grid size-4 shrink-0 place-items-center">
											{model.provider === provider ? <Check className="size-3.5 text-brand" /> : null}
										</span>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-[13px] text-foreground">{model.model}</span>
											<span className="block truncate text-[10.5px] text-muted-foreground">
												{model.provider} · {model.provider_type}
											</span>
										</span>
									</button>
								))}
							</div>
						</div>
					) : (
						<div>
							<div className="flex h-9 items-center justify-between px-2 pb-1 text-[12px] text-muted-foreground border-b border-white/[0.06]">
								<button
									type="button"
									onClick={() => setSubView("menu")}
									className="text-foreground hover:underline"
								>
									← {t("返回")}
								</button>
								<span>{t("推理强度")}</span>
							</div>
							<div className="space-y-0.5 pt-1">
								{(["none", "low", "medium", "high"] as const).map((effort) => (
									<button
										key={effort}
										type="button"
										onClick={() => {
											onReasoningEffort?.(effort);
											setOpen(false);
											setSubView("menu");
										}}
										className="flex h-10 w-full items-center justify-between rounded-xl px-3 text-[13.5px] text-foreground transition-colors hover:bg-white/[0.06]"
									>
										<span>{EFFORT_LABELS[effort]}</span>
										{reasoningEffort === effort ? <Check className="size-4 text-brand" /> : null}
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}
