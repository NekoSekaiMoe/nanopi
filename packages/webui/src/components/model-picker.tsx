"use client";

import { Check, ChevronDown, Cpu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const EFFORT_LABELS: Record<string, string> = {
	off: t("关闭"),
	minimal: t("极低"),
	low: t("低"),
	medium: t("中"),
	high: t("高"),
	xhigh: t("极高"),
	max: t("最高"),
};

export function effortLabel(level: string | null): string {
	if (!level) return t("默认");
	return EFFORT_LABELS[level] ?? level;
}

/**
 * Model picker for the composer. The reasoning-effort rows live in the same
 * list as the models: preferring one dropdown over a second control keeps the
 * composer short and matches how the settings editor exposes the value.
 */
export function ModelPicker({
	models,
	provider,
	onChange,
	effort,
	onEffort,
	onConfigure,
	compact,
}: {
	models: ModelInfo[];
	provider: string;
	onChange: (provider: string) => void;
	effort?: string | null;
	onEffort?: (level: string | null) => void;
	onConfigure: () => void;
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const current = models.find((model) => model.provider === provider) ?? models[0];
	const levels = current?.effort_applicable ? current.effort_levels : [];
	const activeEffort = effort ?? current?.reasoning_effort ?? null;

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
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

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className={cn(
					"inline-flex h-9 max-w-[240px] items-center gap-1.5 rounded-full px-2 text-[14px] text-foreground/85 transition-colors hover:bg-white/[0.06] hover:text-foreground",
					open && "bg-white/[0.06] text-foreground",
					compact && "max-w-[180px]",
				)}
			>
				{compact ? null : <Cpu className="size-3.5 shrink-0" strokeWidth={1.75} />}
				<span className="min-w-0 truncate">{current?.model ?? t("选择模型")}</span>
				{levels.length > 0 ? (
					<span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 text-[10.5px] text-muted-foreground">
						{effortLabel(activeEffort)}
					</span>
				) : null}
				<ChevronDown
					className={cn("size-3.5 shrink-0 opacity-70 transition-transform", open && "rotate-180")}
					strokeWidth={1.75}
				/>
			</button>
			{open ? (
				<div className="absolute bottom-full left-0 z-50 mb-1.5 w-[300px] overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg max-md:bottom-0 max-md:left-0 max-md:mb-10">
					<p className="px-2 pb-1 pt-1 text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/70">
						{t("模型")}
					</p>
					<div className="max-h-64 overflow-y-auto">
						{models.map((model) => (
							<button
								key={model.provider}
								type="button"
								onClick={() => {
									onChange(model.provider);
								}}
								className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
							>
								<span className="mt-0.5 grid size-4 shrink-0 place-items-center">
									{model.provider === provider ? <Check className="size-3.5 text-brand" /> : null}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[12.5px] text-foreground">{model.model}</span>
									<span className="block truncate text-[10.5px] text-muted-foreground">
										{model.provider} · {model.provider_type}
									</span>
								</span>
							</button>
						))}
					</div>
					{levels.length > 0 && onEffort ? (
						<>
							<p className="border-t border-border-soft px-2 pb-1 pt-2 text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground/70">
								{t("思考强度")}
							</p>
							<div className="grid grid-cols-3 gap-1 p-1">
								{levels.map((level) => (
									<button
										key={level}
										type="button"
										onClick={() => {
											onEffort(level);
										}}
										className={cn(
											"h-8 rounded-lg text-[12px] transition-colors",
											level === activeEffort
												? "bg-foreground font-medium text-background"
												: "text-muted-foreground hover:bg-accent hover:text-foreground",
										)}
									>
										{effortLabel(level)}
									</button>
								))}
							</div>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}
