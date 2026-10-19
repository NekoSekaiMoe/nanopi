"use client";

import { Brain, Check, ChevronDown, ChevronRight, Cpu } from "lucide-react";
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

function effortLabel(level: string | null): string {
	if (!level) return t("默认");
	return EFFORT_LABELS[level] ?? level;
}

/**
 * Model picker for the composer.
 *
 * Memoh's composer-model-menu.vue hangs thinking effort off the SAME menu as a
 * second submenu row, instead of a second control or a second list inside the
 * first. Two things the flat 3-column grid under the model list got wrong:
 * reaching a level meant scrolling past every model row (and the model list
 * had to stay short so both fit, which capped the catalog on screen), and the
 * active level was invisible until the menu was opened.
 *
 * So: the menu's first row is the model list, the second row is `思考强度` with
 * the CURRENT level on its right edge and a chevron, and opening that row
 * swaps the panel to the level list. The pill itself carries `模型 · 强度` the
 * way Memoh's modelTriggerLabel does, so the state reads at rest.
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
	const [effortOpen, setEffortOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const current = models.find((model) => model.provider === provider) ?? models[0];
	const levels = current?.effort_applicable ? current.effort_levels : [];
	const activeEffort = effort ?? current?.reasoning_effort ?? null;
	const modelLabel = current?.model ?? t("选择模型");
	// Same rule as Memoh's reasoningActive: only a real level (not "off") earns
	// a slot on the pill, so a model with thinking disabled reads as bare.
	const effortActive = Boolean(activeEffort) && activeEffort !== "off";
	const triggerLabel = effortActive ? `${modelLabel} · ${effortLabel(activeEffort)}` : modelLabel;

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [open]);

	// Closing the menu resets the submenu, so reopening always lands on the
	// model list rather than a stale level list.
	useEffect(() => {
		if (!open) setEffortOpen(false);
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
					compact ? "h-8 max-w-[200px]" : "h-9 max-w-[260px]",
				)}
			>
				<span className="inline-flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 truncate">{triggerLabel}</span>
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
					{effortOpen ? (
						<>
							<button
								type="button"
								onClick={() => setEffortOpen(false)}
								className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-label text-foreground transition-colors hover:bg-overlay-hover"
							>
								<ChevronDown className="size-3.5 shrink-0 rotate-90 text-muted-foreground" strokeWidth={1.75} />
								<span className="min-w-0 flex-1 truncate">{t("思考强度")}</span>
							</button>
							<div className="max-h-64 overflow-y-auto">
								{levels.map((level) => (
									<button
										key={level}
										type="button"
										onClick={() => {
											onEffort?.(level);
											setEffortOpen(false);
											setOpen(false);
										}}
										className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-label text-foreground transition-colors hover:bg-overlay-hover"
									>
										<span className="grid size-4 shrink-0 place-items-center">
											{level === activeEffort ? <Check className="size-3.5 text-brand" /> : null}
										</span>
										<span className="min-w-0 flex-1 truncate">{effortLabel(level)}</span>
									</button>
								))}
							</div>
						</>
					) : (
						<>
							<p className="px-2 pb-1 pt-1 text-caption uppercase tracking-[0.06em] text-muted-foreground">
								{t("模型")}
							</p>
							<div className="max-h-64 overflow-y-auto">
								{models.map((model) => (
									<ModelRow
										key={model.provider}
										model={model}
										active={model.provider === provider}
										onPick={() => onChange(model.provider)}
									/>
								))}
							</div>
							{levels.length > 0 && onEffort ? (
								<button
									type="button"
									onClick={() => setEffortOpen(true)}
									className={cn(
										"mt-1 flex w-full items-center gap-2 rounded-lg border-t border-border-soft px-2 py-2",
										"text-left text-label text-foreground transition-colors hover:bg-overlay-hover",
									)}
								>
									<Brain className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
									<span className="min-w-0 flex-1 truncate">{t("思考强度")}</span>
									<span className="shrink-0 truncate text-caption text-muted-foreground">
										{effortLabel(activeEffort)}
									</span>
									<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
								</button>
							) : null}
						</>
					)}
				</div>
			) : null}
		</div>
	);
}

/**
 * One model row. A model whose provider resolves no credential (a models.json
 * entry with no key, say) stays visible but cannot be picked: the CLI drops
 * such models from `--list-models`, so selecting one here would only fail at
 * send time.
 */
function ModelRow({
	model,
	active,
	onPick,
}: {
	model: ModelInfo;
	active: boolean;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={!model.available}
			title={model.available ? undefined : t("未配置凭证，补上 API Key 后可用")}
			onClick={onPick}
			className={cn(
				"flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors",
				!model.available && "opacity-45",
				"hover:bg-overlay-hover",
			)}
		>
			<span className="mt-0.5 grid size-4 shrink-0 place-items-center">
				{active ? <Check className="size-3.5 text-brand" /> : null}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-label text-foreground">{model.model}</span>
				<span className="block truncate text-caption text-muted-foreground">
					{model.provider} · {model.provider_type}
					{model.available ? "" : ` · ${t("未配置凭证")}`}
				</span>
			</span>
		</button>
	);
}
