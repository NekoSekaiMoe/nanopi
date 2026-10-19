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
	onOpen,
	compact,
}: {
	models: ModelInfo[];
	provider: string;
	onChange: (provider: string) => void;
	effort?: string | null;
	onEffort?: (level: string | null) => void;
	onConfigure: () => void;
	/** Called when the list opens, so the caller can reload the catalog first. */
	onOpen?: () => void;
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
				className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-2.5 text-label text-muted-foreground transition-colors hover:bg-overlay-hover hover:text-foreground"
			>
				<Cpu className="size-3.5" />
				{t("配置模型")}
			</button>
		);
	}

	return (
		<div ref={ref} className="relative min-w-0">
			<button
				type="button"
				onClick={() => {
					if (!open) onOpen?.();
					setOpen((value) => !value);
				}}
				data-open={open}
				className={cn(
					"press composer-pill inline-flex min-w-0 shrink items-center gap-1.5 rounded-full px-2 text-label",
					"text-control-label hover:text-control-label-hover max-md:h-11",
					compact ? "h-8 max-w-[180px]" : "h-9 max-w-[240px]",
				)}
			>
				<span className="inline-flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 truncate">{current?.model ?? t("选择模型")}</span>
					<ChevronDown className="size-3.5 shrink-0" strokeWidth={1.5} />
				</span>
			</button>
			{open ? (
				<div
					className={cn(
						"absolute bottom-full right-0 z-50 mb-1.5 w-72 max-w-[calc(100vw-2rem)] overflow-hidden",
						"rounded-xl border border-border-menu bg-popover p-1 shadow-lg",
					)}
				>
					<p className="px-2 pb-1 pt-1 text-caption uppercase tracking-[0.06em] text-muted-foreground">
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
								className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-overlay-hover"
							>
								<span className="mt-0.5 grid size-4 shrink-0 place-items-center">
									{model.provider === provider ? <Check className="size-3.5 text-brand" /> : null}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-label text-foreground">{model.model}</span>
									<span className="block truncate text-caption text-muted-foreground">
										{model.provider} · {model.provider_type}
									</span>
								</span>
							</button>
						))}
					</div>
					{levels.length > 0 && onEffort ? (
						<>
							<p className="border-t border-border-soft px-2 pb-1 pt-2 text-caption uppercase tracking-[0.06em] text-muted-foreground">
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
											"h-8 rounded-lg text-label transition-colors",
											level === activeEffort
												? "bg-btn-primary text-background"
												: "text-muted-foreground hover:bg-overlay-hover hover:text-foreground",
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
